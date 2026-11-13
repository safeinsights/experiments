/**
 * Kubernetes mode (`up --k8s`, `smoke --k8s`): a kind cluster that setup-app, still running in compose,
 * drives through the Kubernetes API. The cluster outlives `down` and `clean` deletes it; a node stopped
 * with `docker stop` is started again by the next `--k8s` run.
 *
 * - Images: the node's containerd maps 127.0.0.1:REGISTRY_PORT to the compose registry over the `kind`
 *   network (kind's local-registry setup), so image names are the same as in Docker mode.
 * - Trusted-output-app: a selector-less `toa` Service whose EndpointSlice points at the TOA container's
 *   address on the `kind` network, so research pods reach http://toa:3002 like research containers do.
 * - setup-app: a ServiceAccount allowed to manage Jobs and pods in NAMESPACE, with a long-lived token.
 *   Its token, CA and namespace are written to SA_DIR, which compose.k8s.yaml mounts into setup-app.
 *
 * kubectl runs inside the node (`docker exec`), so neither kubectl nor a kubeconfig context is needed
 * on the host; `kubectl --context kind-enclave-dev` works there too for poking around.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isIPv4 } from 'node:net'
import path from 'node:path'
import { HarnessError, REGISTRY_PORT, STATE_DIR, run, say, tryCapture } from './harness'

export const CLUSTER = 'enclave-dev'
export const NODE = `${CLUSTER}-control-plane`
/** kind v0.33.0's default node. Pinned so a kind upgrade can't change Kubernetes underneath; setup-app needs >= 1.31. */
export const NODE_IMAGE = 'kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5'
export const NAMESPACE = 'enclave'
export const SERVICE_ACCOUNT = 'setup-app'
export const PULL_SECRET = 'harbor-pull'
/** The API server as setup-app sees it from the `kind` network; kind's serving certificate covers this name. */
export const APISERVER = `https://${NODE}:6443`
/** Host side of the service-account directory; compose.k8s.yaml mounts it at SA_MOUNT. */
export const SA_DIR = path.join(STATE_DIR, 'k8s', 'serviceaccount')
export const SA_MOUNT = '/var/run/enclave-serviceaccount'
/** The registry's alias on the `kind` network (compose.k8s.yaml) and the TOA's compose container name. */
const REGISTRY_HOST = 'enclave-dev-registry'
const TOA_CONTAINER = 'enclave-dev-toa-1'

const CLUSTER_CONFIG = `kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
nodes:
  - role: control-plane
    image: ${NODE_IMAGE}
`

const RBAC = `apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${SERVICE_ACCOUNT}
  namespace: ${NAMESPACE}
---
apiVersion: v1
kind: Secret
type: kubernetes.io/service-account-token
metadata:
  name: ${SERVICE_ACCOUNT}-token
  namespace: ${NAMESPACE}
  annotations:
    kubernetes.io/service-account.name: ${SERVICE_ACCOUNT}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${SERVICE_ACCOUNT}
  namespace: ${NAMESPACE}
rules:
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [create, get, list, delete]
  - apiGroups: ['']
    resources: [pods]
    verbs: [get, list, delete]
  - apiGroups: ['']
    resources: [pods/log]
    verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${SERVICE_ACCOUNT}
  namespace: ${NAMESPACE}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${SERVICE_ACCOUNT}
subjects:
  - kind: ServiceAccount
    name: ${SERVICE_ACCOUNT}
    namespace: ${NAMESPACE}
---
apiVersion: v1
kind: Service
metadata:
  name: toa
  namespace: ${NAMESPACE}
spec:
  ports:
    - name: http
      port: 3002
      targetPort: 3002
`

/** kubectl as cluster admin, inside the node. */
function kubectl(args: string[], input?: string): string {
    const result = tryCaptureInput(
        'docker',
        ['exec', '-i', NODE, 'kubectl', '--kubeconfig=/etc/kubernetes/admin.conf', ...args],
        input,
    )
    if (!result.ok) throw new HarnessError(`kubectl ${args.join(' ')} failed: ${result.err}`)
    return result.out
}

function tryCaptureInput(cmd: string, args: string[], input?: string): { ok: boolean; out: string; err: string } {
    if (input === undefined) return tryCapture(cmd, args)
    const result = spawnSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })
    return {
        ok: result.status === 0,
        out: (result.stdout ?? '').trim(),
        err: (result.stderr ?? result.error?.message ?? '').trim(),
    }
}

export const clusterExists = (): boolean => tryCapture('kind', ['get', 'clusters']).out.split('\n').includes(CLUSTER)

/** Create the cluster if it is missing (about 30s, once), or start a stopped node and wait for it (about 35s). */
export function ensureCluster(): void {
    if (!tryCapture('kind', ['version']).ok) {
        throw new HarnessError(
            'Kubernetes mode needs kind (https://kind.sigs.k8s.io/docs/user/quick-start/#installation)',
        )
    }
    if (!clusterExists()) {
        say(`creating the kind cluster ${CLUSTER} (once; \`clean\` deletes it)`)
        const config = path.join(STATE_DIR, 'k8s', 'kind.yaml')
        mkdirSync(path.dirname(config), { recursive: true })
        writeFileSync(config, CLUSTER_CONFIG)
        if (run('kind', ['create', 'cluster', '--name', CLUSTER, '--config', config]) !== 0) {
            throw new HarnessError(`kind could not create the ${CLUSTER} cluster; see its output above`)
        }
    } else if (!nodeRunning()) {
        say(`starting the stopped kind node ${NODE}`)
        if (!tryCapture('docker', ['start', NODE]).ok) throw new HarnessError(`could not start ${NODE}`)
        waitForCluster()
    } else {
        say(`using the kind cluster ${CLUSTER}`)
    }
    const image = tryCapture('docker', ['inspect', '--format', '{{.Config.Image}}', NODE]).out
    if (image !== NODE_IMAGE) {
        say(
            `WARNING: the ${CLUSTER} cluster runs ${image}, not ${NODE_IMAGE}; \`clean\` and start again to recreate it`,
        )
    }
}

/**
 * After a restart the API server, cluster DNS and Service routing take a while to come back, and
 * Kubernetes still reports the pods as Ready from before the stop. So probe for real, from the node:
 * the API server answers, each CoreDNS pod's /ready endpoint says yes, and CoreDNS's metrics port
 * answers through the kube-dns Service address (which only works once kube-proxy has its rules).
 * Without this, the first research pods fail to resolve `toa`.
 */
function waitForCluster(): void {
    const deadline = Date.now() + 120_000
    const inNode = (...args: string[]) => tryCapture('docker', ['exec', NODE, ...args])
    const kube = (...args: string[]) => inNode('kubectl', '--kubeconfig=/etc/kubernetes/admin.conf', ...args)
    const curl = (url: string) => inNode('curl', '-fsS', '--max-time', '2', '--output', '/dev/null', url).ok
    const ready = (): boolean => {
        const service = kube(
            'get',
            'service',
            'kube-dns',
            '--namespace=kube-system',
            '--output=jsonpath={.spec.clusterIP}',
        )
        const pods = kube(
            'get',
            'pods',
            '--namespace=kube-system',
            '--selector=k8s-app=kube-dns',
            '--output=jsonpath={.items[*].status.podIP}',
        )
        if (!service.ok || !service.out || !pods.ok || !pods.out) return false
        return (
            pods.out.split(' ').every((ip) => curl(`http://${ip}:8181/ready`)) &&
            curl(`http://${service.out}:9153/metrics`)
        )
    }
    while (!ready()) {
        if (Date.now() > deadline)
            throw new HarnessError(`the ${CLUSTER} cluster's DNS did not come back after starting ${NODE}`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
    }
}

/**
 * Everything inside the cluster that setup-app and research pods rely on: the registry mapping, the
 * namespace, setup-app's account and token, the pull secret and the `toa` Service. Idempotent; run
 * before setup-app starts (the registry itself can come up later).
 */
export function configureCluster(): void {
    // containerd re-reads certs.d on every pull, so no restart is needed.
    const hostsDir = `/etc/containerd/certs.d/127.0.0.1:${REGISTRY_PORT}`
    const hosts = `[host."http://${REGISTRY_HOST}:5000"]\n  capabilities = ["pull", "resolve"]\n`
    if (
        run('docker', ['exec', NODE, 'mkdir', '-p', hostsDir]) !== 0 ||
        tryCaptureInput('docker', ['exec', '-i', NODE, 'sh', '-c', `cat > ${hostsDir}/hosts.toml`], hosts).ok === false
    ) {
        throw new HarnessError(`could not point ${NODE} at the registry`)
    }
    kubectl(['apply', '-f', '-'], RBAC)
    // Dummy credentials: setup-app always names a pull secret, and the local registry ignores them.
    const secret = kubectl([
        'create',
        'secret',
        'docker-registry',
        PULL_SECRET,
        '--namespace',
        NAMESPACE,
        `--docker-server=127.0.0.1:${REGISTRY_PORT}`,
        '--docker-username=local',
        '--docker-password=local',
        '--dry-run=client',
        '--output=yaml',
    ])
    kubectl(['apply', '-f', '-'], secret)
    writeServiceAccountDir()
}

/** token, ca.crt and namespace from the long-lived token Secret, which Kubernetes fills in shortly after creation. */
function writeServiceAccountDir(): void {
    const deadline = Date.now() + 30_000
    for (;;) {
        const data = kubectl([
            'get',
            'secret',
            `${SERVICE_ACCOUNT}-token`,
            '--namespace',
            NAMESPACE,
            '--output=jsonpath={.data.token} {.data.ca\\.crt}',
        ])
        const [token, ca] = data.split(' ')
        if (token && ca) {
            mkdirSync(SA_DIR, { recursive: true, mode: 0o700 })
            writeFileSync(path.join(SA_DIR, 'token'), Buffer.from(token, 'base64'), { mode: 0o600 })
            writeFileSync(path.join(SA_DIR, 'ca.crt'), Buffer.from(ca, 'base64'), { mode: 0o644 })
            writeFileSync(path.join(SA_DIR, 'namespace'), NAMESPACE, { mode: 0o644 })
            return
        }
        if (Date.now() > deadline) throw new HarnessError(`the ${SERVICE_ACCOUNT}-token Secret never got a token`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
}

/** The TOA container's IPv4 address on the `kind` network, if it is running and attached. */
export function toaAddress(): string | undefined {
    const out = tryCapture('docker', [
        'inspect',
        '--format',
        '{{with index .NetworkSettings.Networks "kind"}}{{.IPAddress}}{{end}}',
        TOA_CONTAINER,
    ])
    // Docker prints "invalid IP" until the container has an address.
    return out.ok && isIPv4(out.out) ? out.out : undefined
}

/** Point the `toa` Service at this address (an EndpointSlice owned by nothing, so Kubernetes leaves it alone). */
export function pointToaServiceAt(address: string): void {
    kubectl(
        ['apply', '-f', '-'],
        `apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: toa-compose
  namespace: ${NAMESPACE}
  labels:
    kubernetes.io/service-name: toa
    endpointslice.kubernetes.io/managed-by: local-enclave
addressType: IPv4
ports:
  - name: http
    port: 3002
    protocol: TCP
endpoints:
  - addresses: ['${address}']
`,
    )
}

/** Keep the `toa` Service pointed at the TOA container until aborted; its address changes when compose recreates it. */
export async function followToa(signal: AbortSignal): Promise<void> {
    let current: string | undefined
    while (!signal.aborted) {
        const address = toaAddress()
        if (address && address !== current) {
            try {
                pointToaServiceAt(address)
                say(`research pods reach the trusted-output-app at ${address} (Service toa)`)
                current = address
            } catch (err) {
                say(`could not update the toa Service: ${(err as Error).message}`)
            }
        }
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2000)
            signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
        })
    }
}

/** Research Jobs per job id (the `instance` label), as setup-app labels them. */
export function researchJobsByJob(): Map<string, number> {
    const out = tryCapture('docker', [
        'exec',
        NODE,
        'kubectl',
        '--kubeconfig=/etc/kubernetes/admin.conf',
        'get',
        'jobs',
        '--namespace',
        NAMESPACE,
        '--selector=managed-by=setup-app,component=research-container',
        '--output=jsonpath={range .items[*]}{.metadata.labels.instance}{"\\n"}{end}',
    ])
    const counts = new Map<string, number>()
    for (const jobId of out.ok ? out.out.split('\n').filter(Boolean) : [])
        counts.set(jobId, (counts.get(jobId) ?? 0) + 1)
    return counts
}

/** Delete the research Jobs (and their pods) setup-app left behind; a no-op without a running cluster. */
export function removeResearchJobs(): number {
    const left = researchJobsByJob()
    const count = [...left.values()].reduce((a, b) => a + b, 0)
    if (count) {
        kubectl([
            'delete',
            'jobs',
            '--namespace',
            NAMESPACE,
            '--selector=managed-by=setup-app,component=research-container',
            '--cascade=foreground',
            '--wait=false',
        ])
    }
    return count
}

export function nodeRunning(): boolean {
    return tryCapture('docker', ['inspect', '--format', '{{.State.Running}}', NODE]).out === 'true'
}

export function deleteCluster(): boolean {
    if (!clusterExists()) return false
    return run('kind', ['delete', 'cluster', '--name', CLUSTER]) === 0
}
