# Local enclave stack

Run the enclave loop on a laptop: setup-app in DOCKER mode and the trusted-output-app from sibling
checkouts, plus a small stand-in for the management app that lets you trigger jobs, watch their
status and read the decrypted results. No Postgres, Clerk or SeaweedFS.

```
./dev-enclave.ts up            # keys, env files, sample images, then docker compose up
./dev-enclave.ts run offline   # queue a job (or use the buttons at http://localhost:4000)
./dev-enclave.ts down          # stop everything, remove research containers
./dev-enclave.ts clean         # down + forget jobs; --keys / --images go further
```

From the repo root the same commands are `npm run enclave -- up` and so on; `npm run enclave:test`,
`enclave:typecheck` and `enclave:format` cover this directory.

## Prerequisites

- Docker with the compose plugin (rootless Docker and Docker Desktop both work).
- `npm install` in the experiments repo root.
- `setup-app` and `trusted-output-app` checkouts next to the experiments repo, or `SETUP_APP_DIR`
  and `TOA_DIR` pointing at them. setup-app's DOCKER mode forwards the AWS data variables only
  from its `local-dev-enclave` branch onwards (`RESEARCH_CONTAINER_ENV`). With a checkout that
  lacks it, `up` warns, skips the `tutor` sample and the page shows a banner; the offline sample
  and pasted code still run, but nothing can read S3.
- Optional, for the `tutor` sample: a Harbor login (see below) and an AWS SSO session.

## What `up` does

1. Generates two RSA-4096 key pairs under `state/keys/` on the first run:
   `enclave.*` signs the JWTs setup-app and the TOA send to the management app (the stand-in
   verifies them), `reviewer.*` is the member reviewer key results are encrypted for (the stand-in
   decrypts with it). `--fresh-keys` replaces them.
2. Exports credentials from `AWS_PROFILE` (default `ose-dev`) with
   `aws configure export-credentials`. If that fails you get the `aws sso login` hint and the stack
   still starts; only the `tutor` sample needs it. `--no-aws` skips the attempt.
3. Writes `state/{setup-app,toa,bma,compose}.env` (gitignored, mode 0600).
4. Builds the sample images: `localhost/enclave-dev/sample-offline:{latest,fail}` always, and
   `localhost/enclave-dev/sample-tutor:latest` when its Harbor base image is readable.
5. `docker compose up --build` with the three services below. Ctrl-C stops them and removes any
   research containers setup-app left behind.

| service     | what                                                                            | reachable at                 |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------- |
| `bma`       | management app stand-in (`standin/`), own image, repo bind-mounted, `tsx watch` | http://localhost:4000 (page) |
| `toa`       | trusted-output-app `dev` target, `src/` bind-mounted for hot reload             | http://localhost:3002        |
| `setup-app` | the setup-app checkout, `src/` bind-mounted, `tsx watch src/scripts/poll.ts`    | logs only                    |

They share the `enclave-dev` network; research containers join it through
`RESEARCH_CONTAINER_NETWORK`, which is how they reach `http://toa:3002`. Nothing needs to reach the
host, which matters under rootless Docker (its default networking cannot reach host loopback).

## The page

Each job shows its status timeline as setup-app and the research container report it
(`JOB-READY → JOB-PROVISIONING → JOB-RUNNING` with any progress messages → `RUN-COMPLETE`, or
`JOB-ERRORED` with the message), with relative times that keep updating (hover for the exact
timestamp). Below it are the files the TOA delivered: CSVs as tables, text and logs as text,
anything else as a download. Logs are shown exactly when the pipeline delivers them: setup-app
uploads a failed container's output through the TOA, and a `log` sent next to a `result` is shown
too. The encrypted zips are kept under `state/jobs/<jobId>/`. Enclave auth failures (bad or
missing JWT) are listed at the top because a key mismatch is the usual reason nothing happens.

Trigger a job with the sample buttons, with any image name, or from a terminal:

```
./dev-enclave.ts run offline              # writes a CSV and uploads it
./dev-enclave.ts run offline-fail         # exits 1 after JOB-RUNNING: error path, logs uploaded
./dev-enclave.ts run tutor                # queries Tutor parquet data in S3 (needs AWS + Harbor)
./dev-enclave.ts run --image some/image:tag --title "my study"
```

### Run your own code

The second form on the page takes a base image (default `python:3.12-slim`; the OpenStax
`python-base` is suggested when its tag is configured) and a Python script. Submitting it creates a
job at `JOB-PACKAGING`, like the containerizer step in the real pipeline. `./dev-enclave.ts up`
polls the stand-in for such jobs and builds `localhost/enclave-dev/code-<id>:latest` on the host
(`samples/code/Dockerfile`: the base image, the script as `main.py`, and `runner.py`), then
the job becomes `JOB-READY` and setup-app runs it as usual. A failed build shows up as
`JOB-ERRORED` with the build log on the job card.

The script only has to write CSV files in its working directory. `runner.py` reports
`JOB-RUNNING` before running it, uploads every `*.csv` afterwards in one request (the pipeline
accepts one results delivery per job), and exits non-zero if the script raised, exited non-zero or
wrote no CSV, so the container's output arrives as the job's log. It also puts a
`progress(message)` function in the script's globals: each call is a `JOB-RUNNING` update with
that message, which the timeline shows as it arrives (the default script sends five, a second
apart, as does the offline sample). Do not upload from the script as well. Python only: the base
image must provide `python`.

From a terminal: `./dev-enclave.ts run --code path/to/main.py [--base-image IMAGE] [--title T]`.
The build context of each job is kept under `state/builds/<jobId>/`.

### Debugging with VS Code

Every service runs under `tsx watch --inspect`, and the inspector ports are published on
localhost: setup-app on 9229, trusted-output-app on 9230, the stand-in on 9231
(`SETUP_APP_DEBUG_PORT`, `TOA_DEBUG_PORT`, `BMA_DEBUG_PORT` to change them). Open
`enclave-dev.code-workspace` in VS Code: it holds this directory, setup-app and the
trusted-output-app as workspace folders and an attach configuration for each service, plus a
compound that attaches to all three. `.vscode/launch.json` has the same configurations for when
only this directory is open. Breakpoints in the apps' `src/` work through tsx's source maps, and
`restart: true` reattaches after a hot reload. Both assume the sibling-checkout layout; edit
`localRoot` (or the workspace folder paths) otherwise.

The stand-in implements what setup-app and the TOA call on the real management app:
`GET /api/studies/ready`, `PUT /api/job/:id`, `GET /api/job/:id/status`, `GET /api/job/:id/keys`,
`POST /api/job/:id/results`, with RS256 JWT verification against `enclave.pub.pem` (`--no-verify-jwt`
turns failures into warnings). `GET /jobs.json` dumps its state.

## Sample data in AWS

The OpenStax enclave's research images read Tutor parquet files from S3 through DuckDB using
`HIGHLIGHTS_S3_BUCKET_NAME`, `HIGHLIGHTS_S3_BUCKET_PREFIX`, `HIGHLIGHTS_S3_BUCKET_REGION` and the
default AWS credential chain. In ECS those come from the task definition and task role; locally,
`up` puts them and the exported SSO credentials into setup-app's env and names them in
`RESEARCH_CONTAINER_ENV`, which setup-app's DOCKER mode copies into every research container.

Defaults point at the dev enclave account: profile `ose-dev`, bucket `openstax-enclave-data-dev`,
prefix `/tutor/v2/`, region `us-west-2`. Override with the same-named environment variables. The
enclave's RDS database has no path from a laptop, so only the S3-backed queries work here.

SSO sessions expire; run `aws sso login --profile ose-dev` and `./dev-enclave.ts up` again. The
changed env file makes compose recreate `setup-app`, and the next research container gets the new
credentials.

## Harbor login

`harbor.safeinsights.org/openstax/*` (the research base images) is a private project; anonymous
pulls get 401. Harbor signs users in with OIDC, so a `docker login` needs the CLI secret: sign in
at https://harbor.safeinsights.org/ in a browser, open your user profile (top right) and copy the
CLI secret, then run `docker login harbor.safeinsights.org` with your username and that secret.
`up` detects the missing login, offers to run it, and otherwise skips the tutor sample. For
non-interactive use, fill `docker-auth.local` (same shape as setup-app's `local/docker-auth.local.example`: `username`, `password`, `serveraddress`).

`SAMPLE_TUTOR_BASE_IMAGE` picks the base image tag; the default is the newest `python-base` at the
time of writing. List tags with the Harbor UI or
`curl -u USER:SECRET https://harbor.safeinsights.org/api/v2.0/projects/openstax/repositories/python-base/artifacts`.

## Settings

| variable                      | default                       | meaning                                |
| ----------------------------- | ----------------------------- | -------------------------------------- |
| `TOA_DIR`                     | `../trusted-output-app`       | trusted-output-app checkout            |
| `BMA_PORT`                    | `4000`                        | host port of the stand-in page         |
| `MEMBER_ID`                   | `openstax`                    | JWT issuer both apps send              |
| `AWS_PROFILE`                 | `ose-dev`                     | profile to export credentials from     |
| `SAMPLE_TUTOR_BASE_IMAGE`     | newest `openstax/python-base` | base for the tutor sample              |
| `HIGHLIGHTS_S3_BUCKET_NAME`   | `openstax-enclave-data-dev`   | S3 data bucket                         |
| `HIGHLIGHTS_S3_BUCKET_PREFIX` | `/tutor/v2/`                  | key prefix, leading and trailing slash |
| `HIGHLIGHTS_S3_BUCKET_REGION` | `us-west-2`                   | bucket region                          |

`up` flags: `--fresh-keys`, `--no-verify-jwt`, `--no-aws`, `--skip-samples`. Debugger ports:
`SETUP_APP_DEBUG_PORT` (9229), `TOA_DEBUG_PORT` (9230), `BMA_DEBUG_PORT` (9231).

## Troubleshooting

- **A code job stays at JOB-PACKAGING.** Only `./dev-enclave.ts up` builds images; if you started
  compose by hand, run `up` instead. The host's log line says what it is building.
- **Jobs stay at JOB-READY.** Look at the `setup-app` log lines in the compose output: a failed
  pull of a local-only image is normal and ignored, a `401` from `bma` means the JWT key does not
  match (restart after `--fresh-keys`), a socket error means Docker is not mounted (`DOCKER_SOCK`
  in `state/compose.env` is what `docker context inspect` reported).
- **JOB-ERRORED with a `Docker API Call Error`.** The image does not exist locally and could not be
  pulled; the message carries Docker's reason.
- **`Could not decrypt`.** The TOA encrypted for keys the stand-in did not hand out (stale
  container after `--fresh-keys`), or the encryption format changed upstream. The raw zip is linked.
- **Port 4000 is taken** (the real management app uses it too): `BMA_PORT=4100 ./dev-enclave.ts up`.
- **Rootless Docker.** Containers that need the daemon socket or write to `state/` run as root
  inside, which is your own user outside. Files under `state/` stay yours.
