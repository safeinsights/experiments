"""Offline sample job: report JOB-RUNNING, write a CSV, upload it to the trusted-output-app.

This is what the OpenStax images' `osenclave` helpers do (initialize() and toa_results_upload()),
without any dependency, so the local enclave stack can be exercised with no registry login and no
data access. setup-app injects TRUSTED_OUTPUT_ENDPOINT; nothing else is needed.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

endpoint = os.environ["TRUSTED_OUTPUT_ENDPOINT"]


def request(method: str, url: str, body: bytes, content_type: str) -> tuple[int, str]:
    req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()


status, text = request("PUT", endpoint, json.dumps({"status": "JOB-RUNNING"}).encode(), "application/json")
print(f"JOB-RUNNING -> {status} {text}", flush=True)

# Progress is a JOB-RUNNING update with a message; each one lands on the job's timeline.
for step in range(1, 6):
    body = json.dumps({"status": "JOB-RUNNING", "message": f"step {step} of 5"}).encode()
    status, text = request("PUT", endpoint, body, "application/json")
    print(f"progress step {step} of 5 -> {status} {text}", flush=True)
    time.sleep(1)

if os.environ.get("SAMPLE_FAIL") == "1":
    print("SAMPLE_FAIL=1: exiting non-zero so setup-app reports JOB-ERRORED and uploads these logs", file=sys.stderr)
    sys.exit(1)

csv = "group,count\nA,42\nB,17\n"
with open("results.csv", "w") as handle:
    handle.write(csv)

boundary = uuid.uuid4().hex
body = (
    f"--{boundary}\r\n"
    'Content-Disposition: form-data; name="file"; filename="results.csv"\r\n'
    "Content-Type: text/csv\r\n\r\n"
    f"{csv}\r\n"
    f"--{boundary}--\r\n"
).encode()
status, text = request("POST", f"{endpoint}/upload", body, f"multipart/form-data; boundary={boundary}")
print(f"upload -> {status} {text}")
if status != 200:
    # An exit code of 0 makes setup-app treat the container as a success, remove it, and offer the
    # job again on the next poll. Failing loudly is what gets the job marked JOB-ERRORED.
    sys.exit(1)
print("results uploaded")
