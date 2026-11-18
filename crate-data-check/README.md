# CRATE data source check

`check-data-sources.sh` checks, from inside a Coder workspace, every sample data source a CRATE study can
use, and says which ones are missing data or cannot be reached:

| Source       | Where                                                             | Connection from                                                                          |
| ------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| OpenStax     | Tutor parquet files in the test data bucket                       | `HIGHLIGHTS_S3_BUCKET_NAME`, `_PREFIX`, `_REGION`                                        |
| ASU          | Athena database `asu-sample-data`                                 | `AWS_ATHENA_WORK_GROUP`                                                                  |
| ASSISTments  | Athena database `assistments_sample_data`                         | `AWS_ATHENA_WORK_GROUP`                                                                  |
| CourseKata   | Athena database `coursekata_sample_data`                          | `AWS_ATHENA_WORK_GROUP`                                                                  |
| Quill        | Postgres sample database `quill_enclave`                          | `QUILL_ENCLAVE_DB_URL`, injected by the Coder template                                   |
| TERC         | MySQL sample database `terc_enclave`                              | `TERC_ENCLAVE_DB_URL`, injected by the Coder template                                    |
| Khan Academy | BigQuery dataset `si-crate-example-data.khan_academy_sample_data` | `GOOGLE_APPLICATION_CREDENTIALS`, set by the Coder template; `GCP_PROJECT`, `BQ_DATASET` |

Copy the script into the workspace and run it:

```bash
./check-data-sources.sh                    # every source
./check-data-sources.sh --only asu,terc    # some of them
```

It first lists each environment variable it reads, with the value it found or the default it used instead
(the S3 and Athena names follow from the environment, which it reads from the AWS account). The two database
URLs and `GOOGLE_APPLICATION_CREDENTIALS` have no default: the Coder template sets them, so a missing one fails
its source.
Then it counts the rows in every table of each source, marks each count `ok`, `WRONG`, `MISSING`, `NEW` (no
expected count) or `ERROR`, and ends with a PASS, WARN or FAIL line per source. It exits 1 when any source
fails. When the workspace's study has its own Athena database (`AWS_ATHENA_DATABASE_NAME`), that is counted
too.

The script installs `python3` and its venv module when they are missing (as root or with passwordless sudo,
through apt-get, apk or dnf), and its Python packages into a venv under `~/.cache/crate-data-check`.

## BigQuery from a workspace

`GOOGLE_APPLICATION_CREDENTIALS` names a workload identity federation config that trades the workspace's AWS
task role for a Google token, so no Google credential is stored anywhere. Google's Python library looks for
the AWS credentials only in environment variables or EC2 metadata, and Fargate serves them from neither, so the
script hands it the task role's credentials from boto3 (`google_credentials` in the script). Research code
that calls BigQuery from a workspace needs the same bridge. Pointed at a laptop's application default
credentials instead, the script uses those as they are.

## When a partner's data is reloaded

Update that source's counts in `EXPECTED` at the top of the Python part. `--baseline` prints the counts of a
run in the same form, ready to paste once you have checked them against the partner's manifest.
