import { describe, expect, it } from 'vitest'
import { RESULTS_CSV, SCENARIOS, checkJob, checkStack, historyMismatch, type Observation } from './smoke'
import type { Job } from './standin/jobs'

const scenario = (name: string) => SCENARIOS.find((s) => s.name === name)!

const T0 = Date.parse('2026-11-05T12:00:00Z')
function job(name: string, statuses: string[], extra: Partial<Job> = {}): Job {
    return {
        jobId: '00000000-0000-4000-8000-000000000000',
        studyId: '00000000-0000-4000-8000-000000000001',
        title: `smoke: ${name}`,
        image: '127.0.0.1:5055/enclave-dev/sample-offline:latest',
        researcherId: 'local-dev-researcher',
        requestedAt: new Date(T0).toISOString(),
        statuses: statuses.map((entry, i) => {
            const [status, ...message] = entry.split(': ')
            return {
                status: status!,
                ...(message.length ? { message: message.join(': ') } : {}),
                at: new Date(T0 + i * 1000).toISOString(),
            }
        }),
        artifacts: {},
        ...extra,
    }
}

const progress = ['JOB-RUNNING', ...[1, 2, 3, 4, 5].map((n) => `JOB-RUNNING: step ${n} of 5`)]
const created = ['INITIATED', 'CODE-APPROVED', 'JOB-READY']

const observe = (j: Job, o: Partial<Observation> = {}): Observation => ({
    job: j,
    maxContainers: 1,
    containersLeft: 0,
    ...o,
})
const failures = (checks: Array<{ ok: boolean; name: string }>) => checks.filter((c) => !c.ok).map((c) => c.name)

describe('smoke checks', () => {
    it('pass a successful offline run', () => {
        const j = job('offline', [...created, 'JOB-PROVISIONING', ...progress, 'RUN-COMPLETE'])
        expect(
            failures(checkJob(scenario('offline'), observe(j, { result: { 'results.csv': RESULTS_CSV } }), 60)),
        ).toEqual([])
    })

    it('pass a failing run with its two JOB-ERRORED and the log', () => {
        const j = job('offline-fail', [
            ...created,
            'JOB-PROVISIONING',
            ...progress,
            'JOB-ERRORED: Container 3a9680d4 exited with message: ',
            'JOB-ERRORED',
        ])
        const o = observe(j, { log: { 'logs.txt': 'SAMPLE_FAIL=1: exiting non-zero' } })
        expect(failures(checkJob(scenario('offline-fail'), o, 60))).toEqual([])
    })

    it('pass a missing image that never launches', () => {
        const j = job('missing-image', [...created, 'JOB-ERRORED: Docker API Call Error: Failed to deploy'])
        expect(failures(checkJob(scenario('missing-image'), observe(j, { maxContainers: 0 }), 60))).toEqual([])
    })

    it('catch a failure reported twice by setup-app', () => {
        const j = job('offline-fail', [
            ...created,
            'JOB-PROVISIONING',
            ...progress,
            'JOB-ERRORED: Container 3a9680d4 exited with message: ',
            'JOB-ERRORED',
            'JOB-ERRORED: Container 3a9680d4 exited with message: ',
        ])
        expect(historyMismatch(j, scenario('offline-fail').history)).toMatch(
            /^at #13 expected nothing more, got JOB-ERRORED: Container/,
        )
    })

    it('catch a double launch, a slow job, a leftover container and a wrong result', () => {
        const j = job('offline', [...created, 'JOB-PROVISIONING', 'JOB-PROVISIONING', ...progress, 'RUN-COMPLETE'])
        const o = observe(j, { maxContainers: 2, containersLeft: 1, result: { 'results.csv': 'nope' } })
        expect(failures(checkJob(scenario('offline'), o, 5))).toEqual([
            'status history',
            'launched once',
            'finished within 5s',
            'research container removed',
            'result is the expected results.csv',
        ])
    })

    it('catch a job that never finishes', () => {
        const j = job('offline', [...created, 'JOB-PROVISIONING', 'JOB-RUNNING'])
        const checks = checkJob(scenario('offline'), observe(j), 60)
        expect(checks.find((c) => c.name === 'finished within 60s')).toMatchObject({
            ok: false,
            detail: 'no terminal status',
        })
    })

    it('catch auth failures and a restarted setup-app', () => {
        const before = 'running=true started=2026-11-05T12:00:00Z restarts=0'
        expect(failures(checkStack([], before, before))).toEqual([])
        const after = 'running=true started=2026-11-05T12:01:00Z restarts=1'
        const checks = checkStack([{ at: '', path: '/api/studies/ready', reason: 'invalid signature' }], before, after)
        expect(failures(checks)).toEqual(['no enclave auth failures', 'setup-app kept running'])
    })
})
