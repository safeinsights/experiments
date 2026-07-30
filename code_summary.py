#!/usr/bin/env python3
"""
code_summary.py — a flexible, dependency-free Claude review agent. Drop in CRATE

A Python port of the SafeInsights TypeScript review agent
(management-app/src/server/agents/review-agent/agent.ts). It reviews the code in
the current directory and prints a structured report, forced through a single
submit_analysis tool call.

Run it with no arguments:

    cd <the submission directory> && python3 /path/to/code_summary.py

The only two things that can be overridden are the prompts:

    --system STRING | --system-file FILE      replace the system instruction
    --template STRING | --template-file FILE  replace the analysis template

Everything else — model, token cap, retries, tool schema, file limits — is a
constant at the top of this file, so a run is reproducible from the file alone.

File selection mirrors the management app, where the researcher never lists
files: the workspace directory *is* the submission. The scan is a flat,
non-recursive listing of the working directory, mirroring
listWorkspaceFilesAction. Skipped, each logged with its reason: dotfiles,
symlinks, subdirectories, empty files, this script, any file passed as
--system-file / --template-file, anything over 100,000 bytes (the app's
MAX_FILE_SIZE_BYTES), anything beyond the first 10 files (MAX_FILE_COUNT), and
binary / non-UTF-8 files. The main code file is the one whose basename is 'main'
(any extension), or the sole file when there is only one.

The API key comes from ~/.claude/settings.json — the "apiKeyHelper": "echo <key>"
field, unwrapped textually (a helper that is any other command is reported, not
executed). $ANTHROPIC_API_KEY is never consulted, so a stale exported key cannot
silently change which credential a run uses. Which field supplied the key is
logged; the key itself is never logged or printed, only a redacted fingerprint.

The structured result is printed as JSON to stdout; all logging goes to stderr.

Stdlib only (argparse, json, os, sys, time, re, urllib) — no pip/jq/httr needed.

Exit codes:
  0  success
  1  bad arguments / missing API key / bad input files
  2  API or network error (after retries)
  3  model refused (stop_reason == "refusal")
  4  response truncated (stop_reason == "max_tokens")
  5  no submit_analysis tool_use block in the response
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5")
DEFAULT_MAX_TOKENS = 16_000
DEFAULT_MAX_RETRIES = 3

# Both mirror review-agent/runner.ts: MAX_FILE_SIZE_BYTES and MAX_FILE_COUNT.
DEFAULT_MAX_FILE_BYTES = 100_000
DEFAULT_MAX_FILE_COUNT = 10

# The submission is the directory the script runs in, as the workspace is in the
# management app. Reviewing somewhere else means cd-ing there.
SCAN_DIR = "."

SETTINGS_FILE = os.path.expanduser("~/.claude/settings.json")

# runner.ts's PLACEHOLDER, for the sections this script has no source for.
PLACEHOLDER = "(none provided)"

# Retry these transient HTTP statuses; anything else 4xx fails fast.
RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}

# ---------------------------------------------------------------------------
# Built-in preset (faithful-enough default; every piece is overridable)
# ---------------------------------------------------------------------------

DEFAULT_SYSTEM_INSTRUCTION = (
    "You are a strict and meticulous Code & Compliance Auditor for an education "
    "research Data Partner. You analyze a researcher's submission (their proposal, "
    "their code, and any test results) against the provided reference/compliance "
    "documents governing the handling of student and school data. You are precise, "
    "cite specific file paths, and never invent facts. When something cannot be "
    "verified from the provided material, you say so explicitly."
)

DEFAULT_ANALYSIS_TEMPLATE = """\
Review the following research submission and return your analysis via the
submit_analysis tool.

## Proposal
{{proposal}}

## Code
{{code}}

## Reference / Compliance Documents
{{reference_docs}}

## Researcher-Provided Results / Study Output
{{study_output}}

Analyze: summarize the proposal; explain what the code does (referencing file
paths); summarize the results if present; check whether the code aligns with the
proposal; and check compliance against the reference documents.
"""

DEFAULT_TOOL_NAME = "submit_analysis"

DEFAULT_TOOL_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "proposalSummary": {
            "type": "string",
            "description": "Summary of the researcher's proposal (~80 words).",
        },
        "codeExplanation": {
            "type": "string",
            "description": "What the code does, referencing file paths (~300 words).",
        },
        "resultsSummary": {
            "type": "string",
            "description": "Summary of the study output/results (~150 words); "
            "empty string if none provided.",
        },
        "alignmentCheck": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "isAligned": {"type": "boolean"},
                "findings": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": 10,
                },
            },
            "required": ["isAligned", "findings"],
        },
        "complianceCheck": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "isCompliant": {"type": "boolean"},
                "findings": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": 10,
                },
            },
            "required": ["isCompliant", "findings"],
        },
    },
    "required": [
        "proposalSummary",
        "codeExplanation",
        "resultsSummary",
        "alignmentCheck",
        "complianceCheck",
    ],
}

def log(msg):
    """Progress logging to stderr so stdout stays clean."""
    print(">> " + msg, file=sys.stderr, flush=True)


def die(code, msg):
    print("ERROR: " + msg, file=sys.stderr, flush=True)
    sys.exit(code)


# ---------------------------------------------------------------------------
# File gathering: mirror the management app's workspace listing
#
# listWorkspaceFilesAction (server/actions/workspaces.actions.ts) does a flat,
# non-recursive readdir of the study's workspace directory and drops dotfiles,
# symlinks, non-files and empty files — with no extension filter. Everything it
# returns is submitted (useIDEFiles), and review-agent/runner.ts then caps the
# set at MAX_FILE_COUNT files of at most MAX_FILE_SIZE_BYTES each.
# ---------------------------------------------------------------------------

def _load_text(abspath):
    """Read a file as text, returning (text, None) or (None, reason-to-skip).

    The binary / non-UTF-8 guards have no counterpart in the TypeScript, which
    calls blob.text() unconditionally and would ship mojibake for e.g. a
    .RData; the divergence is deliberate."""
    try:
        with open(abspath, "rb") as fh:
            raw = fh.read()
    except OSError as e:
        return None, "read-error: %s" % e
    if b"\x00" in raw:
        return None, "binary"
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        return None, "non-utf8"


def _is_main_file(name):
    """isMainFile analog: basename (sans extension) is exactly 'main'."""
    return os.path.splitext(name)[0].lower() == "main"


def _order_files(names, main_file):
    """filterAndOrderCodeFiles analog: MAIN-CODE first, then the rest by name.

    Ordering happens before the file-count cap so the main file can never be
    the row that gets cut. runner.ts orders by the study_job_file_type Postgres
    enum descending, which actually puts SUPPLEMENTAL-CODE first and can drop
    MAIN-CODE at more than MAX_FILE_COUNT supplementals — not reproduced."""
    rest = sorted((n for n in names if n != main_file), key=lambda n: n.lower())
    return ([main_file] if main_file else []) + rest


def gather_files(directory, max_bytes, max_count, excluded_paths=None):
    """Scan one directory and return (files, skipped, main_file).

    `files` is an ordered {filename: contents} dict keyed on bare filenames, as
    `codeFiles` is keyed on studyJobFile.name. `skipped` is a list of
    (name, reason) for every rejected entry, so nothing drops out silently.
    `excluded_paths` maps a realpath to the reason it is not researcher code —
    this script, and any prompt file passed on the command line."""
    excluded = {os.path.realpath(__file__): "self (the review script)"}
    excluded.update(excluded_paths or {})
    skipped = []

    try:
        entries = sorted(os.listdir(directory), key=lambda n: n.lower())
    except OSError as e:
        die(1, "Cannot scan directory '%s': %s" % (directory, e))

    # Pass 1: apply the workspace-listing rules, cheapest checks first.
    candidates = []
    for name in entries:
        path = os.path.join(directory, name)
        if name.startswith("."):
            skipped.append((name, "dotfile"))
            continue
        try:
            st = os.lstat(path)
        except OSError as e:
            skipped.append((name, "stat-error: %s" % e))
            continue
        if os.path.islink(path):
            skipped.append((name, "symlink"))
            continue
        if os.path.isdir(path):
            skipped.append((name, "directory"))
            continue
        if not os.path.isfile(path):
            skipped.append((name, "not a regular file"))
            continue
        if st.st_size == 0:
            skipped.append((name, "empty file"))
            continue
        excluded_reason = excluded.get(os.path.realpath(path))
        if excluded_reason:
            skipped.append((name, excluded_reason))
            continue
        if st.st_size > max_bytes:
            skipped.append((name, "too-large (%d bytes > %d)"
                            % (st.st_size, max_bytes)))
            continue
        candidates.append(name)

    # Pass 2: designate the main file, mirroring useIDEFiles' derivation —
    # a file named main.*, else the sole file when there is only one.
    main_file = next((n for n in candidates if _is_main_file(n)), None)
    if main_file is None and len(candidates) == 1:
        main_file = candidates[0]

    # Pass 3: order, cap, then read. Reading last means the cap is spent on
    # files we actually send, unlike runner.ts (which LIMITs before sizing).
    ordered = _order_files(candidates, main_file)
    for name in ordered[max_count:]:
        skipped.append((name, "beyond the %d-file limit" % max_count))
    ordered = ordered[:max_count]

    files = {}
    for name in ordered:
        text, reason = _load_text(os.path.join(directory, name))
        if reason is not None:
            skipped.append((name, reason))
            if name == main_file:
                main_file = None
            continue
        files[name] = text

    skipped.sort(key=lambda pair: pair[0].lower())
    return files, skipped, main_file


def log_manifest(directory, files, skipped, main_file, max_bytes, max_count):
    """Log exactly what will be uploaded, and why everything else was not."""
    log("Scanning %s for submission files (max %d files, max %d bytes each)"
        % (os.path.abspath(directory), max_count, max_bytes))

    total = sum(len(t.encode("utf-8")) for t in files.values())
    log("Will upload %d file(s), %d bytes total:" % (len(files), total))
    if not files:
        log("  (none)")
    if files and not main_file:
        log("  %-15s (none — no file named main.*)" % "[main]")
    width = max((len(n) for n in files), default=0)
    sizes = {n: len(t.encode("utf-8")) for n, t in files.items()}
    size_width = max((len("%d" % s) for s in sizes.values()), default=0)
    for name in files:
        role = "[main]" if name == main_file else "[supplemental]"
        log("  %-15s %-*s %*d B"
            % (role, width, name, size_width, sizes[name]))

    if skipped:
        log("Skipped %d entry(ies):" % len(skipped))
        width = max(len(n) for n, _ in skipped)
        for name, reason in skipped:
            log("  - %-*s  %s" % (width, name, reason))


def format_code_files(files):
    """formatCodeFiles analog (agent.ts): one fence per file, path as the info
    string, in insertion order — MAIN-CODE first, then supplementals."""
    if not files:
        return "(no files provided)"
    return "\n\n".join(
        "```" + name + "\n" + contents + "\n```"
        for name, contents in files.items()
    )


# ---------------------------------------------------------------------------
# Prompt assembly: single-pass placeholder substitution (injection-safe)
# ---------------------------------------------------------------------------

def fill_template(template, values):
    """Replace every {{key}} in one pass. Unknown/absent keys become an empty
    section (with a stderr warning). User-supplied values are inserted verbatim
    and are NOT re-scanned for further placeholders."""
    used = set()

    def repl(m):
        key = m.group(1)
        used.add(key)
        if key in values and values[key] is not None:
            return str(values[key])
        log("warning: template placeholder {{%s}} has no value; using empty." % key)
        return ""

    result = re.sub(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}", repl, template)
    for key in values:
        if key not in used:
            log("note: input '%s' provided but not referenced by the template." % key)
    return result


# ---------------------------------------------------------------------------
# Anthropic API call with retry/backoff
# ---------------------------------------------------------------------------

def call_anthropic(api_key, body, max_retries):
    data = json.dumps(body).encode("utf-8")
    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }
    attempt = 0
    while True:
        attempt += 1
        req = urllib.request.Request(API_URL, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = _read_err(e)
            status = e.code
            if status in RETRYABLE_STATUS and attempt <= max_retries:
                delay = _backoff(attempt)
                log("API HTTP %d (attempt %d/%d); retrying in %.1fs: %s"
                    % (status, attempt, max_retries + 1, delay, detail))
                time.sleep(delay)
                continue
            die(2, "Anthropic API HTTP %d: %s" % (status, detail))
        except urllib.error.URLError as e:
            if attempt <= max_retries:
                delay = _backoff(attempt)
                log("Network error (attempt %d/%d); retrying in %.1fs: %s"
                    % (attempt, max_retries + 1, delay, e.reason))
                time.sleep(delay)
                continue
            die(2, "Network error contacting Anthropic API: %s" % e.reason)


def _backoff(attempt):
    # Exponential: ~1s, 2s, 4s ... capped. Deterministic (no random needed).
    return min(2.0 ** (attempt - 1), 30.0)


def _read_err(e):
    try:
        return e.read().decode("utf-8", "replace")
    except Exception:
        return str(e)


# ---------------------------------------------------------------------------
# Response handling
# ---------------------------------------------------------------------------

def extract_result(resp, tool_name):
    stop = resp.get("stop_reason")
    if stop == "refusal":
        die(3, "Model refused to respond (stop_reason=refusal).")
    if stop == "max_tokens":
        die(4, "Response truncated (stop_reason=max_tokens); raise "
               "DEFAULT_MAX_TOKENS.")

    for b in resp.get("content", []) or []:
        if b.get("type") == "tool_use" and b.get("name") == tool_name:
            return json.dumps(b.get("input", {}), indent=2, ensure_ascii=False)
    die(5, "No tool_use block named '%s' found in response (stop_reason=%s)."
        % (tool_name, stop))


# ---------------------------------------------------------------------------
# API key resolution: --api-key, then $ANTHROPIC_API_KEY, then settings.json
#
# Every step is logged so a wrong-source run is diagnosable, but the key itself
# is only ever logged through fingerprint() — a redacted prefix plus a length.
# ---------------------------------------------------------------------------

# Fields checked in settings.json, in order. apiKeyHelper is normally a shell
# command that prints the key; the literal "echo <key>" form is unwrapped
# textually rather than executed, so a config file can't run commands here.
SETTINGS_KEY_FIELDS = ("env.ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "apiKeyHelper")


def fingerprint(key):
    """Redacted identifier for a secret: leading prefix + length, never the key.

    Enough to confirm the right credential was picked up without writing a
    usable secret into a terminal scrollback or a CI log."""
    head = key.split("-")[0] if "-" in key else key[:3]
    return "%s-…, %d chars" % (head, len(key))


def _unwrap_api_key_helper(value):
    """'echo sk-ant-…' -> 'sk-ant-…'. Returns None for any other command."""
    stripped = value.strip()
    if not stripped.startswith("echo "):
        return None
    return stripped[len("echo "):].strip().strip("'\"") or None


def load_api_key_from_settings(path):
    """Pull the API key out of a Claude settings.json. Returns (key, source) or
    (None, reason-it-was-not-found) — never raises."""
    log("Reading %s ..." % path)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            settings = json.load(fh)
    except FileNotFoundError:
        return None, "settings file not found: %s" % path
    except OSError as e:
        return None, "cannot read settings file: %s" % e
    except json.JSONDecodeError as e:
        return None, "settings file is not valid JSON: %s" % e

    if not isinstance(settings, dict):
        return None, "settings file is not a JSON object"

    env = settings.get("env")
    candidates = [
        ("env.ANTHROPIC_API_KEY", env.get("ANTHROPIC_API_KEY")
         if isinstance(env, dict) else None),
        ("ANTHROPIC_API_KEY", settings.get("ANTHROPIC_API_KEY")),
    ]
    for field, value in candidates:
        if isinstance(value, str) and value.strip():
            return value.strip(), "settings.json field %s" % field

    helper = settings.get("apiKeyHelper")
    if isinstance(helper, str) and helper.strip():
        key = _unwrap_api_key_helper(helper)
        if key:
            return key, "settings.json field apiKeyHelper"
        return None, ("settings.json apiKeyHelper is a command, not an "
                      "'echo <key>' literal; run it yourself and export "
                      "ANTHROPIC_API_KEY, or pass --api-key")

    return None, ("settings.json has no API key (checked %s)"
                  % ", ".join(SETTINGS_KEY_FIELDS))


def resolve_api_key():
    """Read the key from the settings file, logging each step.

    $ANTHROPIC_API_KEY is deliberately NOT consulted: the settings file is the
    single source of truth, so a stale exported key in one shell can't silently
    send a run under different credentials than the next shell's."""
    log("Resolving API key from the settings file (the environment is not consulted).")
    key, detail = load_api_key_from_settings(SETTINGS_FILE)
    if key:
        log("API key found at %s (%s)." % (detail, fingerprint(key)))
        return key

    log("API key not resolved: %s" % detail)
    die(1, "No API key in %s — expected {\"apiKeyHelper\": \"echo <key>\"}."
        % SETTINGS_FILE)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def read_file(path, label):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError as e:
        die(1, "Cannot read %s '%s': %s" % (label, path, e))


def build_arg_parser():
    """Only the two prompt overrides are configurable. Everything else — the
    model, the caps, the tool schema, the scanned directory, the API key source
    — is a constant at the top of this file, so a run is reproducible from the
    file alone rather than from someone's shell history."""
    p = argparse.ArgumentParser(
        prog="code_summary.py",
        description="Claude review agent: reviews the code files in the current "
                    "directory and prints a submit_analysis JSON report.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--system", metavar="STRING",
                   help="System prompt, replacing the built-in default.")
    p.add_argument("--system-file", metavar="FILE",
                   help="Read the system prompt from a file.")
    p.add_argument("--template", metavar="STRING",
                   help="Analysis prompt template with {{placeholders}}, "
                        "replacing the built-in default.")
    p.add_argument("--template-file", metavar="FILE",
                   help="Read the analysis prompt template from a file.")
    return p


def main(argv):
    args = build_arg_parser().parse_args(argv)

    # A prompt file living in the scanned directory is this tool's own input, not
    # researcher code — don't feed it back in as something to review.
    excluded = {}
    for flag, path in (("--system-file", args.system_file),
                       ("--template-file", args.template_file)):
        if path:
            excluded[os.path.realpath(path)] = "prompt file (%s)" % flag

    # Gather files for {{code}} — the directory is the submission, as in the
    # management app. Logged before anything else happens, so every run leaves a
    # record of exactly what was sent.
    files, skipped, main_file = gather_files(
        SCAN_DIR, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_COUNT, excluded)
    log_manifest(SCAN_DIR, files, skipped, main_file,
                 DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_COUNT)

    # The two overridable pieces.
    system = args.system
    if args.system_file:
        system = read_file(args.system_file, "system-file")
    if system is None:
        system = DEFAULT_SYSTEM_INSTRUCTION

    template = args.template
    if args.template_file:
        template = read_file(args.template_file, "template-file")
    if template is None:
        template = DEFAULT_ANALYSIS_TEMPLATE

    # {{code}} is the only value this script can supply; the app's other inputs
    # (proposal, reference docs, study output) come from its database, so they
    # render as runner.ts's PLACEHOLDER here rather than as empty sections.
    values = {
        "code": format_code_files(files),
        "proposal": PLACEHOLDER,
        "reference_docs": PLACEHOLDER,
        "study_output": PLACEHOLDER,
    }
    prompt = fill_template(template, values)

    messages = [{"role": "user", "content": prompt}]
    body = {
        "model": MODEL,
        "max_tokens": DEFAULT_MAX_TOKENS,
        "system": system,
        "messages": messages,
        "tools": [{"name": DEFAULT_TOOL_NAME,
                   "input_schema": DEFAULT_TOOL_SCHEMA}],
        "tool_choice": {"type": "tool", "name": DEFAULT_TOOL_NAME},
    }

    api_key = resolve_api_key()

    log("Calling Anthropic API (model=%s) ..." % MODEL)
    resp = call_anthropic(api_key, body, DEFAULT_MAX_RETRIES)

    usage = resp.get("usage", {})
    log("Done (stop_reason=%s, in=%s, out=%s tokens)."
        % (resp.get("stop_reason"), usage.get("input_tokens"),
           usage.get("output_tokens")))

    print(extract_result(resp, DEFAULT_TOOL_NAME))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
