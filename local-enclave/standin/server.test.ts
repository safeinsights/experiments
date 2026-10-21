import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import { fingerprintSpki } from './decrypt'
import { JobStore } from './jobs'
import { createStandin } from './server'
import { encryptLikeToa, keyPair, spkiOf } from './testing'

const enclave = keyPair()
const reviewer = keyPair()
const token = (iss = 'openstax', key = enclave.privateKey) =>
    jwt.sign({ iss }, key, { algorithm: 'RS256', expiresIn: 60 })
const bearer = (t = token()) => ({ Authorization: `Bearer ${t}` })

let server: Server
let base: string
let dir: string

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'standin-'))
    const store = new JobStore(path.join(dir, 'jobs.json'), path.join(dir, 'jobs'))
    server = createStandin({
        memberId: 'openstax',
        enclavePublicKeyPem: enclave.publicKey,
        reviewerPrivateKeyPem: reviewer.privateKey,
        verifyJwt: true,
        store,
        samples: () => [
            { name: 'offline', image: 'localhost/enclave-dev/sample-offline:latest', description: 'offline' },
        ],
        log: () => {},
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
})

const createJob = async (body: Record<string, string>) => {
    const res = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    expect(res.status).toBe(201)
    return (await res.json()) as { jobId: string }
}

describe('enclave authentication', () => {
    it('rejects requests without a bearer token, with the wrong issuer, or signed by another key', async () => {
        const ready = `${base}/api/studies/ready`
        expect((await fetch(ready)).status).toBe(401)
        expect((await (await fetch(ready)).json()) as object).toMatchObject({
            error: expect.stringContaining('Token error'),
        })
        expect((await fetch(ready, { headers: bearer(token('someone-else')) })).status).toBe(401)
        expect((await fetch(ready, { headers: bearer(token('openstax', keyPair().privateKey)) })).status).toBe(401)
        expect((await fetch(ready, { headers: bearer() })).status).toBe(200)
    })

    it('lists auth failures on the page', async () => {
        const html = await (await fetch(`${base}/`)).text()
        expect(html).toContain('Enclave auth failures')
    })
})

describe('the enclave job flow', () => {
    it('runs a job from ready through status updates to decrypted results', async () => {
        const { jobId } = await createJob({ sample: 'offline', title: 'Flow test' })

        const ready = (await (await fetch(`${base}/api/studies/ready`, { headers: bearer() })).json()) as {
            jobs: Array<Record<string, string>>
        }
        expect(ready.jobs.find((j) => j.jobId === jobId)).toMatchObject({
            title: 'Flow test',
            containerLocation: 'localhost/enclave-dev/sample-offline:latest',
            status: 'JOB-READY',
        })

        for (const status of ['JOB-PROVISIONING', 'JOB-RUNNING']) {
            const res = await fetch(`${base}/api/job/${jobId}`, {
                method: 'PUT',
                headers: bearer(),
                body: JSON.stringify({ status }),
            })
            expect(await res.text()).toBe('ok')
            expect(await (await fetch(`${base}/api/job/${jobId}/status`, { headers: bearer() })).json()).toEqual({
                status,
            })
        }

        const progress = await fetch(`${base}/api/job/${jobId}`, {
            method: 'PUT',
            headers: bearer(),
            body: JSON.stringify({ status: 'JOB-RUNNING', message: 'step 2 of 5' }),
        })
        expect(progress.status).toBe(200)
        const timeline = await (await fetch(`${base}/`)).text()
        expect(timeline).toContain('step 2 of 5')
        expect(timeline).toContain('<details class="status">')
        expect(timeline).toContain('<i class="current" title="JOB-RUNNING"></i>')
        expect(timeline).toMatch(/class="spent" title="entered [^"]+" data-from="[^"]+" data-to="[^"]+">[\d.]+s</)
        expect(timeline).toMatch(/class="spent" title="entered [^"]+" data-from="[^"]+">[\d.]+s so far</)

        const keys = (await (await fetch(`${base}/api/job/${jobId}/keys`, { headers: bearer() })).json()) as {
            keys: Array<{ jobId: string; publicKey: { type: string; data: number[] }; fingerprint: string }>
        }
        expect(keys.keys).toHaveLength(1)
        expect(keys.keys[0].publicKey.type).toBe('Buffer')
        expect(keys.keys[0].fingerprint).toBe(fingerprintSpki(spkiOf(reviewer.publicKey)))

        // Encrypt exactly as the trusted-output-app would: for the key the stand-in just handed out.
        const zip = await encryptLikeToa({ 'results.csv': Buffer.from('group,count\nA,42\n') }, [
            Buffer.from(keys.keys[0].publicKey.data),
        ])
        const form = new FormData()
        form.append('result', new File([zip], jobId, { type: 'application/zip' }))
        const upload = await fetch(`${base}/api/job/${jobId}/results`, {
            method: 'POST',
            headers: bearer(),
            body: form,
        })
        expect(await upload.json()).toEqual({ status: 'success' })

        expect(await (await fetch(`${base}/api/job/${jobId}/status`, { headers: bearer() })).json()).toEqual({
            status: 'RUN-COMPLETE',
        })
        const after = (await (await fetch(`${base}/api/studies/ready`, { headers: bearer() })).json()) as {
            jobs: Array<{ jobId: string }>
        }
        expect(after.jobs.some((j) => j.jobId === jobId)).toBe(false)

        const file = await fetch(`${base}/jobs/${jobId}/files/result/results.csv`)
        expect(await file.text()).toBe('group,count\nA,42\n')
        const html = await (await fetch(`${base}/`)).text()
        expect(html).toContain('<td>42</td>')

        const again = await fetch(`${base}/api/job/${jobId}`, {
            method: 'PUT',
            headers: bearer(),
            body: JSON.stringify({ status: 'JOB-RUNNING' }),
        })
        expect(again.status).toBe(422)
    })

    it('records JOB-ERRORED when only a log arrives, and shows a decrypt failure instead of hiding it', async () => {
        const { jobId } = await createJob({ image: 'localhost/anything:latest' })
        const zip = await encryptLikeToa(
            { 'logs.json': Buffer.from(JSON.stringify([{ timestamp: 0, message: 'boom' }])) },
            [spkiOf(keyPair().publicKey)],
        )
        const form = new FormData()
        form.append('log', new File([zip], jobId, { type: 'application/zip' }))
        await fetch(`${base}/api/job/${jobId}/results`, { method: 'POST', headers: bearer(), body: form })

        expect(await (await fetch(`${base}/api/job/${jobId}/status`, { headers: bearer() })).json()).toEqual({
            status: 'JOB-ERRORED',
        })
        const html = await (await fetch(`${base}/`)).text()
        expect(html).toContain('Could not decrypt')
        expect((await fetch(`${base}/jobs/${jobId}/log.zip`)).status).toBe(200)
    })

    it('holds a code job at JOB-PACKAGING until the host builder reports the image, then offers it', async () => {
        const res = await fetch(`${base}/jobs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: 'print(1)\r\n', baseImage: ' python:3.12-slim ', title: 'code job' }),
        })
        expect(res.status).toBe(201)
        const job = (await res.json()) as {
            jobId: string
            image: string
            build: { status: string; baseImage: string; code: string }
        }
        expect(job.image).toMatch(/^localhost\/enclave-dev\/code-[0-9a-f]{8}:latest$/)
        expect(job.build).toMatchObject({ status: 'pending', baseImage: 'python:3.12-slim', code: 'print(1)' })

        const readyUrl = `${base}/api/studies/ready`
        const notYet = (await (await fetch(readyUrl, { headers: bearer() })).json()) as {
            jobs: Array<{ jobId: string }>
        }
        expect(notYet.jobs.some((j) => j.jobId === job.jobId)).toBe(false)

        const pending = (await (await fetch(`${base}/builds/pending`)).json()) as {
            builds: Array<{ jobId: string; image: string; code: string }>
        }
        expect(pending.builds).toEqual([
            expect.objectContaining({ jobId: job.jobId, image: job.image, code: 'print(1)' }),
        ])

        expect((await fetch(`${base}/builds/${job.jobId}/start`, { method: 'POST' })).status).toBe(200)
        expect((await fetch(`${base}/builds/${job.jobId}/start`, { method: 'POST' })).status).toBe(409)
        expect(((await (await fetch(`${base}/builds/pending`)).json()) as { builds: unknown[] }).builds).toEqual([])

        const done = await fetch(`${base}/builds/${job.jobId}/done`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ok: true, log: 'naming to localhost/enclave-dev/code-x:latest done' }),
        })
        expect(done.status).toBe(200)
        expect(await (await fetch(`${base}/api/job/${job.jobId}/status`, { headers: bearer() })).json()).toEqual({
            status: 'JOB-READY',
        })
        const offered = (await (await fetch(readyUrl, { headers: bearer() })).json()) as {
            jobs: Array<{ jobId: string; containerLocation: string }>
        }
        expect(offered.jobs.find((j) => j.jobId === job.jobId)?.containerLocation).toBe(job.image)
    })

    it('turns a failed build into JOB-ERRORED and shows the build log', async () => {
        const res = await fetch(`${base}/jobs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: 'x = 1' }),
        })
        const job = (await res.json()) as { jobId: string }
        await fetch(`${base}/builds/${job.jobId}/start`, { method: 'POST' })
        await fetch(`${base}/builds/${job.jobId}/done`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ok: false, log: 'ERROR: pull access denied for nope/base' }),
        })
        expect(await (await fetch(`${base}/api/job/${job.jobId}/status`, { headers: bearer() })).json()).toEqual({
            status: 'JOB-ERRORED',
        })
        const html = await (await fetch(`${base}/`)).text()
        expect(html).toContain('image build failed')
        expect(html).toContain('pull access denied for nope/base')
        expect(html).toContain('Run your own code')
    })

    it('validates ids, statuses and samples', async () => {
        expect((await fetch(`${base}/api/job/not-a-uuid/status`, { headers: bearer() })).status).toBe(400)
        expect(
            (await fetch(`${base}/api/job/00000000-0000-4000-8000-000000000000/status`, { headers: bearer() })).status,
        ).toBe(404)
        const { jobId } = await createJob({ image: 'localhost/x:1' })
        const bad = await fetch(`${base}/api/job/${jobId}`, {
            method: 'PUT',
            headers: bearer(),
            body: JSON.stringify({ status: 'NOPE' }),
        })
        expect(bad.status).toBe(400)
        const unknownSample = await fetch(`${base}/jobs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"sample":"nope"}',
        })
        expect(unknownSample.status).toBe(400)
    })
})
