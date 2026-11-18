#!/usr/bin/env -S npx tsx
/* eslint-disable no-console */
/**
 * Local enclave stack: the management app stand-in (standin/), plus setup-app (DOCKER mode, or
 * KUBERNETES mode against a kind cluster with --k8s; see kind.ts) and the trusted-output-app from
 * sibling checkouts, all under one docker compose project.
 *
 *   ./dev-enclave.ts up            prepare keys, env files and sample images, then compose up
 *   ./dev-enclave.ts smoke         run the smoke checks against a fresh stack (README.md)
 *   ./dev-enclave.ts run offline   trigger a job (also from the page at http://localhost:4000)
 *   ./dev-enclave.ts down          stop the stack and remove research containers and Jobs
 *   ./dev-enclave.ts clean         down, delete the kind cluster, forget jobs; --keys and --images go further
 *
 * Settings come from the environment; see README.md.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { parseArgs } from 'node:util'
import {
    DEFAULT_TUTOR_BASE_IMAGE,
    HarnessError,
    IMAGE_PREFIX,
    KEYS_DIR,
    LEGACY_IMAGE_PREFIX,
    LOCAL_DIR,
    type Provider,
    REGISTRY_PORT,
    REGISTRY_VOLUME,
    SAMPLES_FILE,
    STATE_DIR,
    bindMountUser,
    buildImage,
    composeArgs,
    currentProvider,
    dockerFacts,
    ensureKeys,
    exportAwsCredentials,
    readDockerAuthLocal,
    registryOf,
    researchContainers,
    researchContainersByJob,
    run,
    runAsync,
    say,
    serveBuilds,
    serviceState,
    stackContainers,
    tryCapture,
    writeEnvFile,
    writeProvider,
} from './harness'
import {
    APISERVER,
    CLUSTER,
    NAMESPACE,
    NODE,
    PULL_SECRET,
    SA_MOUNT,
    configureCluster,
    deleteCluster,
    ensureCluster,
    followToa,
    nodeRunning,
    pointToaServiceAt,
    removeResearchJobs,
    researchJobsByJob,
    toaAddress,
} from './kind'
import { runSmoke } from './smoke'
import type { Sample } from './standin/page'

const USAGE = `usage: ./dev-enclave.ts <up|run|smoke|down|clean> [options]   (or: npm run enclave -- <command>)

  up     [--k8s] [--fresh-keys] [--no-verify-jwt] [--no-aws] [--skip-samples]
  run    [offline|offline-fail|tutor|--image NAME|--code main.py [--base-image IMAGE]] [--title TITLE]
  smoke  [--k8s] [--keep] [--timeout SECONDS]
  down
  clean  [--keys] [--images]

environment: SETUP_APP_DIR, TOA_DIR, BMA_PORT, REGISTRY_PORT (5055), MEMBER_ID, AWS_PROFILE, SAMPLE_TUTOR_BASE_IMAGE,
             HIGHLIGHTS_S3_BUCKET_NAME, HIGHLIGHTS_S3_BUCKET_PREFIX, HIGHLIGHTS_S3_BUCKET_REGION,
             SETUP_APP_DEBUG_PORT (9229), TOA_DEBUG_PORT (9230), BMA_DEBUG_PORT (9231)`

const settings = {
    setupAppDir: path.resolve(LOCAL_DIR, process.env.SETUP_APP_DIR ?? '../../setup-app'),
    toaDir: path.resolve(LOCAL_DIR, process.env.TOA_DIR ?? '../../trusted-output-app'),
    port: Number(process.env.BMA_PORT ?? 4000),
    memberId: process.env.MEMBER_ID ?? 'openstax',
    awsProfile: process.env.AWS_PROFILE ?? 'ose-dev',
    tutorBaseImage: process.env.SAMPLE_TUTOR_BASE_IMAGE ?? DEFAULT_TUTOR_BASE_IMAGE,
    bucket: process.env.HIGHLIGHTS_S3_BUCKET_NAME ?? 'openstax-enclave-data-dev',
    bucketPrefix: process.env.HIGHLIGHTS_S3_BUCKET_PREFIX ?? '/tutor/v2/',
    bucketRegion: process.env.HIGHLIGHTS_S3_BUCKET_REGION ?? 'us-west-2',
    debugPorts: {
        setupApp: process.env.SETUP_APP_DEBUG_PORT ?? '9229',
        toa: process.env.TOA_DEBUG_PORT ?? '9230',
        bma: process.env.BMA_DEBUG_PORT ?? '9231',
    },
}

const pageUrl = () => `http://localhost:${settings.port}/`
const imageTag = (name: string) => `${IMAGE_PREFIX}/sample-${name}`

type PrepareFlags = {
    /** kubernetes runs setup-app in KUBERNETES mode against the kind cluster (kind.ts). */
    provider: Provider
    freshKeys: boolean
    verifyJwt: boolean
    aws: boolean
    samples: boolean
    /** false skips the tutor sample (and its Harbor login prompt) altogether. */
    tutor: boolean
    /** Directory under state/ for the stand-in's jobs instead of state/ itself. */
    jobStore?: string
}

/** Everything `up` and `smoke` share before compose starts: checks, keys, env files, sample images. */
async function prepare(flags: PrepareFlags): Promise<void> {
    if (
        !existsSync(path.join(settings.setupAppDir, 'Dockerfile')) ||
        !existsSync(path.join(settings.setupAppDir, 'src', 'scripts', 'poll.ts'))
    ) {
        throw new HarnessError(
            `setup-app checkout not found at ${settings.setupAppDir}; clone it next to this repo or set SETUP_APP_DIR`,
        )
    }
    if (
        !existsSync(path.join(settings.toaDir, 'Dockerfile')) ||
        !existsSync(path.join(settings.toaDir, 'src', 'server.ts'))
    ) {
        throw new HarnessError(
            `trusted-output-app checkout not found at ${settings.toaDir}; clone it next to this repo or set TOA_DIR`,
        )
    }
    const k8s = flags.provider === 'kubernetes'
    // The data variables reach research containers through setup-app's RESEARCH_CONTAINER_ENV, which
    // its DOCKER mode only has from the local-dev-enclave branch onwards. Its KUBERNETES mode hands
    // research pods only TRUSTED_OUTPUT_ENDPOINT and BQ_*.
    const forwardsEnv =
        !k8s &&
        readFileSync(path.join(settings.setupAppDir, 'src', 'lib', 'docker.ts'), 'utf8').includes(
            'RESEARCH_CONTAINER_ENV',
        )
    const docker = dockerFacts()
    say(
        `docker ${docker.serverVersion} (compose ${docker.composeVersion}), socket ${docker.socket}${docker.rootless ? ', rootless' : ''}`,
    )
    say(`setup-app from ${settings.setupAppDir}${k8s ? ' in KUBERNETES mode' : ''}`)
    if (k8s) {
        say('Kubernetes mode: research pods get no AWS credentials or data variables, so the tutor sample is skipped')
    } else if (!forwardsEnv) {
        say('WARNING: this setup-app checkout has no RESEARCH_CONTAINER_ENV support, so research containers get no AWS')
        say('  credentials or data variables. Use the local-dev-enclave branch (SETUP_APP_DIR=/path/to/that checkout).')
        say('  The tutor sample is skipped; pasted code cannot read S3 either.')
    }
    say(`trusted-output-app from ${settings.toaDir}`)

    const { keys, generated } = ensureKeys(flags.freshKeys)
    say(`${generated ? 'generated' : 'using'} keys in ${KEYS_DIR}`)
    if (generated && !flags.freshKeys)
        say('(first run: the enclave pair signs JWTs, the reviewer pair decrypts results)')

    const setupAppEnv: Record<string, string> = {
        MANAGEMENT_APP_BASE_URL: 'http://bma:4000',
        MANAGEMENT_APP_MEMBER_ID: settings.memberId,
        MANAGEMENT_APP_PRIVATE_KEY: keys.enclavePrivatePem,
        TOA_BASE_URL: 'http://toa:3002',
        POLL_STUDIES_INTERVAL_SECONDS: '5',
        POLL_ERRORED_JOBS_INTERVAL_SECONDS: '10',
        ...(k8s
            ? {
                  DEPLOYMENT_ENVIRONMENT: 'KUBERNETES',
                  K8S_APISERVER: APISERVER,
                  K8S_SERVICEACCOUNT_PATH: SA_MOUNT,
                  HARBOR_PULL_SECRET: PULL_SECRET,
              }
            : {
                  DEPLOYMENT_ENVIRONMENT: 'DOCKER',
                  DOCKER_SOCKET: '/var/run/docker.sock',
                  DOCKER_API_VERSION: 'v1.48',
                  RESEARCH_CONTAINER_NETWORK: 'enclave-dev',
              }),
    }

    let awsReady = false
    if (!k8s && flags.aws && settings.awsProfile) {
        const exported = exportAwsCredentials(settings.awsProfile)
        if (exported.ok) {
            const dataEnv: Record<string, string> = {
                AWS_ACCESS_KEY_ID: exported.creds.AccessKeyId,
                AWS_SECRET_ACCESS_KEY: exported.creds.SecretAccessKey,
                ...(exported.creds.SessionToken ? { AWS_SESSION_TOKEN: exported.creds.SessionToken } : {}),
                AWS_REGION: settings.bucketRegion,
                AWS_DEFAULT_REGION: settings.bucketRegion,
                HIGHLIGHTS_S3_BUCKET_NAME: settings.bucket,
                HIGHLIGHTS_S3_BUCKET_PREFIX: settings.bucketPrefix,
                HIGHLIGHTS_S3_BUCKET_REGION: settings.bucketRegion,
            }
            Object.assign(setupAppEnv, dataEnv, { RESEARCH_CONTAINER_ENV: Object.keys(dataEnv).join(',') })
            awsReady = true
            say(
                `AWS credentials from profile ${settings.awsProfile} (expire ${exported.creds.Expiration ?? 'unknown'}) will reach research containers; data at s3://${settings.bucket}${settings.bucketPrefix}`,
            )
        } else {
            say(`no AWS credentials: ${exported.reason}`)
            say(
                `  run \`aws sso login --profile ${settings.awsProfile}\` and start again for the tutor sample; the offline sample works without it`,
            )
        }
    }

    writeEnvFile(path.join(STATE_DIR, 'setup-app.env'), setupAppEnv)
    writeEnvFile(path.join(STATE_DIR, 'toa.env'), {
        PORT: '3002',
        MANAGEMENT_APP_API_URL: 'http://bma:4000',
        MANAGEMENT_APP_MEMBER_ID: settings.memberId,
        MANAGEMENT_APP_PRIVATE_KEY: keys.enclavePrivatePem,
    })
    writeEnvFile(path.join(STATE_DIR, 'bma.env'), {
        BMA_PORT: '4000',
        MEMBER_ID: settings.memberId,
        VERIFY_JWT: String(flags.verifyJwt),
        STATE_DIR: '/app/local-enclave/state',
        CODE_BASE_IMAGES: ['python:3.12-slim', settings.tutorBaseImage].filter(Boolean).join(','),
        SETUP_APP_DIR: settings.setupAppDir,
        SETUP_APP_FORWARDS_ENV: String(forwardsEnv),
        SETUP_APP_PROVIDER: flags.provider,
        CODE_IMAGE_PREFIX: `${IMAGE_PREFIX}/code`,
        ...(flags.jobStore ? { JOB_STORE_DIR: `/app/local-enclave/state/${flags.jobStore}` } : {}),
    })
    writeEnvFile(path.join(STATE_DIR, 'compose.env'), {
        SETUP_APP_DIR: settings.setupAppDir,
        TOA_DIR: settings.toaDir,
        DOCKER_SOCK: docker.socket,
        BMA_USER: bindMountUser(docker.rootless),
        BMA_PORT: String(settings.port),
        REGISTRY_PORT,
        SETUP_APP_DEBUG_PORT: settings.debugPorts.setupApp,
        TOA_DEBUG_PORT: settings.debugPorts.toa,
        BMA_DEBUG_PORT: settings.debugPorts.bma,
    })

    // compose.k8s.yaml joins services to the cluster's `kind` network, so the cluster comes first.
    writeProvider(flags.provider)
    if (k8s) {
        ensureCluster()
        configureCluster()
        say(
            `setup-app runs research Jobs in namespace ${NAMESPACE}; \`kubectl --context kind-${CLUSTER} -n ${NAMESPACE} get jobs,pods\` shows them`,
        )
    }

    if (flags.samples) {
        // The registry has to be up first: every built image is pushed to it.
        startRegistry()
        await buildSamples({ tutor: flags.tutor, awsReady: awsReady && forwardsEnv, forwardsEnv })
    }
}

async function up(flags: Omit<PrepareFlags, 'tutor' | 'jobStore'>): Promise<number> {
    await prepare({ ...flags, tutor: true })
    say(`starting the stack; page at ${pageUrl()} (Ctrl-C stops everything)`)
    say(
        `debugger ports: setup-app ${settings.debugPorts.setupApp}, trusted-output-app ${settings.debugPorts.toa}, stand-in ${settings.debugPorts.bma} (see .vscode/launch.json)`,
    )
    // Images for pasted code are built here, next to Docker and the registry login, while compose runs.
    const builder = new AbortController()
    const builds = serveBuilds(settings.port, builder.signal)
    // The TOA container's address on the `kind` network is only known once compose has started it.
    const toa = flags.provider === 'kubernetes' ? followToa(builder.signal) : Promise.resolve()
    const code = await runAsync('docker', [...composeArgs(), 'up', '--build', '--remove-orphans'])
    builder.abort()
    await Promise.all([builds, toa])
    down()
    // 130 is compose reporting the Ctrl-C it received, which is the normal way to stop the stack.
    return code === 130 ? 0 : code
}

/** The registry has to be up before anything is built, since every built image is pushed to it. */
function startRegistry(): void {
    say(`starting the image registry on 127.0.0.1:${REGISTRY_PORT}`)
    if (run('docker', [...composeArgs(), 'up', '--detach', '--wait', 'registry']) !== 0) {
        throw new HarnessError(
            `the image registry did not start; is port ${REGISTRY_PORT} taken? (REGISTRY_PORT picks another)`,
        )
    }
}

async function buildSamples({
    tutor,
    awsReady,
    forwardsEnv,
}: {
    tutor: boolean
    awsReady: boolean
    forwardsEnv: boolean
}): Promise<void> {
    const samples: Sample[] = []
    const offline = path.join(LOCAL_DIR, 'samples', 'offline')
    say('building the offline sample image')
    if (!buildImage(`${imageTag('offline')}:latest`, offline))
        throw new HarnessError('offline sample image failed to build')
    samples.push({
        name: 'offline',
        image: `${imageTag('offline')}:latest`,
        description: 'five progress messages, then a CSV upload; no registry or data access',
    })
    if (buildImage(`${imageTag('offline')}:fail`, offline, { SAMPLE_FAIL: '1' })) {
        samples.push({
            name: 'offline-fail',
            image: `${imageTag('offline')}:fail`,
            description: 'exits 1 after JOB-RUNNING to exercise the error and log path',
        })
    }

    if (!tutor) {
        // smoke: only the offline samples, so no registry login is needed
    } else if (!settings.tutorBaseImage) {
        say('SAMPLE_TUTOR_BASE_IMAGE is empty; skipping the tutor sample')
    } else if (!forwardsEnv) {
        say('skipping the tutor sample: this setup-app cannot hand it the S3 variables (see the warning above)')
    } else if (await tutorBaseAvailable()) {
        say(`building the tutor sample on ${settings.tutorBaseImage}`)
        if (
            buildImage(`${imageTag('tutor')}:latest`, path.join(LOCAL_DIR, 'samples', 'tutor'), {
                BASE_IMAGE: settings.tutorBaseImage,
            })
        ) {
            samples.push({
                name: 'tutor',
                image: `${imageTag('tutor')}:latest`,
                description: awsReady
                    ? `queries the Tutor parquet data in s3://${settings.bucket}${settings.bucketPrefix}`
                    : 'needs AWS credentials: restart with an SSO session for it to find data',
            })
        } else {
            say('tutor sample image failed to build; skipping it')
        }
    }
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(SAMPLES_FILE, JSON.stringify(samples, null, 2))
}

/** The tutor base lives in Harbor's private openstax project; offer a login rather than fail. */
async function tutorBaseAvailable(): Promise<boolean> {
    const image = settings.tutorBaseImage
    const check = () => tryCapture('docker', ['manifest', 'inspect', image])
    let probe = check()
    if (probe.ok) return true
    if (!/unauthorized|denied|authentication required|401/i.test(probe.err)) {
        say(`tutor sample skipped: cannot read ${image}: ${probe.err.split('\n')[0]}`)
        return false
    }
    const registry = registryOf(image)
    const auth = readDockerAuthLocal()
    if (auth) {
        say(`logging in to ${registry} with docker-auth.local`)
        const login = run('docker', ['login', registry, '--username', auth.username, '--password-stdin'], {
            input: auth.password,
        })
        if (login !== 0) say('login failed')
    } else if (process.stdin.isTTY) {
        say(
            `${image} needs a login to ${registry}. Harbor uses OIDC: sign in at https://${registry}/ in a browser, open your`,
        )
        say('  user profile (top right) and copy the CLI secret; it is the password for `docker login`.')
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const answer = (await rl.question('[dev-enclave] log in now? [y/N] ')).trim().toLowerCase()
        rl.close()
        if (answer === 'y' || answer === 'yes') run('docker', ['login', registry])
    } else {
        say(
            `tutor sample skipped: ${image} needs a login to ${registry} (run \`docker login ${registry}\` or fill docker-auth.local)`,
        )
        return false
    }
    probe = check()
    if (!probe.ok) say(`tutor sample skipped: still cannot read ${image}`)
    return probe.ok
}

/**
 * Bring the stack up in the background with its own job store, run the smoke scenarios against it
 * and take it down again (unless --keep). Exit code 0 only when every check passed.
 */
async function smoke(flags: { provider: Provider; keep: boolean; timeoutSeconds: number }): Promise<number> {
    if (stackContainers().length) {
        throw new HarnessError('the stack is already running; stop it (`dev-enclave.ts down`) before running smoke')
    }
    rmSync(path.join(STATE_DIR, 'smoke'), { recursive: true, force: true })
    const k8s = flags.provider === 'kubernetes'
    await prepare({
        provider: flags.provider,
        freshKeys: false,
        verifyJwt: true,
        aws: false,
        samples: true,
        tutor: false,
        jobStore: 'smoke',
    })
    say('starting the stack in the background')
    if (run('docker', [...composeArgs(), 'up', '--build', '--detach', '--wait', '--remove-orphans']) !== 0) {
        down()
        throw new HarnessError('the stack did not come up; see the compose output above')
    }
    if (k8s) {
        const address = toaAddress()
        if (!address) {
            down()
            throw new HarnessError('the trusted-output-app is not on the kind network')
        }
        pointToaServiceAt(address)
    }
    let passed = false
    try {
        passed = await runSmoke({
            baseUrl: `http://127.0.0.1:${settings.port}`,
            timeoutSeconds: flags.timeoutSeconds,
            settleSeconds: 15,
            provider: flags.provider,
            workloadsByJob: k8s ? researchJobsByJob : researchContainersByJob,
            setupAppState: () => serviceState('setup-app'),
            say,
        })
    } finally {
        if (flags.keep) {
            say(`leaving the stack up: page at ${pageUrl()}, logs with \`docker compose -p enclave-dev logs -f\`;`)
            say('  `dev-enclave.ts down` stops it')
        } else {
            down()
        }
    }
    return passed ? 0 : 1
}

/** keepCluster is false only for `clean`, which deletes the cluster right after. */
function down(keepCluster = true): void {
    say('stopping the stack')
    run('docker', [...composeArgs(), 'down', '--remove-orphans', '--timeout', '5'])
    const leftovers = researchContainers()
    if (leftovers.length) {
        say(`removing ${leftovers.length} research container(s) setup-app left behind`)
        run('docker', ['rm', '-f', ...leftovers])
    }
    // The kind cluster keeps running so the next `up --k8s` starts at once; only the research Jobs go.
    // `clean` deletes it; `docker stop` on the node pauses it, and the next `--k8s` run restarts it.
    if (currentProvider() === 'kubernetes' && nodeRunning()) {
        const jobs = removeResearchJobs()
        if (jobs) say(`removed ${jobs} research Job(s) setup-app left in the cluster`)
        if (keepCluster) say(`the kind cluster keeps running (\`clean\` deletes it, \`docker stop ${NODE}\` pauses it)`)
    }
}

async function trigger(
    positional: string[],
    flags: { image?: string; title?: string; code?: string; baseImage?: string },
): Promise<number> {
    const sample = positional[0]
    let body: Record<string, string | undefined>
    if (flags.code) {
        if (!existsSync(flags.code)) throw new HarnessError(`no such file: ${flags.code}`)
        body = {
            code: readFileSync(flags.code, 'utf8'),
            baseImage: flags.baseImage,
            title: flags.title ?? path.basename(flags.code),
        }
    } else if (flags.image) {
        body = { image: flags.image, title: flags.title }
    } else {
        body = { sample: sample ?? 'offline', title: flags.title }
    }
    let res: Response
    try {
        res = await fetch(`http://127.0.0.1:${settings.port}/jobs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
    } catch {
        throw new HarnessError(`nothing is listening on ${pageUrl()}; run \`dev-enclave.ts up\` first`)
    }
    const text = await res.text()
    if (!res.ok) throw new HarnessError(`stand-in refused the job (${res.status}): ${text}`)
    const job = JSON.parse(text) as { jobId: string; image: string; build?: { baseImage: string } }
    if (job.build)
        say(
            `job ${job.jobId} queued; \`up\` builds ${job.image} from ${job.build.baseImage} first, then setup-app runs it`,
        )
    else say(`job ${job.jobId} queued for ${job.image}; setup-app picks it up within a few seconds`)
    say(`watch it at ${pageUrl()}#job-${job.jobId}`)
    return 0
}

function clean(flags: { keys: boolean; images: boolean }): number {
    if (existsSync(path.join(STATE_DIR, 'compose.env'))) down(false)
    if (deleteCluster()) say(`deleted the kind cluster ${CLUSTER}`)
    for (const entry of [
        'provider',
        'k8s',
        'jobs.json',
        'jobs',
        'builds',
        'smoke',
        'samples.json',
        'setup-app.env',
        'toa.env',
        'bma.env',
        'compose.env',
    ]) {
        rmSync(path.join(STATE_DIR, entry), { recursive: true, force: true })
    }
    say('forgot jobs and generated env files')
    if (flags.keys) {
        rmSync(KEYS_DIR, { recursive: true, force: true })
        say('removed keys; the next `up` generates new ones')
    }
    if (flags.images) {
        const filters = [IMAGE_PREFIX, LEGACY_IMAGE_PREFIX].flatMap((prefix) => ['--filter', `reference=${prefix}/*`])
        const images = tryCapture('docker', ['images', '-q', ...filters])
        const ids = [...new Set(images.out.split('\n').filter(Boolean))]
        if (ids.length) run('docker', ['rmi', '-f', ...ids])
        say(`removed ${ids.length} sample image(s)`)
        if (tryCapture('docker', ['volume', 'rm', REGISTRY_VOLUME]).ok)
            say(`removed the registry volume ${REGISTRY_VOLUME}`)
    }
    if (existsSync(STATE_DIR) && readdirSync(STATE_DIR).length === 0)
        rmSync(STATE_DIR, { recursive: true, force: true })
    return 0
}

async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            'fresh-keys': { type: 'boolean', default: false },
            'no-verify-jwt': { type: 'boolean', default: false },
            'no-aws': { type: 'boolean', default: false },
            'skip-samples': { type: 'boolean', default: false },
            k8s: { type: 'boolean', default: false },
            image: { type: 'string' },
            code: { type: 'string' },
            'base-image': { type: 'string' },
            title: { type: 'string' },
            keys: { type: 'boolean', default: false },
            images: { type: 'boolean', default: false },
            keep: { type: 'boolean', default: false },
            timeout: { type: 'string', default: '60' },
            help: { type: 'boolean', short: 'h', default: false },
        },
    })
    const [command = 'up', ...rest] = positionals
    if (values.help) {
        console.log(USAGE)
        return 0
    }
    switch (command) {
        case 'up':
            return up({
                provider: values.k8s ? 'kubernetes' : 'docker',
                freshKeys: values['fresh-keys'],
                verifyJwt: !values['no-verify-jwt'],
                aws: !values['no-aws'],
                samples: !values['skip-samples'],
            })
        case 'run':
            return trigger(rest, {
                image: values.image,
                title: values.title,
                code: values.code,
                baseImage: values['base-image'],
            })
        case 'smoke': {
            const timeoutSeconds = Number(values.timeout)
            if (!(timeoutSeconds > 0)) throw new HarnessError(`--timeout must be a positive number of seconds`)
            return smoke({ provider: values.k8s ? 'kubernetes' : 'docker', keep: values.keep, timeoutSeconds })
        }
        case 'down':
            down()
            return 0
        case 'clean':
            return clean({ keys: values.keys, images: values.images })
        default:
            console.error(`unknown command "${command}"\n\n${USAGE}`)
            return 64
    }
}

// Ctrl-C reaches compose too (same process group); it stops the containers, `up` then runs `down`.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
        console.error(
            `[dev-enclave] ${err instanceof HarnessError ? err.message : ((err as Error).stack ?? String(err))}`,
        )
        process.exit(err instanceof HarnessError ? 1 : 70)
    },
)
