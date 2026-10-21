"""Runs a pasted script inside a research container and speaks the trusted-output-app protocol for it.

The script only has to write CSV files in the working directory. This runner reports JOB-RUNNING
first, runs the script with a `progress(message)` function in its globals (a JOB-RUNNING update
with that message, shown on the job's timeline), then uploads every CSV it finds in one request
(one results delivery per job is all the real pipeline accepts). Any failure exits non-zero so
setup-app reports JOB-ERRORED and ships these logs.
"""

import glob
import json
import os
import runpy
import sys
import traceback
import urllib.error
import urllib.request
import uuid

endpoint = os.environ["TRUSTED_OUTPUT_ENDPOINT"]
job_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(job_dir)


def request(method: str, url: str, body: bytes, content_type: str) -> tuple[int, str]:
    req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()


def report(message: str | None = None) -> None:
    body = {"status": "JOB-RUNNING", **({"message": message} if message else {})}
    status, text = request("PUT", endpoint, json.dumps(body).encode(), "application/json")
    print(f"JOB-RUNNING{f' ({message})' if message else ''} -> {status} {text}", flush=True)


def progress(message: str) -> None:
    """Available to main.py: put a progress message on the job's timeline."""
    report(str(message))


report()

try:
    runpy.run_path(os.path.join(job_dir, "main.py"), run_name="__main__", init_globals={"progress": progress})
except SystemExit as exit_request:
    if exit_request.code not in (0, None):
        print(f"main.py exited with {exit_request.code}", file=sys.stderr, flush=True)
        sys.exit(1)
except Exception:  # noqa: BLE001 - anything the script raises is the researcher's failure to report
    traceback.print_exc()
    sys.exit(1)

csv_files = sorted(glob.glob("*.csv"))
if not csv_files:
    print("main.py finished but wrote no *.csv file in the working directory", file=sys.stderr, flush=True)
    sys.exit(1)

boundary = uuid.uuid4().hex
parts = []
for name in csv_files:
    with open(name, "rb") as handle:
        data = handle.read()
    parts.append(
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
        "Content-Type: text/csv\r\n\r\n".encode() + data + b"\r\n"
    )
body = b"".join(parts) + f"--{boundary}--\r\n".encode()
status, text = request("POST", f"{endpoint}/upload", body, f"multipart/form-data; boundary={boundary}")
print(f"upload of {', '.join(csv_files)} -> {status} {text}", flush=True)
if status != 200:
    sys.exit(1)
print("results uploaded", flush=True)
