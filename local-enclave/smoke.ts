/* eslint-disable no-console */
/**
 * `dev-enclave.ts smoke`: submit sample jobs to the running stack, watch what setup-app does with
 * them through the stand-in's /jobs.json and `docker ps`, and check the outcome. The checks only
 * look at the stand-in and research containers, never at setup-app's internals, so they hold for
 * any provider and across a refactor of setup-app.
 */
import { IMAGE_PREFIX } from './harness'
import type { Job } from './standin/jobs'
import type { AuthFailure } from './standin/page'

export type Check = { scope: string; name: string; ok: boolean; detail?: string }

/** Everything the checks need about one job, gathered once its history has stopped changing. */
export type Observation = {
    job: Job
    /** Most research containers seen at once for this job while polling. */
    maxContainers: number
    /** Research containers still there at the end. */
    containersLeft: number
    /** Decrypted artifact files by name; absent when the artifact never arrived. */
    result?: Record<string, string>
    log?: Record<string, string>
}

/** An exact status, or a pattern for statuses whose message varies (container ids). */
type Expected = string | RegExp

export type Scenario = {
    name: string
    request: Record<string, string>
    /** Status history from creation on, each entry `STATUS` or `STATUS: message`. */
    history: Expected[]
    /** Research containers the job should get: 1, or 0 when launching fails. */
    launches: 0 | 1
    artifacts: (o: Observation) => Check[]
}

export const RESULTS_CSV = 'group,count\nA,42\nB,17\n'
export const TERMINAL = ['RUN-COMPLETE', 'JOB-ERRORED']

const PROGRESS = ['JOB-RUNNING', ...[1, 2, 3, 4, 5].map((n) => `JOB-RUNNING: step ${n} of 5`)]
const CREATED = ['INITIATED', 'CODE-APPROVED', 'JOB-READY']

export const SCENARIOS: Scenario[] = [
    {
        name: 'offline',
        request: { sample: 'offline', title: 'smoke: offline' },
        history: [...CREATED, 'JOB-PROVISIONING', ...PROGRESS, 'RUN-COMPLETE'],
        launches: 1,
        artifacts: (o) => [
            check(o, 'result is the expected results.csv', sameFiles(o.result, { 'results.csv': RESULTS_CSV })),
            check(o, 'no log delivered', o.log ? `got log files ${Object.keys(o.log).join(', ')}` : undefined),
        ],
    },
    {
        name: 'offline-fail',
        request: { sample: 'offline-fail', title: 'smoke: offline-fail' },
        // setup-app reports the failure (with its message), then uploads the logs; the management app
        // records a second, message-less JOB-ERRORED for that log-only delivery, as the real one does.
        history: [...CREATED, 'JOB-PROVISIONING', ...PROGRESS, /^JOB-ERRORED: Container \S+ exited/, 'JOB-ERRORED'],
        launches: 1,
        artifacts: (o) => [
            check(
                o,
                'no result delivered',
                o.result ? `got result files ${Object.keys(o.result).join(', ')}` : undefined,
            ),
            check(
                o,
                "log holds the container's output",
                !o.log
                    ? 'no log arrived'
                    : Object.values(o.log).some((text) => text.includes('SAMPLE_FAIL=1'))
                      ? undefined
                      : `no SAMPLE_FAIL=1 line in ${Object.keys(o.log).join(', ') || 'an empty log'}`,
            ),
        ],
    },
    {
        name: 'missing-image',
        // Not in the registry, so the pull fails at once and creating the container fails after it.
        request: { image: `${IMAGE_PREFIX}/does-not-exist:smoke`, title: 'smoke: missing-image' },
        history: [...CREATED, /^JOB-ERRORED: .+/],
        launches: 0,
        artifacts: (o) => [
            check(
                o,
                'nothing delivered',
                o.result || o.log
                    ? `got ${[o.result && 'a result', o.log && 'a log'].filter(Boolean).join(' and ')}`
                    : undefined,
            ),
        ],
    },
]

const label = (change: { status: string; message?: string }) =>
    change.message ? `${change.status}: ${change.message.split('\n')[0]}` : change.status

function check(o: Observation | string, name: string, failure: string | undefined): Check {
    const scope = typeof o === 'string' ? o : o.job.title.replace(/^smoke: /, '')
    return { scope, name, ok: failure === undefined, ...(failure ? { detail: failure } : {}) }
}

function sameFiles(actual: Record<string, string> | undefined, expected: Record<string, string>): string | undefined {
    if (!actual) return 'no result arrived'
    const names = Object.keys(actual).sort()
    if (names.join() !== Object.keys(expected).sort().join()) return `got files ${names.join(', ') || 'none'}`
    const wrong = names.filter((name) => actual[name] !== expected[name])
    return wrong.length ? `${wrong.join(', ')} differs: ${JSON.stringify(actual[wrong[0]!])}` : undefined
}

export function historyMismatch(job: Job, expected: Expected[]): string | undefined {
    const actual = job.statuses.map(label)
    const at = expected.findIndex((want, i) =>
        typeof want === 'string' ? actual[i] !== want : !want.test(actual[i] ?? ''),
    )
    if (at === -1 && actual.length === expected.length) return undefined
    const index = at === -1 ? expected.length : at
    const want = expected[index]
    return `at #${index + 1} expected ${want === undefined ? 'nothing more' : String(want)}, got ${actual[index] ?? 'nothing'} (full: ${actual.join(' → ')})`
}

/** Seconds from creation to the first terminal status, or undefined if there is none. */
export function secondsToTerminal(job: Job): number | undefined {
    const terminal = job.statuses.find((change) => TERMINAL.includes(change.status))
    return terminal ? (Date.parse(terminal.at) - Date.parse(job.requestedAt)) / 1000 : undefined
}

export function checkJob(scenario: Scenario, o: Observation, timeoutSeconds: number): Check[] {
    const provisioned = o.job.statuses.filter((change) => change.status === 'JOB-PROVISIONING').length
    const seconds = secondsToTerminal(o.job)
    return [
        check(o, 'status history', historyMismatch(o.job, scenario.history)),
        check(
            o,
            scenario.launches ? 'launched once' : 'never launched',
            provisioned === scenario.launches && o.maxContainers === scenario.launches
                ? undefined
                : `${provisioned} JOB-PROVISIONING, up to ${o.maxContainers} research container(s) at once; expected ${scenario.launches}`,
        ),
        check(
            o,
            `finished within ${timeoutSeconds}s`,
            seconds === undefined
                ? 'no terminal status'
                : seconds > timeoutSeconds
                  ? `took ${seconds.toFixed(1)}s`
                  : undefined,
        ),
        check(o, 'research container removed', o.containersLeft ? `${o.containersLeft} left` : undefined),
        ...scenario.artifacts(o),
    ]
}

export function checkStack(authFailures: AuthFailure[], setupAppBefore?: string, setupAppAfter?: string): Check[] {
    return [
        check(
            'stack',
            'no enclave auth failures',
            authFailures.length
                ? `${authFailures.length}, latest ${authFailures[0]!.path}: ${authFailures[0]!.reason}`
                : undefined,
        ),
        check(
            'stack',
            'setup-app kept running',
            !setupAppAfter?.startsWith('running=true')
                ? `now ${setupAppAfter ?? 'gone'}`
                : setupAppAfter !== setupAppBefore
                  ? `restarted: ${setupAppBefore} → ${setupAppAfter}`
                  : undefined,
        ),
    ]
}

export function report(checks: Check[], log: (line: string) => void = console.log): boolean {
    for (const c of checks) log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.scope}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
    const failed = checks.filter((c) => !c.ok).length
    log(failed ? `${failed} of ${checks.length} checks FAILED` : `all ${checks.length} checks passed`)
    return failed === 0
}

export type SmokeEnv = {
    baseUrl: string
    timeoutSeconds: number
    /** How long a job's history and containers must stay unchanged before it is judged. */
    settleSeconds: number
    containersByJob: () => Map<string, number>
    setupAppState: () => string | undefined
    say: (line: string) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init)
    const text = await res.text()
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}: ${text}`)
    return JSON.parse(text) as T
}

async function fetchArtifact(
    env: SmokeEnv,
    job: Job,
    kind: 'result' | 'log',
): Promise<Record<string, string> | undefined> {
    const artifact = job.artifacts[kind]
    if (!artifact) return undefined
    if (artifact.error) return { [`(could not decrypt: ${artifact.error})`]: '' }
    const files: Record<string, string> = {}
    for (const file of artifact.files) {
        const res = await fetch(`${env.baseUrl}/jobs/${job.jobId}/files/${kind}/${encodeURIComponent(file.name)}`)
        files[file.name] = await res.text()
    }
    return files
}

/** Submit every scenario, wait for them to settle, check them; true when every check passed. */
export async function runSmoke(env: SmokeEnv, scenarios: Scenario[] = SCENARIOS): Promise<boolean> {
    const setupAppBefore = env.setupAppState()
    const ids = new Map<string, Scenario>()
    for (const scenario of scenarios) {
        const job = await getJson<Job>(`${env.baseUrl}/jobs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(scenario.request),
        })
        ids.set(job.jobId, scenario)
        env.say(`submitted ${scenario.name} as job ${job.jobId}`)
    }

    const maxContainers = new Map<string, number>()
    const started = Date.now()
    const hardStop = started + (env.timeoutSeconds + 3 * env.settleSeconds) * 1000
    let fingerprint = ''
    let stableSince = Date.now()
    let dump: { jobs: Job[]; authFailures: AuthFailure[] }
    let counts: Map<string, number>
    let lastProgress = ''
    for (;;) {
        dump = await getJson(`${env.baseUrl}/jobs.json`)
        counts = env.containersByJob()
        for (const id of ids.keys()) maxContainers.set(id, Math.max(maxContainers.get(id) ?? 0, counts.get(id) ?? 0))

        const mine = dump.jobs.filter((job) => ids.has(job.jobId))
        const next = JSON.stringify(
            mine.map((job) => [job.statuses.length, Object.keys(job.artifacts), counts.get(job.jobId) ?? 0]),
        )
        if (next !== fingerprint) {
            fingerprint = next
            stableSince = Date.now()
        }
        const done = mine.filter((job) => job.statuses.some((change) => TERMINAL.includes(change.status)))
        const progress = `${done.length}/${ids.size} jobs finished`
        if (progress !== lastProgress) env.say(progress)
        lastProgress = progress

        const allDone = done.length === ids.size && [...ids.keys()].every((id) => !counts.get(id))
        if (allDone && Date.now() - stableSince >= env.settleSeconds * 1000) break
        if (Date.now() - started > env.timeoutSeconds * 1000 && Date.now() - stableSince >= env.settleSeconds * 1000) {
            env.say('timed out waiting for every job to finish and be cleaned up; checking what there is')
            break
        }
        if (Date.now() > hardStop) {
            env.say('jobs kept changing past the timeout; checking what there is')
            break
        }
        await sleep(1000)
    }

    const checks: Check[] = []
    for (const [id, scenario] of ids) {
        const job = dump.jobs.find((j) => j.jobId === id)
        if (!job) {
            checks.push(check(scenario.name, 'job exists', 'the stand-in no longer knows it'))
            continue
        }
        const observation: Observation = {
            job,
            maxContainers: maxContainers.get(id) ?? 0,
            containersLeft: counts.get(id) ?? 0,
            result: await fetchArtifact(env, job, 'result'),
            log: await fetchArtifact(env, job, 'log'),
        }
        checks.push(...checkJob(scenario, observation, env.timeoutSeconds))
    }
    checks.push(...checkStack(dump.authFailures, setupAppBefore, env.setupAppState()))
    env.say(`checked after ${((Date.now() - started) / 1000).toFixed(0)}s:`)
    return report(checks, env.say)
}
