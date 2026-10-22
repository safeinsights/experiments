/* eslint-disable no-console */
/** Host-side helpers for dev-enclave.ts: Docker facts, keys, AWS credentials, env files, images. */
import { execFileSync, spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LOCAL_DIR = import.meta.dirname
/** The experiments repo root: the bma image is built from it and it is bind-mounted into that container. */
export const REPO_ROOT = path.resolve(LOCAL_DIR, '..')
export const STATE_DIR = path.join(LOCAL_DIR, 'state')
export const KEYS_DIR = path.join(STATE_DIR, 'keys')
export const SAMPLES_FILE = path.join(STATE_DIR, 'samples.json')
export const IMAGE_PREFIX = 'localhost/enclave-dev'
export const DEFAULT_TUTOR_BASE_IMAGE = 'harbor.safeinsights.org/openstax/python-base:3.12-2026-10-01-ed858d81'

export const say = (line: string): void => console.log(`[dev-enclave] ${line}`)

export class HarnessError extends Error {}

/** Run a command and return trimmed stdout; a non-zero exit becomes a HarnessError with stderr. */
export function capture(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
    try {
        return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
    } catch (err) {
        const e = err as { stderr?: string; message: string; code?: string }
        if (e.code === 'ENOENT') throw new HarnessError(`${cmd} is not installed or not on PATH`)
        throw new HarnessError(`${cmd} ${args.join(' ')} failed: ${(e.stderr ?? e.message).trim()}`)
    }
}

export function tryCapture(cmd: string, args: string[]): { ok: boolean; out: string; err: string } {
    const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return {
        ok: result.status === 0,
        out: (result.stdout ?? '').trim(),
        err: (result.stderr ?? result.error?.message ?? '').trim(),
    }
}

/** Run with inherited stdio and return the exit code. */
export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): number {
    const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
    if (result.error) throw new HarnessError(`${cmd}: ${result.error.message}`)
    return result.status ?? 1
}

export function runAsync(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
        child.on('error', reject)
        child.on('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)))
    })
}

export type DockerFacts = { socket: string; rootless: boolean; serverVersion: string; composeVersion: string }

export function dockerFacts(): DockerFacts {
    const version = tryCapture('docker', ['version', '--format', '{{.Server.Version}}'])
    if (!version.ok) {
        throw new HarnessError(
            `Docker daemon not reachable (${version.err.split('\n')[0] || 'is docker installed and running?'})`,
        )
    }
    const composeVersion = tryCapture('docker', ['compose', 'version', '--short'])
    if (!composeVersion.ok) throw new HarnessError('docker compose v2 is required (the `docker compose` plugin)')
    const host = capture('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
    if (!host.startsWith('unix://')) {
        throw new HarnessError(
            `Docker endpoint ${host} is not a unix socket; setup-app needs one mounted into its container`,
        )
    }
    const security = capture('docker', ['info', '--format', '{{json .SecurityOptions}}'])
    return {
        socket: host.slice('unix://'.length),
        rootless: security.includes('name=rootless'),
        serverVersion: version.out,
        composeVersion: composeVersion.out,
    }
}

export type Keys = {
    enclavePrivatePem: string
    enclavePublicPem: string
    reviewerPrivatePem: string
    reviewerPublicPem: string
}

const KEY_FILES: Array<[keyof Keys, string]> = [
    ['enclavePrivatePem', 'enclave.key.pem'],
    ['enclavePublicPem', 'enclave.pub.pem'],
    ['reviewerPrivatePem', 'reviewer.key.pem'],
    ['reviewerPublicPem', 'reviewer.pub.pem'],
]

/**
 * Two RSA-4096 pairs, same shape as the openssl commands in the management-app README: the enclave
 * pair signs the JWT setup-app and the TOA send (the stand-in verifies), the reviewer pair is what
 * results get encrypted for (the stand-in decrypts). Generated once; `--fresh-keys` replaces them.
 */
export function ensureKeys(fresh: boolean): { keys: Keys; generated: boolean } {
    mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 })
    const files = KEY_FILES.map(([, name]) => path.join(KEYS_DIR, name))
    if (!fresh && files.every(existsSync)) {
        const keys = Object.fromEntries(
            KEY_FILES.map(([field, name]) => [field, readFileSync(path.join(KEYS_DIR, name), 'utf8')]),
        ) as Keys
        return { keys, generated: false }
    }
    const pair = () =>
        generateKeyPairSync('rsa', {
            modulusLength: 4096,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        })
    const enclave = pair()
    const reviewer = pair()
    const keys: Keys = {
        enclavePrivatePem: enclave.privateKey,
        enclavePublicPem: enclave.publicKey,
        reviewerPrivatePem: reviewer.privateKey,
        reviewerPublicPem: reviewer.publicKey,
    }
    for (const [field, name] of KEY_FILES) writeFileSync(path.join(KEYS_DIR, name), keys[field], { mode: 0o600 })
    return { keys, generated: true }
}

export type AwsCredentials = {
    AccessKeyId: string
    SecretAccessKey: string
    SessionToken?: string
    Expiration?: string
}

/** Short-lived credentials for a profile, SSO included; the CLI handles the token cache. */
export function exportAwsCredentials(
    profile: string,
): { ok: true; creds: AwsCredentials } | { ok: false; reason: string } {
    const result = tryCapture('aws', ['configure', 'export-credentials', '--profile', profile, '--format', 'process'])
    if (!result.ok) return { ok: false, reason: result.err.split('\n').find(Boolean) ?? 'aws CLI failed' }
    try {
        return { ok: true, creds: JSON.parse(result.out) as AwsCredentials }
    } catch {
        return { ok: false, reason: 'could not parse the aws CLI output' }
    }
}

/**
 * compose `env_file` syntax, single-quoted: values are literal, may span lines (the PEMs do) and are
 * never interpolated, so AWS secrets with `$` or `+` survive untouched.
 */
export function writeEnvFile(file: string, entries: Record<string, string>): void {
    const lines = Object.entries(entries).map(([key, value]) => {
        if (value.includes("'"))
            throw new HarnessError(`${key} contains a single quote, which the env file format cannot carry`)
        return `${key}='${value}'`
    })
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
}

export function composeArgs(): string[] {
    return [
        'compose',
        '--project-directory',
        LOCAL_DIR,
        '-f',
        path.join(LOCAL_DIR, 'compose.yaml'),
        '--env-file',
        path.join(STATE_DIR, 'compose.env'),
    ]
}

/** Containers setup-app started (label managed-by=setup-app); they are not part of the compose project. */
export function researchContainers(): string[] {
    const out = tryCapture('docker', [
        'ps',
        '-aq',
        '--filter',
        'label=managed-by=setup-app',
        '--filter',
        'label=component=research-container',
    ])
    return out.ok ? out.out.split('\n').filter(Boolean) : []
}

export function buildImage(tag: string, context: string, buildArgs: Record<string, string> = {}): boolean {
    const args = [
        'build',
        '-t',
        tag,
        ...Object.entries(buildArgs).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]),
        context,
    ]
    return run('docker', args) === 0
}

export type DockerAuth = { username: string; password: string; serveraddress: string }

/** docker-auth.local next to this file ({username, password, serveraddress}): Harbor credentials for non-interactive logins. */
export function readDockerAuthLocal(): DockerAuth | undefined {
    const file = path.join(LOCAL_DIR, 'docker-auth.local')
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DockerAuth>
    if (!parsed.username || !parsed.password) return undefined
    return {
        username: parsed.username,
        password: parsed.password,
        serveraddress: parsed.serveraddress ?? 'https://harbor.safeinsights.org/',
    }
}

export const registryOf = (image: string): string => image.split('/')[0] ?? ''

/** uid:gid for a container that writes into a bind mount; under rootless Docker container root is already the host user. */
export function bindMountUser(rootless: boolean): string {
    if (rootless || os.platform() === 'win32') return '0'
    const { uid, gid } = os.userInfo()
    return `${uid}:${gid}`
}

/** Run with captured, merged output; never throws for a non-zero exit. */
export function captureAsync(cmd: string, args: string[]): Promise<{ ok: boolean; log: string }> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        const chunks: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
        child.on('error', (err) => resolve({ ok: false, log: err.message }))
        child.on('close', (code) => resolve({ ok: code === 0, log: Buffer.concat(chunks).toString('utf8') }))
    })
}

export type CodeBuild = { jobId: string; image: string; baseImage: string; code: string }

/**
 * Image for a "run your own code" job: the chosen base, the pasted script as main.py and the
 * runner that speaks the trusted-output-app protocol (samples/code). Built here on the host
 * because that is where Docker and any registry login live.
 */
export function buildCodeImage(build: CodeBuild): Promise<{ ok: boolean; log: string }> {
    const context = path.join(STATE_DIR, 'builds', build.jobId)
    mkdirSync(context, { recursive: true })
    const template = path.join(LOCAL_DIR, 'samples', 'code')
    copyFileSync(path.join(template, 'Dockerfile'), path.join(context, 'Dockerfile'))
    copyFileSync(path.join(template, 'runner.py'), path.join(context, 'runner.py'))
    writeFileSync(path.join(context, 'main.py'), build.code.endsWith('\n') ? build.code : `${build.code}\n`)
    return captureAsync('docker', [
        'build',
        '--progress=plain',
        '--build-arg',
        `BASE_IMAGE=${build.baseImage}`,
        '-t',
        build.image,
        context,
    ])
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer)
                resolve()
            },
            { once: true },
        )
    })

const MAX_BUILD_LOG = 12_000

/** Poll the stand-in for code jobs waiting on an image and build them one at a time until aborted. */
export async function serveBuilds(port: number, signal: AbortSignal): Promise<void> {
    const base = `http://127.0.0.1:${port}`
    while (!signal.aborted) {
        try {
            const pending = await fetch(`${base}/builds/pending`, { signal })
            if (pending.ok) {
                const { builds } = (await pending.json()) as { builds: CodeBuild[] }
                for (const build of builds) {
                    if (signal.aborted) return
                    const started = await fetch(`${base}/builds/${build.jobId}/start`, { method: 'POST' })
                    if (!started.ok) continue
                    say(`building ${build.image} from ${build.baseImage} for job ${build.jobId}`)
                    const result = await buildCodeImage(build)
                    say(
                        result.ok
                            ? `built ${build.image}; setup-app picks the job up next poll`
                            : `build of ${build.image} FAILED; the log is on the page`,
                    )
                    await fetch(`${base}/builds/${build.jobId}/done`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ ok: result.ok, log: result.log.slice(-MAX_BUILD_LOG) }),
                    })
                }
            }
        } catch {
            // The stand-in is not up yet, or is restarting; try again shortly.
        }
        await sleep(2000, signal)
    }
}
