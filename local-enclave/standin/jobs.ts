import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** What the real management app accepts on PUT /api/job/:id. */
export const ENCLAVE_STATUSES = [
    'JOB-PROVISIONING',
    'JOB-RUNNING',
    'JOB-ERRORED',
    'FILES-REJECTED',
    'FILES-APPROVED',
    'RUN-COMPLETE',
] as const

/** A job with any of these is never offered to the enclave again. */
export const TERMINAL_STATUSES = ['JOB-ERRORED', 'RUN-COMPLETE', 'FILES-APPROVED', 'FILES-REJECTED']

export type StatusChange = { status: string; message?: string; at: string }
export type ArtifactKind = 'result' | 'log'
export type ArtifactFile = { name: string; bytes: number }
export type Artifact = { receivedAt: string; files: ArtifactFile[]; error?: string }

export type BuildStatus = 'pending' | 'building' | 'done' | 'failed'
/** A "run your own code" job: the host builds `image` from `baseImage` plus `code` before it is offered. */
export type Build = { baseImage: string; code: string; status: BuildStatus; log?: string; updatedAt: string }

export type Job = {
    jobId: string
    studyId: string
    title: string
    image: string
    researcherId: string
    requestedAt: string
    statuses: StatusChange[]
    artifacts: Partial<Record<ArtifactKind, Artifact>>
    build?: Build
}

export const CODE_IMAGE_PREFIX = 'localhost/enclave-dev/code'

export type JobListener = (job: Job) => void

/**
 * Jobs the stand-in knows about. Persisted as one JSON file so a restart (or a `tsx watch` reload)
 * keeps the history; artifacts live next to it under jobs/<id>/.
 */
export class JobStore {
    private byId = new Map<string, Job>()
    private listeners = new Set<JobListener>()

    constructor(
        readonly file: string,
        readonly jobsDir: string,
    ) {
        if (existsSync(file)) {
            const parsed = JSON.parse(readFileSync(file, 'utf8')) as { jobs: Job[] }
            for (const job of parsed.jobs) this.byId.set(job.jobId, job)
        }
    }

    /** Newest first. */
    all(): Job[] {
        return [...this.byId.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    }

    get(jobId: string): Job | undefined {
        return this.byId.get(jobId)
    }

    create(input: { image?: string; title?: string; code?: string; baseImage?: string }): Job {
        const now = new Date().toISOString()
        const jobId = randomUUID()
        const code = input.code?.trim()
        if (!code && !input.image) throw new Error('image or code is required')
        // Pasted code goes through JOB-PACKAGING, like the containerizer step in the real app, until
        // the host has built its image; a ready-made image is JOB-READY at once.
        const initial = code
            ? ['INITIATED', 'CODE-APPROVED', 'JOB-PACKAGING']
            : ['INITIATED', 'CODE-APPROVED', 'JOB-READY']
        const job: Job = {
            jobId,
            studyId: randomUUID(),
            title: input.title?.trim() || `Job ${jobId.slice(0, 8)}`,
            image: code ? `${CODE_IMAGE_PREFIX}-${jobId.slice(0, 8)}:latest` : input.image!,
            researcherId: 'local-dev-researcher',
            requestedAt: now,
            statuses: initial.map((status) => ({ status, at: now })),
            artifacts: {},
            ...(code
                ? {
                      build: {
                          baseImage: input.baseImage?.trim() || 'python:3.12-slim',
                          code,
                          status: 'pending' as const,
                          updatedAt: now,
                      },
                  }
                : {}),
        }
        this.byId.set(jobId, job)
        this.persist()
        this.emit(job)
        return job
    }

    latest(job: Job): string | undefined {
        return job.statuses.at(-1)?.status
    }

    hasAny(job: Job, statuses: readonly string[]): boolean {
        return job.statuses.some((change) => statuses.includes(change.status))
    }

    /** The jobs GET /api/studies/ready offers: ready or running, and never terminal. */
    ready(): Job[] {
        return this.all().filter(
            (job) => this.hasAny(job, ['JOB-READY', 'JOB-RUNNING']) && !this.hasAny(job, TERMINAL_STATUSES),
        )
    }

    addStatus(jobId: string, status: string, message?: string): Job {
        const job = this.require(jobId)
        job.statuses.push({ status, ...(message ? { message } : {}), at: new Date().toISOString() })
        this.persist()
        this.emit(job)
        return job
    }

    setArtifact(jobId: string, kind: ArtifactKind, artifact: Artifact): Job {
        const job = this.require(jobId)
        job.artifacts[kind] = artifact
        this.persist()
        this.emit(job)
        return job
    }

    /** Code jobs the host builder has not picked up yet, oldest first. */
    pendingBuilds(): Job[] {
        return this.all()
            .filter((job) => job.build?.status === 'pending')
            .reverse()
    }

    setBuildStatus(jobId: string, status: BuildStatus, log?: string): Job {
        const job = this.require(jobId)
        if (!job.build) throw new Error(`job ${jobId} has no code to build`)
        job.build = { ...job.build, status, ...(log !== undefined ? { log } : {}), updatedAt: new Date().toISOString() }
        this.persist()
        if (status === 'done') return this.addStatus(jobId, 'JOB-READY')
        if (status === 'failed') return this.addStatus(jobId, 'JOB-ERRORED', `image build failed; see the build log`)
        this.emit(job)
        return job
    }

    /** Directory for a job's zips and decrypted files; created on first use. */
    jobDir(jobId: string): string {
        const dir = path.join(this.jobsDir, jobId)
        mkdirSync(dir, { recursive: true })
        return dir
    }

    subscribe(listener: JobListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    private require(jobId: string): Job {
        const job = this.byId.get(jobId)
        if (!job) throw new Error(`unknown job ${jobId}`)
        return job
    }

    private persist(): void {
        mkdirSync(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        writeFileSync(tmp, JSON.stringify({ jobs: [...this.byId.values()] }, null, 2))
        renameSync(tmp, this.file)
    }

    private emit(job: Job): void {
        for (const listener of this.listeners) listener(job)
    }
}
