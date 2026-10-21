import type { ArtifactKind, Job } from './jobs'

export type Sample = { name: string; image: string; description: string }
export type AuthFailure = { at: string; path: string; reason: string }
export type Preview = {
    name: string
    bytes: number
    href: string
    kind: 'csv' | 'text' | 'binary'
    rows?: string[][]
    text?: string
    truncated?: boolean
}
export type JobView = {
    job: Job
    previews: Partial<Record<ArtifactKind, Preview[]>>
    zips: Partial<Record<ArtifactKind, string>>
}
export type PageModel = {
    memberId: string
    verifyJwt: boolean
    reviewerFingerprint: string
    samples: Sample[]
    /** Suggestions for a code job's base image; the first is the default. */
    baseImages: string[]
    authFailures: AuthFailure[]
    jobs: JobView[]
}

export const DEFAULT_CODE = `# Write one or more CSV files in the working directory; the runner reports JOB-RUNNING before this
# runs and uploads every *.csv afterwards. progress(message) puts a message on the job's timeline.
# Any dependency of the base image can be used; on the OpenStax python-base image that includes
# osenclave.openstax.query_tutor.
import csv
import random
import time

for step in range(1, 6):
    progress(f"step {step} of 5")
    time.sleep(1)

with open("results.csv", "w", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["group", "count"])
    for group in "ABC":
        writer.writerow([group, random.randint(1, 100)])
`

const CSV_PREVIEW_BYTES = 512 * 1024
const CSV_PREVIEW_ROWS = 200
const TEXT_PREVIEW_BYTES = 100 * 1024

/** "1.2s", "45s", "3m 5s", "2h 10m": the same shape the page's script produces. */
export function formatDuration(ms: number): string {
    const seconds = Math.max(0, ms) / 1000
    if (seconds < 10) return `${seconds.toFixed(1)}s`
    if (seconds < 60) return `${Math.round(seconds)}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

/** A timestamp the page's script keeps rewriting as "12s ago"; the ISO value stays in the tooltip. */
const timeTag = (iso: string): string =>
    `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(iso)}</time>`

export function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let quoted = false
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') {
                field += '"'
                i++
            } else if (c === '"') {
                quoted = false
            } else {
                field += c
            }
        } else if (c === '"') {
            quoted = true
        } else if (c === ',') {
            row.push(field)
            field = ''
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++
            row.push(field)
            rows.push(row)
            row = []
            field = ''
        } else {
            field += c
        }
    }
    if (field.length || row.length) {
        row.push(field)
        rows.push(row)
    }
    return rows
}

/** setup-app uploads container logs as a JSON array of {timestamp, message}; show them as lines. */
function logLines(text: string): string | undefined {
    try {
        const parsed = JSON.parse(text) as unknown
        if (!Array.isArray(parsed)) return undefined
        return parsed
            .map((entry) => {
                const { timestamp, message } = entry as { timestamp?: number | string; message?: string }
                const at = typeof timestamp === 'number' ? new Date(timestamp).toISOString() : String(timestamp ?? '')
                return `[${at}] ${message ?? ''}`
            })
            .join('\n')
    } catch {
        return undefined
    }
}

export function buildPreview(name: string, href: string, contents: Buffer): Preview {
    const base = { name, href, bytes: contents.length }
    const lower = name.toLowerCase()
    if (lower.endsWith('.csv') && contents.length <= CSV_PREVIEW_BYTES) {
        const rows = parseCsv(contents.toString('utf8'))
        return {
            ...base,
            kind: 'csv',
            rows: rows.slice(0, CSV_PREVIEW_ROWS),
            truncated: rows.length > CSV_PREVIEW_ROWS,
        }
    }
    const textual = /\.(txt|json|log|md|tsv|r|py|yaml|yml)$/.test(lower) || isProbablyText(contents)
    if (textual) {
        const text = contents.subarray(0, TEXT_PREVIEW_BYTES).toString('utf8')
        const pretty = lower.endsWith('.json') ? logLines(text) : undefined
        return { ...base, kind: 'text', text: pretty ?? text, truncated: contents.length > TEXT_PREVIEW_BYTES }
    }
    return { ...base, kind: 'binary' }
}

function isProbablyText(contents: Buffer): boolean {
    const sample = contents.subarray(0, 1024)
    return sample.every((byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127))
}

const STATUS_CLASS: Record<string, string> = {
    'RUN-COMPLETE': 'ok',
    'FILES-APPROVED': 'ok',
    'JOB-ERRORED': 'bad',
    'FILES-REJECTED': 'bad',
    'JOB-RUNNING': 'busy',
    'JOB-PROVISIONING': 'busy',
}

const badge = (status: string) => `<span class="badge ${STATUS_CLASS[status] ?? ''}">${escapeHtml(status)}</span>`

function renderPreview(preview: Preview): string {
    const title = `<div class="file"><a href="${escapeHtml(preview.href)}">${escapeHtml(preview.name)}</a> <small>${preview.bytes} bytes</small></div>`
    if (preview.kind === 'csv' && preview.rows) {
        const [header = [], ...body] = preview.rows
        const th = header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')
        const trs = body.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
        const note = preview.truncated ? `<p class="muted">Showing the first ${CSV_PREVIEW_ROWS} rows.</p>` : ''
        return `${title}<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>${note}`
    }
    if (preview.kind === 'text') {
        const note = preview.truncated ? `<p class="muted">Truncated; download for the rest.</p>` : ''
        return `${title}<pre>${escapeHtml(preview.text ?? '')}</pre>${note}`
    }
    return title
}

function renderArtifacts(view: JobView): string {
    const parts: string[] = []
    for (const kind of ['result', 'log'] as const) {
        const artifact = view.job.artifacts[kind]
        if (!artifact) continue
        const zip = view.zips[kind]
        const heading = `<h4>${kind === 'result' ? 'Results' : 'Logs'} <small>received ${timeTag(artifact.receivedAt)}${zip ? ` · <a href="${escapeHtml(zip)}">encrypted zip</a>` : ''}</small></h4>`
        if (artifact.error) {
            parts.push(`${heading}<p class="error">Could not decrypt: ${escapeHtml(artifact.error)}</p>`)
            continue
        }
        const previews = view.previews[kind] ?? []
        parts.push(
            heading + (previews.length ? previews.map(renderPreview).join('') : '<p class="muted">No files.</p>'),
        )
    }
    return parts.join('')
}

function renderBuild(view: JobView): string {
    const build = view.job.build
    if (!build) return ''
    const state: Record<string, string> = {
        pending: 'waiting for the host builder (it runs inside <code>dev-enclave.ts up</code>)',
        building: 'building the image on the host…',
        done: 'image built',
        failed: '<span class="error">image build failed</span>',
    }
    const buildLog = build.log
        ? `<details><summary>build log</summary><pre>${escapeHtml(build.log)}</pre></details>`
        : ''
    return `<div class="build">Code on <code>${escapeHtml(build.baseImage)}</code>: ${state[build.status] ?? escapeHtml(build.status)}
  <details><summary>main.py</summary><pre>${escapeHtml(build.code)}</pre></details>${buildLog}</div>`
}

/** The stages a job passes through, in order; JOB-PACKAGING only exists for pasted code. */
const PIPELINE = [
    'INITIATED',
    'CODE-APPROVED',
    'JOB-PACKAGING',
    'JOB-READY',
    'JOB-PROVISIONING',
    'JOB-RUNNING',
    'RUN-COMPLETE',
]

/** Segmented bar: one segment per stage, filled up to the furthest stage reached; red once errored. */
function renderProgressBar(job: Job): string {
    const seen = new Set(job.statuses.map((change) => change.status))
    const stages = PIPELINE.filter((stage) => stage !== 'JOB-PACKAGING' || job.build || seen.has('JOB-PACKAGING'))
    const reached = stages.reduce((max, stage, i) => (seen.has(stage) ? i : max), -1)
    const errored = seen.has('JOB-ERRORED') || seen.has('FILES-REJECTED')
    const complete = seen.has('RUN-COMPLETE') || seen.has('FILES-APPROVED')
    const segments = stages
        .map((stage, i) => {
            const state = i > reached ? 'todo' : errored ? 'bad' : i === reached && !complete ? 'current' : 'done'
            return `<i class="${state}" title="${escapeHtml(stage)}"></i>`
        })
        .join('')
    const label = errored ? 'failed' : complete ? 'complete' : `stage ${reached + 1} of ${stages.length}`
    return `<span class="bar" title="${escapeHtml(label)}">${segments}</span>`
}

function renderStatus(job: Job): string {
    const last = job.statuses.at(-1)
    const latest = last?.status ?? '?'
    const latestMessage = [...job.statuses].reverse().find((change) => change.message)?.message
    const now = Date.now()
    const changes = job.statuses
        .map((change, i) => {
            // Time spent in this state: until the next change, or still counting for the current one.
            const next = job.statuses[i + 1]
            const spent = formatDuration((next ? Date.parse(next.at) : now) - Date.parse(change.at))
            const spentTag = `<span class="spent" title="entered ${escapeHtml(change.at)}" data-from="${escapeHtml(change.at)}"${next ? ` data-to="${escapeHtml(next.at)}"` : ''}>${spent}${next ? '' : ' so far'}</span>`
            const message = change.message
                ? `<div class="msg${STATUS_CLASS[change.status] === 'bad' ? ' bad' : ''}">${escapeHtml(change.message)}</div>`
                : ''
            return `<li>${badge(change.status)} ${spentTag}${message}</li>`
        })
        .join('')
    return `<details class="status">
    <summary>${renderProgressBar(job)} ${badge(latest)}${latestMessage ? ` <span class="latest${STATUS_CLASS[latest] === 'bad' ? ' bad' : ''}">${escapeHtml(latestMessage.split('\n')[0] ?? '')}</span>` : ''} ${last ? timeTag(last.at) : ''}</summary>
    <ol class="timeline">${changes}</ol>
  </details>`
}

function renderJob(view: JobView): string {
    const { job } = view
    return `<section class="job" id="job-${escapeHtml(job.jobId)}">
  <header>
    <h3>${escapeHtml(job.title)}</h3>
    <div class="meta"><code>${escapeHtml(job.jobId)}</code> · image <code>${escapeHtml(job.image)}</code> · requested ${timeTag(job.requestedAt)}</div>
  </header>
  ${renderStatus(job)}
  ${renderBuild(view)}
  ${renderArtifacts(view)}
</section>`
}

export function renderPage(model: PageModel): string {
    const sampleButtons = model.samples
        .map(
            (sample) =>
                `<form method="post" action="/jobs" class="inline"><input type="hidden" name="sample" value="${escapeHtml(sample.name)}"><button type="submit" title="${escapeHtml(sample.image)}">Run ${escapeHtml(sample.name)} sample</button> <small>${escapeHtml(sample.description)}</small></form>`,
        )
        .join('')
    const failures = model.authFailures.length
        ? `<section class="warn"><h3>Enclave auth failures (latest ${model.authFailures.length})</h3><ul>${model.authFailures
              .map((f) => `<li>${timeTag(f.at)} <code>${escapeHtml(f.path)}</code> ${escapeHtml(f.reason)}</li>`)
              .join(
                  '',
              )}</ul><p class="muted">setup-app and the trusted-output-app sign their requests with the enclave private key; the stand-in verifies with <code>state/keys/enclave.pub.pem</code>. Restart the stack after regenerating keys.</p></section>`
        : ''
    const jobs = model.jobs.length
        ? model.jobs.map(renderJob).join('')
        : '<p class="muted">No jobs yet. Run a sample above.</p>'
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enclave dev: management app stand-in</title>
<style>
  /* Okabe-Ito palette: blue / vermillion / amber stay distinct for the common colour-vision deficiencies. */
  :root { color-scheme: light dark; --ok: #0072b2; --bad: #d55e00; --busy: #e69f00; --muted: #777; --line: #8884; }
  body { font: 15px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 1100px; padding: 16px; }
  h1 { font-size: 1.4em; margin: 0 0 4px; } h3 { margin: 0; font-size: 1.1em; } h4 { margin: 14px 0 6px; }
  small, .muted { color: var(--muted); } code { font-size: 0.9em; }
  .top { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline; margin-bottom: 12px; }
  .inline { display: inline-block; margin: 4px 12px 4px 0; }
  form.custom input { width: 22em; max-width: 100%; }
  form.code label { display: inline-block; margin: 4px 16px 4px 0; } form.code input { width: 28em; max-width: 100%; }
  form.code textarea { display: block; width: 100%; box-sizing: border-box; font: 13px/1.4 ui-monospace, monospace; margin: 6px 0; }
  .build { margin-top: 10px; font-size: 0.95em; } .build details, section.job details { margin: 4px 0; } summary { cursor: pointer; color: var(--muted); }
  section.job, section.warn, section.trigger { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 12px 0; }
  section.warn { border-color: var(--bad); }
  .meta { color: var(--muted); font-size: 0.9em; margin-top: 2px; }
  .badge { display: inline-block; border-radius: 10px; padding: 0 8px; font-size: 0.8em; border: 1px solid var(--line); vertical-align: middle; }
  .badge.ok { background: var(--ok); color: #fff; border-color: var(--ok); }
  .badge.bad { background: var(--bad); color: #fff; border-color: var(--bad); }
  .badge.busy { background: var(--busy); color: #111; border-color: var(--busy); }
  details.status { margin-top: 10px; }
  details.status summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; list-style: none; }
  details.status summary::-webkit-details-marker { display: none; }
  details.status summary::before { content: '▸'; color: var(--muted); font-size: 0.9em; }
  details.status[open] summary::before { content: '▾'; }
  .bar { display: inline-flex; gap: 2px; width: 14em; max-width: 40vw; height: 10px; vertical-align: middle; }
  .bar i { flex: 1; border-radius: 2px; background: var(--line); }
  .bar i.done { background: var(--ok); }
  /* Stripes, not just colour, mark failure. */
  .bar i.bad { background: repeating-linear-gradient(135deg, var(--bad) 0 3px, #fff6 3px 5px); }
  .bar i.current { background: var(--busy); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .latest { font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 30em; } .latest.bad { color: var(--bad); }
  ol.timeline { list-style: none; padding: 0 0 0 1.2em; margin: 8px 0 0; display: flex; flex-direction: column; gap: 4px; }
  ol.timeline li { font-size: 0.9em; } time { color: var(--muted); font-size: 0.85em; }
  .spent { color: var(--muted); font-size: 0.85em; }
  .msg { white-space: pre-wrap; font-size: 0.9em; max-width: 60em; } .msg.bad { color: var(--bad); }
  table { border-collapse: collapse; margin: 6px 0; max-width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--line); padding: 3px 8px; text-align: left; font-size: 0.9em; }
  pre { background: #8881; padding: 8px; overflow-x: auto; max-height: 24em; font-size: 0.85em; }
  .error { color: var(--bad); }
  #live { font-size: 0.85em; color: var(--muted); }
</style>
</head>
<body>
<div class="top">
  <h1>Management app stand-in</h1>
  <span>member <code>${escapeHtml(model.memberId)}</code></span>
  <span>reviewer key <code title="SHA-256 of the SPKI DER">${escapeHtml(model.reviewerFingerprint.slice(0, 16))}…</code></span>
  <span>JWT ${model.verifyJwt ? 'verified' : '<b>not verified</b>'}</span>
  <span id="live">connecting…</span>
</div>
<section class="trigger">
  <h3>Trigger a job</h3>
  <p class="muted">A job appears in <code>GET /api/studies/ready</code> immediately; setup-app picks it up on its next poll.</p>
  ${sampleButtons || '<p class="muted">No sample images built yet (run <code>dev-enclave.ts up</code>).</p>'}
  <form method="post" action="/jobs" class="custom">
    <input name="image" placeholder="any image, e.g. localhost/enclave-dev/sample-offline:latest" required>
    <input name="title" placeholder="title (optional)">
    <button type="submit">Run custom image</button>
  </form>
</section>
<section class="trigger">
  <h3>Run your own code</h3>
  <p class="muted">Python only. The image is built on the host by <code>dev-enclave.ts up</code> from the base image plus this script
  as <code>main.py</code>; a runner reports <code>JOB-RUNNING</code>, runs it, and uploads every CSV it wrote to the trusted-output-app.</p>
  <form method="post" action="/jobs" class="code" id="code-form">
    <label>base image <input name="baseImage" list="base-images" value="${escapeHtml(model.baseImages[0] ?? 'python:3.12-slim')}" required></label>
    <datalist id="base-images">${model.baseImages.map((image) => `<option value="${escapeHtml(image)}">`).join('')}</datalist>
    <label>title <input name="title" placeholder="custom code"></label>
    <textarea name="code" rows="14" spellcheck="false" required>${escapeHtml(DEFAULT_CODE)}</textarea>
    <button type="submit">Build and run</button>
  </form>
</section>
${failures}
${jobs}
<script>
  (function () {
    var live = document.getElementById('live');
    var timer = null;
    var form = document.getElementById('code-form');
    var fields = ['baseImage', 'title', 'code'];
    // A reload must not eat a half-written script: stash the code form in sessionStorage around it.
    try {
      var saved = JSON.parse(sessionStorage.getItem('code-form') || 'null');
      if (saved) fields.forEach(function (name) { if (saved[name] !== undefined) form.elements[name].value = saved[name]; });
      sessionStorage.removeItem('code-form');
    } catch (e) {}
    form.addEventListener('submit', function () { try { sessionStorage.removeItem('code-form'); } catch (e) {} });
    function reload() {
      var active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.form === form) return;
      clearTimeout(timer);
      timer = setTimeout(function () {
        try {
          var draft = {};
          fields.forEach(function (name) { draft[name] = form.elements[name].value; });
          sessionStorage.setItem('code-form', JSON.stringify(draft));
        } catch (e) {}
        location.reload();
      }, 300);
    }
    // Relative times, refreshed every second; the exact ISO timestamp is in the title attribute.
    function relative(iso) {
      var seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
      if (isNaN(seconds)) return iso;
      if (seconds < 0) return 'in ' + relative(new Date(Date.now() * 2 - Date.parse(iso)).toISOString()).replace(' ago', '');
      if (seconds < 5) return 'just now';
      if (seconds < 60) return seconds + 's ago';
      if (seconds < 120) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's ago';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
      if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm ago';
      return Math.floor(seconds / 86400) + 'd ago';
    }
    function duration(ms) {
      var seconds = Math.max(0, ms) / 1000;
      if (seconds < 10) return seconds.toFixed(1) + 's';
      if (seconds < 60) return Math.round(seconds) + 's';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
      return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    }
    function refreshTimes() {
      var times = document.querySelectorAll('time[datetime]');
      for (var i = 0; i < times.length; i++) times[i].textContent = relative(times[i].getAttribute('datetime'));
      // Time spent in a state: fixed once the next state arrived, counting up for the current one.
      var spent = document.querySelectorAll('.spent[data-from]');
      for (var j = 0; j < spent.length; j++) {
        var from = Date.parse(spent[j].getAttribute('data-from'));
        var to = spent[j].getAttribute('data-to');
        spent[j].textContent = duration((to ? Date.parse(to) : Date.now()) - from) + (to ? '' : ' so far');
      }
    }
    refreshTimes();
    setInterval(refreshTimes, 1000);
    var source = new EventSource('/events');
    source.addEventListener('snapshot', function () { live.textContent = 'live'; });
    source.addEventListener('job', reload);
    source.onerror = function () { live.textContent = 'reconnecting…'; };
  })();
</script>
</body>
</html>
`
}
