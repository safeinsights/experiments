/* eslint-disable no-console */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import { DecryptError, decryptResultsZip, fingerprintSpki, spkiDerFromPrivateKey } from './decrypt'
import { ENCLAVE_STATUSES, JobStore, type ArtifactKind, type Job } from './jobs'
import { buildPreview, renderPage, type AuthFailure, type JobView, type Preview, type Sample } from './page'

export type StandinOptions = {
    memberId: string
    enclavePublicKeyPem: string
    reviewerPrivateKeyPem: string
    /** false: log and record failures but still serve the request (for debugging key problems). */
    verifyJwt: boolean
    store: JobStore
    /** Called per page render so a freshly built sample shows up without a restart. */
    samples: () => Sample[]
    /** Suggestions for the base image of a code job; the first one is the default. */
    baseImages?: string[]
    log?: (line: string) => void
}

const MAX_BODY_BYTES = 200 * 1024 * 1024
const MAX_AUTH_FAILURES = 20
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Params = Record<string, string>
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params) => Promise<void> | void
type Route = { method: string; pattern: RegExp; names: string[]; handler: Handler; auth: boolean }

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message)
    }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
    res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    })
    res.end(body)
}
const json = (res: ServerResponse, status: number, body: unknown) =>
    send(res, status, 'application/json; charset=utf-8', JSON.stringify(body))
const text = (res: ServerResponse, status: number, body: string) => send(res, status, 'text/plain; charset=utf-8', body)

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                reject(new HttpError(413, `body exceeds ${MAX_BODY_BYTES} bytes`))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
    })
}

/** Node's own multipart parser, reached through the fetch Response type. */
async function readFormData(req: IncomingMessage): Promise<FormData> {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.startsWith('multipart/form-data')) throw new HttpError(400, 'expected multipart/form-data')
    const body = await readBody(req)
    // A Buffer may share a pool; hand fetch a plain ArrayBuffer-backed copy.
    const bytes = new Uint8Array(body.length)
    bytes.set(body)
    return new Response(bytes, { headers: { 'content-type': contentType } }).formData()
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const body = await readBody(req)
    const contentType = req.headers['content-type'] ?? ''
    if (contentType.startsWith('application/x-www-form-urlencoded')) {
        return Object.fromEntries(new URLSearchParams(body.toString('utf8')))
    }
    try {
        return JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>
    } catch {
        throw new HttpError(400, 'Request body is not valid JSON')
    }
}

const safeName = (name: string) => path.basename(name).replace(/[^\w.@-]+/g, '_') || 'file'

export function createStandin(opts: StandinOptions): Server {
    const log = opts.log ?? ((line: string) => console.log(line))
    const store = opts.store
    const reviewerSpki = spkiDerFromPrivateKey(opts.reviewerPrivateKeyPem)
    const reviewerFingerprint = fingerprintSpki(reviewerSpki)
    const authFailures: AuthFailure[] = []
    const routes: Route[] = []
    // Positional groups, named by `names`: the repo targets ES2017, which predates named groups.
    const route = (method: string, pattern: RegExp, names: string[], handler: Handler, auth = false) =>
        routes.push({ method, pattern, names, handler, auth })

    const authenticate = (req: IncomingMessage, pathname: string): void => {
        const header = req.headers.authorization ?? ''
        let reason: string | undefined
        if (!header.startsWith('Bearer ')) reason = "'Authorization' header missing or not well formed"
        else {
            try {
                jwt.verify(header.slice('Bearer '.length), opts.enclavePublicKeyPem, {
                    algorithms: ['RS256'],
                    issuer: opts.memberId,
                })
            } catch (err) {
                reason = (err as Error).message
            }
        }
        if (!reason) return
        authFailures.unshift({ at: new Date().toISOString(), path: pathname, reason })
        authFailures.splice(MAX_AUTH_FAILURES)
        if (opts.verifyJwt) throw new HttpError(401, `Token error: ${reason}`)
        log(`[bma] WARNING: unverified request to ${pathname}: ${reason}`)
    }

    const requireJob = (jobId: string): Job => {
        const job = store.get(jobId)
        if (!job) throw new HttpError(404, 'job not found')
        return job
    }

    const artifactDir = (jobId: string, kind: ArtifactKind) => path.join(store.jobDir(jobId), kind)
    const previewsFor = (job: Job, kind: ArtifactKind): Preview[] =>
        (job.artifacts[kind]?.files ?? []).map((file) => {
            const href = `/jobs/${job.jobId}/files/${kind}/${encodeURIComponent(file.name)}`
            const contents = readFileSync(path.join(artifactDir(job.jobId, kind), file.name))
            return buildPreview(file.name, href, contents)
        })

    // --- dev routes (no auth) ---
    route('GET', /^\/healthz$/, [], (_req, res) => text(res, 200, 'ok\n'))
    route('GET', /^\/$/, [], (_req, res) => {
        const jobs: JobView[] = store.all().map((job) => ({
            job,
            previews: { result: previewsFor(job, 'result'), log: previewsFor(job, 'log') },
            zips: Object.fromEntries(
                (['result', 'log'] as const)
                    .filter((kind) => job.artifacts[kind])
                    .map((kind) => [kind, `/jobs/${job.jobId}/${kind}.zip`]),
            ),
        }))
        send(
            res,
            200,
            'text/html; charset=utf-8',
            renderPage({
                memberId: opts.memberId,
                verifyJwt: opts.verifyJwt,
                reviewerFingerprint,
                samples: opts.samples(),
                baseImages: opts.baseImages?.length ? opts.baseImages : ['python:3.12-slim'],
                authFailures,
                jobs,
            }),
        )
    })
    route('GET', /^\/events$/, [], (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
        })
        res.write(`event: snapshot\ndata: ${JSON.stringify({ jobs: store.all() })}\n\n`)
        const unsubscribe = store.subscribe((job) => res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`))
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
        req.on('close', () => {
            unsubscribe()
            clearInterval(ping)
        })
    })
    route('GET', /^\/jobs\.json$/, [], (_req, res) => json(res, 200, { jobs: store.all() }))
    route('POST', /^\/jobs$/, [], async (req, res) => {
        const body = await readJson(req)
        const sampleName = typeof body.sample === 'string' ? body.sample : undefined
        const code = typeof body.code === 'string' && body.code.trim() ? body.code.replace(/\r\n/g, '\n') : undefined
        const baseImage = typeof body.baseImage === 'string' ? body.baseImage.trim() : undefined
        let image = typeof body.image === 'string' ? body.image.trim() : ''
        let title = typeof body.title === 'string' ? body.title : undefined
        if (sampleName) {
            const sample = opts.samples().find((s) => s.name === sampleName)
            if (!sample) throw new HttpError(400, `unknown sample "${sampleName}"`)
            image = sample.image
            title ??= `${sample.name} sample`
        }
        if (!image && !code) throw new HttpError(400, 'image, sample or code is required')
        const job = code
            ? store.create({ code, baseImage, title: title || 'custom code' })
            : store.create({ image, title })
        log(
            `[bma] job ${job.jobId} created for ${code ? `code on ${job.build!.baseImage} (image ${job.image})` : `image ${image}`}`,
        )
        if ((req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
            res.writeHead(303, { Location: `/#job-${job.jobId}` })
            res.end()
            return
        }
        json(res, 201, job)
    })
    // --- host builder routes: `dev-enclave.ts up` polls these to build images for code jobs ---
    route('GET', /^\/builds\/pending$/, [], (_req, res) =>
        json(res, 200, {
            builds: store.pendingBuilds().map((job) => ({ jobId: job.jobId, image: job.image, ...job.build })),
        }),
    )
    route('POST', /^\/builds\/([^/]+)\/start$/, ['jobId'], (_req, res, params) => {
        const job = requireJob(params.jobId!)
        if (job.build?.status !== 'pending') throw new HttpError(409, `build is ${job.build?.status ?? 'absent'}`)
        json(res, 200, store.setBuildStatus(job.jobId, 'building'))
    })
    route('POST', /^\/builds\/([^/]+)\/done$/, ['jobId'], async (req, res, params) => {
        const job = requireJob(params.jobId!)
        if (job.build?.status !== 'building') throw new HttpError(409, `build is ${job.build?.status ?? 'absent'}`)
        const body = await readJson(req)
        const buildLog = typeof body.log === 'string' ? body.log : ''
        const updated = store.setBuildStatus(job.jobId, body.ok === true ? 'done' : 'failed', buildLog)
        log(`[bma] job ${job.jobId} image build ${body.ok === true ? 'done' : 'FAILED'}`)
        json(res, 200, updated)
    })
    route('GET', /^\/jobs\/([^/]+)\/(result|log)\.zip$/, ['jobId', 'kind'], (_req, res, params) => {
        requireJob(params.jobId!)
        const file = path.join(store.jobDir(params.jobId!), `${params.kind}.zip`)
        if (!existsSync(file)) throw new HttpError(404, 'no such artifact')
        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${params.jobId}-${params.kind}.zip"`,
        })
        res.end(readFileSync(file))
    })
    route('GET', /^\/jobs\/([^/]+)\/files\/(result|log)\/([^/]+)$/, ['jobId', 'kind', 'name'], (req, res, params) => {
        const job = requireJob(params.jobId!)
        const kind = params.kind as ArtifactKind
        const name = decodeURIComponent(params.name!)
        if (!job.artifacts[kind]?.files.some((file) => file.name === name)) throw new HttpError(404, 'no such file')
        const inline = new URL(req.url ?? '/', 'http://localhost').searchParams.has('inline')
        const contents = readFileSync(path.join(artifactDir(job.jobId, kind), name))
        res.writeHead(200, {
            'Content-Type': name.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/octet-stream',
            'Content-Length': contents.length,
            'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
        })
        res.end(contents)
    })

    // --- enclave routes (what setup-app and the trusted-output-app call on the real management app) ---
    route(
        'GET',
        /^\/api\/studies\/ready$/,
        [],
        (_req, res) => {
            const jobs = store.ready().map((job) => ({
                jobId: job.jobId,
                studyId: job.studyId,
                requestedAt: job.requestedAt,
                status: store.latest(job),
                title: job.title,
                dataSources: [],
                outputMimeType: 'text/csv',
                researcherId: job.researcherId,
                containerLocation: job.image,
            }))
            json(res, 200, { jobs })
        },
        true,
    )
    route(
        'PUT',
        /^\/api\/job\/([^/]+)$/,
        ['jobId'],
        async (req, res, params) => {
            const job = requireJob(params.jobId!)
            const body = await readJson(req)
            const status = body.status
            if (typeof status !== 'string' || !(ENCLAVE_STATUSES as readonly string[]).includes(status)) {
                throw new HttpError(400, `invalid status ${JSON.stringify(status)}`)
            }
            if (store.hasAny(job, ['RUN-COMPLETE'])) throw new HttpError(422, 'job is already complete')
            const message = typeof body.message === 'string' ? body.message : undefined
            store.addStatus(job.jobId, status, message)
            log(`[bma] job ${job.jobId} -> ${status}${message ? `: ${message.split('\n')[0]}` : ''}`)
            text(res, 200, 'ok')
        },
        true,
    )
    route(
        'GET',
        /^\/api\/job\/([^/]+)\/status$/,
        ['jobId'],
        (_req, res, params) => {
            const job = requireJob(params.jobId!)
            json(res, 200, { status: store.latest(job) })
        },
        true,
    )
    route(
        'GET',
        /^\/api\/job\/([^/]+)\/keys$/,
        ['jobId'],
        (_req, res, params) => {
            // The real app answers {keys: []} for an unknown job rather than 404.
            const job = store.get(params.jobId!)
            const keys = job ? [{ jobId: job.jobId, publicKey: reviewerSpki, fingerprint: reviewerFingerprint }] : []
            json(res, 200, { keys })
        },
        true,
    )
    route(
        'POST',
        /^\/api\/job\/([^/]+)\/results$/,
        ['jobId'],
        async (req, res, params) => {
            const job = requireJob(params.jobId!)
            if (store.hasAny(job, ['RUN-COMPLETE'])) throw new HttpError(422, 'job is already complete')
            const form = await readFormData(req)
            const result = form.get('result') ?? form.get('file')
            const logs = form.get('log')
            const deliveries: Array<[ArtifactKind, File]> = []
            if (result instanceof File) deliveries.push(['result', result])
            if (logs instanceof File) deliveries.push(['log', logs])
            for (const [kind, file] of deliveries) {
                const zip = new Uint8Array(await file.arrayBuffer())
                writeFileSync(path.join(store.jobDir(job.jobId), `${kind}.zip`), zip)
                const receivedAt = new Date().toISOString()
                try {
                    const files = await decryptResultsZip(zip, opts.reviewerPrivateKeyPem)
                    const dir = artifactDir(job.jobId, kind)
                    mkdirSync(dir, { recursive: true })
                    const names = files.map((f) => {
                        const name = safeName(f.path)
                        writeFileSync(path.join(dir, name), f.contents)
                        return { name, bytes: f.bytes }
                    })
                    store.setArtifact(job.jobId, kind, { receivedAt, files: names })
                    log(`[bma] job ${job.jobId} ${kind}: decrypted ${names.map((n) => n.name).join(', ') || 'nothing'}`)
                } catch (err) {
                    const reason = err instanceof DecryptError ? err.message : `unexpected: ${(err as Error).message}`
                    store.setArtifact(job.jobId, kind, { receivedAt, files: [], error: reason })
                    log(`[bma] job ${job.jobId} ${kind}: decrypt failed: ${reason}`)
                }
            }
            const outcome = logs && !result ? 'JOB-ERRORED' : 'RUN-COMPLETE'
            store.addStatus(job.jobId, outcome)
            log(`[bma] job ${job.jobId} -> ${outcome}`)
            json(res, 200, { status: 'success' })
        },
        true,
    )

    return createServer(async (req, res) => {
        const started = Date.now()
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        try {
            const match = routes.find((r) => r.method === method && r.pattern.test(url.pathname))
            if (!match) throw new HttpError(404, 'Not found')
            const values = url.pathname.match(match.pattern)?.slice(1) ?? []
            const params: Params = Object.fromEntries(match.names.map((name, i) => [name, values[i] ?? '']))
            if ('jobId' in params && !UUID_RE.test(params.jobId!)) throw new HttpError(400, 'jobId is not a UUID')
            if (match.auth) authenticate(req, url.pathname)
            await match.handler(req, res, params)
        } catch (err) {
            const status = err instanceof HttpError ? err.status : 500
            const message = err instanceof Error ? err.message : String(err)
            if (status === 500) log(`[bma] ${method} ${url.pathname}: ${(err as Error).stack ?? message}`)
            if (!res.headersSent) json(res, status, { error: message })
            else res.end()
        } finally {
            if (url.pathname !== '/events')
                log(`[bma] ${res.statusCode} ${method} ${url.pathname} ${Date.now() - started}ms`)
        }
    })
}
