#!/usr/bin/env python3
"""
code_summary.py — a flexible, dependency-free Claude review agent. Drop in CRATE

A Python port of the SafeInsights TypeScript review agent
(management-app/src/server/agents/review-agent/agent.ts). It calls the Anthropic
Claude API using the ANTHROPIC_API_KEY in the environment and offers the same
flexibility: overridable model, max-tokens, retries, system prompt, additional
context, a {{placeholder}} prompt template, and forced *structured* output via a
single strict tool (default: submit_analysis).

The files to review must be named explicitly with --include (repeatable) and/or
--include-from FILE ('-' means stdin), so it composes with find, e.g.:

    # Print out the key
    cat ~/.claude/settings.json
    # grab the API key from the file (REMEMBER: ignore the word "echo")
    export ANTHROPIC_API_KEY=<that-key-you-copied>

    find . -name '*.R' -name '*.md' | python3 ./code_summary.py --include-from -

The structured result is printed as JSON to stdout; all logging goes to stderr.

Stdlib only (argparse, json, os, sys, time, re, urllib) — no pip/jq/httr needed.

Exit codes:
  0  success
  1  bad arguments / missing API key / bad input files
  2  API or network error (after retries)
  3  model refused (stop_reason == "refusal")
  4  response truncated (stop_reason == "max_tokens")
  5  no tool_use block returned in structured mode
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

DEFAULT_MODEL = "claude-haiku-4-5"
DEFAULT_MAX_TOKENS = 16_000
DEFAULT_MAX_RETRIES = 3
DEFAULT_MAX_FILE_BYTES = 256 * 1024

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

# Map file extension -> markdown fence language hint.
LANG_BY_EXT = {
    ".r": "r", ".R": "r", ".py": "python", ".sh": "bash", ".sql": "sql",
    ".json": "json", ".md": "markdown", ".txt": "text", ".csv": "csv",
    ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".ts": "typescript",
    ".js": "javascript", ".dockerfile": "dockerfile",
}


def log(msg):
    """Progress logging to stderr so stdout stays clean."""
    print(">> " + msg, file=sys.stderr, flush=True)


def die(code, msg):
    print("ERROR: " + msg, file=sys.stderr, flush=True)
    sys.exit(code)


# ---------------------------------------------------------------------------
# File gathering: load the explicitly named files (no directory walk)
# ---------------------------------------------------------------------------

def _rel(abspath):
    """Display path: relative to cwd when under it, else the absolute path."""
    try:
        rel = os.path.relpath(abspath)
    except ValueError:  # different drive on Windows
        return abspath
    return rel if not rel.startswith("..") else abspath


def _load_text(abspath, max_bytes):
    """Read a text file, returning (text, None) or (None, reason-to-skip)."""
    try:
        size = os.path.getsize(abspath)
    except OSError as e:
        return None, "stat-error: %s" % e
    if size > max_bytes:
        return None, "too-large (%d bytes)" % size
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


def gather_files(includes, max_bytes):
    """Return ({relpath: contents}, skipped) for the explicitly named files.

    Files that are missing, binary, non-utf8, or larger than max_bytes are
    skipped with a note. No directory walking happens — the caller must name
    every file (via --include / --include-from)."""
    files = {}
    skipped = []
    for p in includes:
        abspath = os.path.abspath(p)
        rel = _rel(abspath)
        if not os.path.isfile(abspath):
            skipped.append((rel, "not a file"))
            continue
        text, reason = _load_text(abspath, max_bytes)
        if reason is not None:
            skipped.append((rel, reason))
            continue
        files[rel] = text
    return files, skipped


def read_path_list(spec):
    """Read newline-separated paths from a file; '-' means stdin. Blank lines
    are dropped. Returns a list of paths."""
    if spec == "-":
        raw = sys.stdin.read()
    else:
        try:
            with open(spec, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except OSError as e:
            die(1, "Cannot read path-list '%s': %s" % (spec, e))
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if line:
            out.append(line)
    return out


def format_code_files(files):
    """formatCodeFiles analog: fenced markdown blocks in sorted path order."""
    if not files:
        return "(no files provided)"
    parts = []
    for relpath in sorted(files):
        _, ext = os.path.splitext(relpath)
        lang = LANG_BY_EXT.get(ext, LANG_BY_EXT.get(ext.lower(), ""))
        if relpath.lower().endswith("dockerfile") or relpath == "Dockerfile":
            lang = "dockerfile"
        parts.append("### %s\n```%s\n%s\n```" % (relpath, lang, files[relpath]))
    return "\n\n".join(parts)


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

def extract_result(resp, structured, tool_name):
    stop = resp.get("stop_reason")
    if stop == "refusal":
        die(3, "Model refused to respond (stop_reason=refusal).")
    if stop == "max_tokens":
        die(4, "Response truncated (stop_reason=max_tokens); raise --max-tokens.")

    blocks = resp.get("content", []) or []
    if structured:
        for b in blocks:
            if b.get("type") == "tool_use" and b.get("name") == tool_name:
                return json.dumps(b.get("input", {}), indent=2, ensure_ascii=False)
        die(5, "No tool_use block named '%s' found in response (stop_reason=%s)."
            % (tool_name, stop))
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    return text


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def read_file(path, label):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError as e:
        die(1, "Cannot read %s '%s': %s" % (label, path, e))


def parse_kv(pairs, is_file, label):
    out = {}
    for item in pairs or []:
        if "=" not in item:
            die(1, "--%s expects NAME=%s, got: %s"
                % (label, "PATH" if is_file else "STRING", item))
        name, val = item.split("=", 1)
        name = name.strip()
        if not re.match(r"^[A-Za-z0-9_]+$", name):
            die(1, "Invalid input name '%s' (letters/digits/underscore only)." % name)
        out[name] = read_file(val, "input file") if is_file else val
    return out


def build_arg_parser():
    p = argparse.ArgumentParser(
        prog="code_summary.py",
        description="Flexible Claude review agent (structured output by default).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    # Auth / model
    p.add_argument("--api-key", default=None,
                   help="Anthropic API key (default: $ANTHROPIC_API_KEY).")
    p.add_argument("--model", default=os.environ.get("ANTHROPIC_MODEL", DEFAULT_MODEL),
                   help="Model id (default: $ANTHROPIC_MODEL or built-in).")
    p.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    p.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES)
    p.add_argument("--temperature", type=float, default=None,
                   help="Optional; omitted from the request when unset.")
    # Prompt configuration
    p.add_argument("--system", help="System prompt string (overrides default preset).")
    p.add_argument("--system-file", help="Read system prompt from a file.")
    p.add_argument("--context", help="Additional context appended to the system prompt.")
    p.add_argument("--context-file", help="Read additional context from a file.")
    p.add_argument("--template", help="Analysis prompt template with {{placeholders}}.")
    p.add_argument("--template-file", help="Read the template from a file.")
    # Structured output
    p.add_argument("--tool-schema", help="JSON file with a tool input_schema "
                   "(overrides the default submit_analysis schema).")
    p.add_argument("--tool-name", default=DEFAULT_TOOL_NAME)
    p.add_argument("--no-tool", action="store_true",
                   help="Free-form text output instead of a forced tool call.")
    # Inputs / file gathering (files must be named explicitly)
    p.add_argument("--include", action="append", default=[], metavar="FILE",
                   help="File to review (repeatable). Fills {{code}}.")
    p.add_argument("--include-from", metavar="FILE",
                   help="Read newline-separated files to review; '-' means stdin. "
                        "Composes with find, e.g. `find . -name '*.R' | ... "
                        "--include-from -`.")
    p.add_argument("--max-file-bytes", type=int, default=DEFAULT_MAX_FILE_BYTES)
    p.add_argument("--proposal", help="File whose contents fill {{proposal}}.")
    p.add_argument("--reference-doc", action="append", default=[],
                   help="File appended to {{reference_docs}} (repeatable).")
    p.add_argument("--study-output", help="File whose contents fill {{study_output}}.")
    p.add_argument("--input", action="append", default=[], metavar="NAME=PATH",
                   help="Extra template value from a file (repeatable).")
    p.add_argument("--input-text", action="append", default=[], metavar="NAME=STRING",
                   help="Extra template value from a literal string (repeatable).")
    # Output / debugging
    p.add_argument("--save-response", help="Write the full raw API response JSON here.")
    p.add_argument("--messages-out", help="Write the request messages array here.")
    p.add_argument("--print-request", action="store_true",
                   help="Assemble and print the request to stderr, then exit (no API call).")
    return p


def main(argv):
    args = build_arg_parser().parse_args(argv)

    if args.api_key is None:
        args.api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not args.api_key:
        die(1, "Missing ANTHROPIC_API_KEY (set the env var or pass --api-key). You might have to set it yourself. It might be in ~/.claude/settings.json")
    if args.max_tokens <= 0:
        die(1, "--max-tokens must be positive.")
    if args.max_retries < 0:
        die(1, "--max-retries must be >= 0.")

    structured = not args.no_tool

    # System prompt (+ additional context).
    system = args.system
    if args.system_file:
        system = read_file(args.system_file, "system-file")
    if system is None:
        system = DEFAULT_SYSTEM_INSTRUCTION
    context = args.context
    if args.context_file:
        context = read_file(args.context_file, "context-file")
    if context:
        system = system + "\n\n" + context

    # Template.
    template = args.template
    if args.template_file:
        template = read_file(args.template_file, "template-file")
    if template is None:
        template = DEFAULT_ANALYSIS_TEMPLATE

    # Tool schema (structured mode).
    tool_schema = DEFAULT_TOOL_SCHEMA
    if args.tool_schema:
        raw = read_file(args.tool_schema, "tool-schema")
        try:
            tool_schema = json.loads(raw)
        except json.JSONDecodeError as e:
            die(1, "--tool-schema is not valid JSON: %s" % e)

    # Gather files for {{code}} — named explicitly via --include / --include-from.
    includes = list(args.include)
    if args.include_from:
        includes += read_path_list(args.include_from)
    if not includes:
        die(1, "No files to review: pass --include FILE and/or --include-from FILE "
               "('-' for stdin), e.g. `find . -name '*.R' | %s --include-from -`."
               % os.path.basename(sys.argv[0]))
    files, skipped = gather_files(includes, args.max_file_bytes)
    log("Gathered %d file(s) (skipped %d)." % (len(files), len(skipped)))
    for rel in sorted(files):
        log("  + %s" % rel)
    for rel, why in skipped:
        log("  - %s (%s)" % (rel, why))

    # Named template values.
    values = {"code": format_code_files(files)}

    if args.proposal:
        values["proposal"] = read_file(args.proposal, "proposal")

    ref_parts = [read_file(p, "reference-doc") for p in args.reference_doc]
    if ref_parts:
        values["reference_docs"] = "\n\n".join(ref_parts)

    if args.study_output:
        values["study_output"] = read_file(args.study_output, "study-output")

    values.update(parse_kv(args.input, True, "input"))
    values.update(parse_kv(args.input_text, False, "input-text"))

    prompt = fill_template(template, values)

    messages = [{"role": "user", "content": prompt}]
    body = {
        "model": args.model,
        "max_tokens": args.max_tokens,
        "system": system,
        "messages": messages,
    }
    if args.temperature is not None:
        body["temperature"] = args.temperature
    if structured:
        tool = {"name": args.tool_name, "input_schema": tool_schema}
        body["tools"] = [tool]
        body["tool_choice"] = {"type": "tool", "name": args.tool_name}

    if args.messages_out:
        with open(args.messages_out, "w", encoding="utf-8") as fh:
            json.dump(messages, fh, indent=2, ensure_ascii=False)
        log("Wrote request messages to %s" % args.messages_out)

    if args.print_request:
        log("---- SYSTEM ----")
        print(system, file=sys.stderr)
        log("---- USER PROMPT ----")
        print(prompt, file=sys.stderr)
        if structured:
            log("---- TOOL (%s) ----" % args.tool_name)
            print(json.dumps(tool_schema, indent=2), file=sys.stderr)
        log("Model=%s max_tokens=%d retries=%d temperature=%s structured=%s"
            % (args.model, args.max_tokens, args.max_retries,
               args.temperature, structured))
        log("--print-request set; not calling the API.")
        return 0

    log("Calling Anthropic API (model=%s, structured=%s) ..."
        % (args.model, structured))
    resp = call_anthropic(args.api_key, body, args.max_retries)

    if args.save_response:
        with open(args.save_response, "w", encoding="utf-8") as fh:
            json.dump(resp, fh, indent=2, ensure_ascii=False)
        log("Wrote raw response to %s" % args.save_response)

    usage = resp.get("usage", {})
    log("Done (stop_reason=%s, in=%s, out=%s tokens)."
        % (resp.get("stop_reason"), usage.get("input_tokens"),
           usage.get("output_tokens")))

    print(extract_result(resp, structured, args.tool_name))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))#!/usr/bin/env python3
"""
code_summary.py — a flexible, dependency-free Claude review agent. Drop in CRATE

A Python port of the SafeInsights TypeScript review agent
(management-app/src/server/agents/review-agent/agent.ts). It calls the Anthropic
Claude API using the ANTHROPIC_API_KEY in the environment and offers the same
flexibility: overridable model, max-tokens, retries, system prompt, additional
context, a {{placeholder}} prompt template, and forced *structured* output via a
single strict tool (default: submit_analysis).

The files to review must be named explicitly with --include (repeatable) and/or
--include-from FILE ('-' means stdin), so it composes with find, e.g.:

    find . -name '*.R' | ./code_summary.py --include-from -

The structured result is printed as JSON to stdout; all logging goes to stderr.

Stdlib only (argparse, json, os, sys, time, re, urllib) — no pip/jq/httr needed.

Exit codes:
  0  success
  1  bad arguments / missing API key / bad input files
  2  API or network error (after retries)
  3  model refused (stop_reason == "refusal")
  4  response truncated (stop_reason == "max_tokens")
  5  no tool_use block returned in structured mode
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

DEFAULT_MODEL = "claude-haiku-4-5"
DEFAULT_MAX_TOKENS = 16_000
DEFAULT_MAX_RETRIES = 3
DEFAULT_MAX_FILE_BYTES = 256 * 1024

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

# Map file extension -> markdown fence language hint.
LANG_BY_EXT = {
    ".r": "r", ".R": "r", ".py": "python", ".sh": "bash", ".sql": "sql",
    ".json": "json", ".md": "markdown", ".txt": "text", ".csv": "csv",
    ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".ts": "typescript",
    ".js": "javascript", ".dockerfile": "dockerfile",
}


def log(msg):
    """Progress logging to stderr so stdout stays clean."""
    print(">> " + msg, file=sys.stderr, flush=True)


def die(code, msg):
    print("ERROR: " + msg, file=sys.stderr, flush=True)
    sys.exit(code)


# ---------------------------------------------------------------------------
# File gathering: load the explicitly named files (no directory walk)
# ---------------------------------------------------------------------------

def _rel(abspath):
    """Display path: relative to cwd when under it, else the absolute path."""
    try:
        rel = os.path.relpath(abspath)
    except ValueError:  # different drive on Windows
        return abspath
    return rel if not rel.startswith("..") else abspath


def _load_text(abspath, max_bytes):
    """Read a text file, returning (text, None) or (None, reason-to-skip)."""
    try:
        size = os.path.getsize(abspath)
    except OSError as e:
        return None, "stat-error: %s" % e
    if size > max_bytes:
        return None, "too-large (%d bytes)" % size
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


def gather_files(includes, max_bytes):
    """Return ({relpath: contents}, skipped) for the explicitly named files.

    Files that are missing, binary, non-utf8, or larger than max_bytes are
    skipped with a note. No directory walking happens — the caller must name
    every file (via --include / --include-from)."""
    files = {}
    skipped = []
    for p in includes:
        abspath = os.path.abspath(p)
        rel = _rel(abspath)
        if not os.path.isfile(abspath):
            skipped.append((rel, "not a file"))
            continue
        text, reason = _load_text(abspath, max_bytes)
        if reason is not None:
            skipped.append((rel, reason))
            continue
        files[rel] = text
    return files, skipped


def read_path_list(spec):
    """Read newline-separated paths from a file; '-' means stdin. Blank lines
    are dropped. Returns a list of paths."""
    if spec == "-":
        raw = sys.stdin.read()
    else:
        try:
            with open(spec, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except OSError as e:
            die(1, "Cannot read path-list '%s': %s" % (spec, e))
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if line:
            out.append(line)
    return out


def format_code_files(files):
    """formatCodeFiles analog: fenced markdown blocks in sorted path order."""
    if not files:
        return "(no files provided)"
    parts = []
    for relpath in sorted(files):
        _, ext = os.path.splitext(relpath)
        lang = LANG_BY_EXT.get(ext, LANG_BY_EXT.get(ext.lower(), ""))
        if relpath.lower().endswith("dockerfile") or relpath == "Dockerfile":
            lang = "dockerfile"
        parts.append("### %s\n```%s\n%s\n```" % (relpath, lang, files[relpath]))
    return "\n\n".join(parts)


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

def extract_result(resp, structured, tool_name):
    stop = resp.get("stop_reason")
    if stop == "refusal":
        die(3, "Model refused to respond (stop_reason=refusal).")
    if stop == "max_tokens":
        die(4, "Response truncated (stop_reason=max_tokens); raise --max-tokens.")

    blocks = resp.get("content", []) or []
    if structured:
        for b in blocks:
            if b.get("type") == "tool_use" and b.get("name") == tool_name:
                return json.dumps(b.get("input", {}), indent=2, ensure_ascii=False)
        die(5, "No tool_use block named '%s' found in response (stop_reason=%s)."
            % (tool_name, stop))
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    return text


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def read_file(path, label):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError as e:
        die(1, "Cannot read %s '%s': %s" % (label, path, e))


def parse_kv(pairs, is_file, label):
    out = {}
    for item in pairs or []:
        if "=" not in item:
            die(1, "--%s expects NAME=%s, got: %s"
                % (label, "PATH" if is_file else "STRING", item))
        name, val = item.split("=", 1)
        name = name.strip()
        if not re.match(r"^[A-Za-z0-9_]+$", name):
            die(1, "Invalid input name '%s' (letters/digits/underscore only)." % name)
        out[name] = read_file(val, "input file") if is_file else val
    return out


def build_arg_parser():
    p = argparse.ArgumentParser(
        prog="code_summary.py",
        description="Flexible Claude review agent (structured output by default).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    # Auth / model
    p.add_argument("--api-key", default=None,
                   help="Anthropic API key (default: $ANTHROPIC_API_KEY).")
    p.add_argument("--model", default=os.environ.get("ANTHROPIC_MODEL", DEFAULT_MODEL),
                   help="Model id (default: $ANTHROPIC_MODEL or built-in).")
    p.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    p.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES)
    p.add_argument("--temperature", type=float, default=None,
                   help="Optional; omitted from the request when unset.")
    # Prompt configuration
    p.add_argument("--system", help="System prompt string (overrides default preset).")
    p.add_argument("--system-file", help="Read system prompt from a file.")
    p.add_argument("--context", help="Additional context appended to the system prompt.")
    p.add_argument("--context-file", help="Read additional context from a file.")
    p.add_argument("--template", help="Analysis prompt template with {{placeholders}}.")
    p.add_argument("--template-file", help="Read the template from a file.")
    # Structured output
    p.add_argument("--tool-schema", help="JSON file with a tool input_schema "
                   "(overrides the default submit_analysis schema).")
    p.add_argument("--tool-name", default=DEFAULT_TOOL_NAME)
    p.add_argument("--no-tool", action="store_true",
                   help="Free-form text output instead of a forced tool call.")
    # Inputs / file gathering (files must be named explicitly)
    p.add_argument("--include", action="append", default=[], metavar="FILE",
                   help="File to review (repeatable). Fills {{code}}.")
    p.add_argument("--include-from", metavar="FILE",
                   help="Read newline-separated files to review; '-' means stdin. "
                        "Composes with find, e.g. `find . -name '*.R' | ... "
                        "--include-from -`.")
    p.add_argument("--max-file-bytes", type=int, default=DEFAULT_MAX_FILE_BYTES)
    p.add_argument("--proposal", help="File whose contents fill {{proposal}}.")
    p.add_argument("--reference-doc", action="append", default=[],
                   help="File appended to {{reference_docs}} (repeatable).")
    p.add_argument("--study-output", help="File whose contents fill {{study_output}}.")
    p.add_argument("--input", action="append", default=[], metavar="NAME=PATH",
                   help="Extra template value from a file (repeatable).")
    p.add_argument("--input-text", action="append", default=[], metavar="NAME=STRING",
                   help="Extra template value from a literal string (repeatable).")
    # Output / debugging
    p.add_argument("--save-response", help="Write the full raw API response JSON here.")
    p.add_argument("--messages-out", help="Write the request messages array here.")
    p.add_argument("--print-request", action="store_true",
                   help="Assemble and print the request to stderr, then exit (no API call).")
    return p


def main(argv):
    args = build_arg_parser().parse_args(argv)

    if args.api_key is None:
        args.api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not args.api_key:
        die(1, "Missing ANTHROPIC_API_KEY (set the env var or pass --api-key). You might have to set it yourself. It might be in ~/.claude/settings.json")
    if args.max_tokens <= 0:
        die(1, "--max-tokens must be positive.")
    if args.max_retries < 0:
        die(1, "--max-retries must be >= 0.")

    structured = not args.no_tool

    # System prompt (+ additional context).
    system = args.system
    if args.system_file:
        system = read_file(args.system_file, "system-file")
    if system is None:
        system = DEFAULT_SYSTEM_INSTRUCTION
    context = args.context
    if args.context_file:
        context = read_file(args.context_file, "context-file")
    if context:
        system = system + "\n\n" + context

    # Template.
    template = args.template
    if args.template_file:
        template = read_file(args.template_file, "template-file")
    if template is None:
        template = DEFAULT_ANALYSIS_TEMPLATE

    # Tool schema (structured mode).
    tool_schema = DEFAULT_TOOL_SCHEMA
    if args.tool_schema:
        raw = read_file(args.tool_schema, "tool-schema")
        try:
            tool_schema = json.loads(raw)
        except json.JSONDecodeError as e:
            die(1, "--tool-schema is not valid JSON: %s" % e)

    # Gather files for {{code}} — named explicitly via --include / --include-from.
    includes = list(args.include)
    if args.include_from:
        includes += read_path_list(args.include_from)
    if not includes:
        die(1, "No files to review: pass --include FILE and/or --include-from FILE "
               "('-' for stdin), e.g. `find . -name '*.R' | %s --include-from -`."
               % os.path.basename(sys.argv[0]))
    files, skipped = gather_files(includes, args.max_file_bytes)
    log("Gathered %d file(s) (skipped %d)." % (len(files), len(skipped)))
    for rel in sorted(files):
        log("  + %s" % rel)
    for rel, why in skipped:
        log("  - %s (%s)" % (rel, why))

    # Named template values.
    values = {"code": format_code_files(files)}

    if args.proposal:
        values["proposal"] = read_file(args.proposal, "proposal")

    ref_parts = [read_file(p, "reference-doc") for p in args.reference_doc]
    if ref_parts:
        values["reference_docs"] = "\n\n".join(ref_parts)

    if args.study_output:
        values["study_output"] = read_file(args.study_output, "study-output")

    values.update(parse_kv(args.input, True, "input"))
    values.update(parse_kv(args.input_text, False, "input-text"))

    prompt = fill_template(template, values)

    messages = [{"role": "user", "content": prompt}]
    body = {
        "model": args.model,
        "max_tokens": args.max_tokens,
        "system": system,
        "messages": messages,
    }
    if args.temperature is not None:
        body["temperature"] = args.temperature
    if structured:
        tool = {"name": args.tool_name, "input_schema": tool_schema}
        body["tools"] = [tool]
        body["tool_choice"] = {"type": "tool", "name": args.tool_name}

    if args.messages_out:
        with open(args.messages_out, "w", encoding="utf-8") as fh:
            json.dump(messages, fh, indent=2, ensure_ascii=False)
        log("Wrote request messages to %s" % args.messages_out)

    if args.print_request:
        log("---- SYSTEM ----")
        print(system, file=sys.stderr)
        log("---- USER PROMPT ----")
        print(prompt, file=sys.stderr)
        if structured:
            log("---- TOOL (%s) ----" % args.tool_name)
            print(json.dumps(tool_schema, indent=2), file=sys.stderr)
        log("Model=%s max_tokens=%d retries=%d temperature=%s structured=%s"
            % (args.model, args.max_tokens, args.max_retries,
               args.temperature, structured))
        log("--print-request set; not calling the API.")
        return 0

    log("Calling Anthropic API (model=%s, structured=%s) ..."
        % (args.model, structured))
    resp = call_anthropic(args.api_key, body, args.max_retries)

    if args.save_response:
        with open(args.save_response, "w", encoding="utf-8") as fh:
            json.dump(resp, fh, indent=2, ensure_ascii=False)
        log("Wrote raw response to %s" % args.save_response)

    usage = resp.get("usage", {})
    log("Done (stop_reason=%s, in=%s, out=%s tokens)."
        % (resp.get("stop_reason"), usage.get("input_tokens"),
           usage.get("output_tokens")))

    print(extract_result(resp, structured, args.tool_name))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
