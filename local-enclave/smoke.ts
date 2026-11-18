/* eslint-disable no-console */
/**
 * `dev-enclave.ts smoke`: submit sample jobs to the running stack, watch what setup-app does with
 * them through the stand-in's /jobs.json and its research workloads (containers in Docker mode, Jobs
 * in Kubernetes mode), and check the outcome. The checks only look at the stand-in and the workloads,
 * never at setup-app's internals, so they hold for any provider and across a refactor of setup-app.
 * Where a provider is known to behave differently today, the scenario says so (`divergences`) and
 * those checks report KNOWN rather than PASS.
 */
import { IMAGE_PREFIX, type Provider } from './harness'
import type { Job } from './standin/jobs'
import type { AuthFailure } from './standin/page'

export type Check = {
    scope: string
    name: string
    ok: boolean
    detail?: string
    /** Set when the check held against a provider's known divergence rather than the common expectation. */
    known?: string
}

/** Everything the checks need about one job, gathered once its history has stopped changing. */
export type Observation = {
    job: Job
    /** Most research workloads (containers or Jobs) seen at once for this job while polling. */
    maxWorkloads: number
    /** Research workloads still there at the end. */
    workloadsLeft: number
    /** Decrypted artifact files by name; absent when the artifact never arrived. */
    result?: Record<string, string>
    log?: Record<string, string>
}

/** An exact status, or a pattern for statuses whose message varies (container ids). */
type Expected = string | RegExp

/** What setup-app should do with a scenario's job. */
type Expectation = {
    /** Status history from creation on, each entry `STATUS` or `STATUS: message`. */
    history: Expected[]
    /** Research workloads the job should get: 1, or 0 when launching fails. */
    launches: 0 | 1
    /** Whether the job reaches a terminal status; true unless a divergence says otherwise. */
    finishes?: boolean
    /** Research workloads expected to remain at the end; 0 unless a divergence says otherwise. */
    workloadsLeft?: number
}

/** How one provider's behaviour differs from the common expectation today, and why. */
export type Divergence = Partial<Expectation> & { why: string }

export type Scenario = Expectation & {
    name: string
    request: Record<string, string>
    divergences?: Partial<Record<Provider, Divergence>>
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
        divergences: {
            kubernetes: {
                why: 'setup-app never reports a pod that cannot pull its image (checkForErroredJobs only looks at terminated containers), so the job stays JOB-PROVISIONING and its pod in ErrImagePull',
                history: [...CREATED, 'JOB-PROVISIONING'],
                launches: 1,
                finishes: false,
                workloadsLeft: 1,
            },
        },
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

/** The scenario's expectation for this provider, with the divergence (if any) applied. */
export function expectationFor(
    scenario: Scenario,
    provider: Provider,
): Required<Expectation> & { divergence?: Divergence } {
    const divergence = scenario.divergences?.[provider]
    return {
        history: divergence?.history ?? scenario.history,
        launches: divergence?.launches ?? scenario.launches,
        finishes: divergence?.finishes ?? scenario.finishes ?? true,
        workloadsLeft: divergence?.workloadsLeft ?? scenario.workloadsLeft ?? 0,
        ...(divergence ? { divergence } : {}),
    }
}

export const workloadName = (provider: Provider) => (provider === 'kubernetes' ? 'research Job' : 'research container')

export function checkJob(
    scenario: Scenario,
    o: Observation,
    timeoutSeconds: number,
    provider: Provider = 'docker',
): Check[] {
    const want = expectationFor(scenario, provider)
    const provisioned = o.job.statuses.filter((change) => change.status === 'JOB-PROVISIONING').length
    const seconds = secondsToTerminal(o.job)
    const workload = workloadName(provider)
    // Only the checks whose expectation the divergence replaced are marked known.
    const known = (c: Check, ...keys: Array<keyof Expectation>): Check =>
        want.divergence && keys.some((key) => key in want.divergence!) ? { ...c, known: want.divergence.why } : c
    return [
        known(check(o, 'status history', historyMismatch(o.job, want.history)), 'history'),
        known(
            check(
                o,
                want.launches ? 'launched once' : 'never launched',
                provisioned === want.launches && o.maxWorkloads === want.launches
                    ? undefined
                    : `${provisioned} JOB-PROVISIONING, up to ${o.maxWorkloads} ${workload}(s) at once; expected ${want.launches}`,
            ),
            'launches',
        ),
        known(
            want.finishes
                ? check(
                      o,
                      `finished within ${timeoutSeconds}s`,
                      seconds === undefined
                          ? 'no terminal status'
                          : seconds > timeoutSeconds
                            ? `took ${seconds.toFixed(1)}s`
                            : undefined,
                  )
                : check(
                      o,
                      'never finishes',
                      seconds === undefined ? undefined : `reached a terminal status after ${seconds.toFixed(1)}s`,
                  ),
            'finishes',
        ),
        known(
            check(
                o,
                want.workloadsLeft ? `${workload} left behind` : `${workload} removed`,
                o.workloadsLeft === want.workloadsLeft
                    ? undefined
                    : `${o.workloadsLeft} left; expected ${want.workloadsLeft}`,
            ),
            'workloadsLeft',
        ),
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
    for (const c of checks) {
        const verdict = !c.ok ? 'FAIL ' : c.known ? 'KNOWN' : 'PASS '
        log(`  ${verdict}  ${c.scope}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
    }
    const why = [...new Set(checks.filter((c) => c.known).map((c) => `${c.scope}: ${c.known}`))]
    if (why.length) {
        log('KNOWN = matches how this provider behaves today, which differs from the other providers:')
        for (const line of why) log(`  ${line}`)
    }
    const failed = checks.filter((c) => !c.ok).length
    const known = checks.filter((c) => c.ok && c.known).length
    log(
        failed
            ? `${failed} of ${checks.length} checks FAILED`
            : `all ${checks.length} checks passed${known ? ` (${known} of them against a known divergence)` : ''}`,
    )
    return failed === 0
}

export type SmokeEnv = {
    provider: Provider
    baseUrl: string
    timeoutSeconds: number
    /** How long a job's history and containers must stay unchanged before it is judged. */
    settleSeconds: number
    /** Research workloads per job id: containers in Docker mode, Jobs in Kubernetes mode. */
    workloadsByJob: () => Map<string, number>
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

    const maxWorkloads = new Map<string, number>()
    const started = Date.now()
    const hardStop = started + (env.timeoutSeconds + 3 * env.settleSeconds) * 1000
    let fingerprint = ''
    let stableSince = Date.now()
    let dump: { jobs: Job[]; authFailures: AuthFailure[] }
    let counts: Map<string, number>
    let lastProgress = ''
    for (;;) {
        dump = await getJson(`${env.baseUrl}/jobs.json`)
        counts = env.workloadsByJob()
        for (const id of ids.keys()) maxWorkloads.set(id, Math.max(maxWorkloads.get(id) ?? 0, counts.get(id) ?? 0))

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

        // A job expected never to finish (a known divergence) only has to stop changing.
        const allDone = [...ids].every(([id, scenario]) =>
            expectationFor(scenario, env.provider).finishes
                ? done.some((job) => job.jobId === id) && !counts.get(id)
                : true,
        )
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
            maxWorkloads: maxWorkloads.get(id) ?? 0,
            workloadsLeft: counts.get(id) ?? 0,
            result: await fetchArtifact(env, job, 'result'),
            log: await fetchArtifact(env, job, 'log'),
        }
        checks.push(...checkJob(scenario, observation, env.timeoutSeconds, env.provider))
    }
    checks.push(...checkStack(dump.authFailures, setupAppBefore, env.setupAppState()))
    env.say(`checked after ${((Date.now() - started) / 1000).toFixed(0)}s:`)
    return report(checks, env.say)
}
