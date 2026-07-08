#!/usr/bin/env python3
import os
import sys
import time
from urllib.parse import urlparse

try:
    import boto3
    import pymysql
except ImportError:
    print("a python package is not installed. To install, run:")
    print("  apt-get update && apt-get install -y python3-pip -q && python3 -m pip install boto3 pymysql -q --break-system-packages")
    sys.exit(1)


# Defaults
HIGHLIGHTS_S3_BUCKET_NAME = "safeinsights-test-data-s3"
HIGHLIGHTS_S3_BUCKET_REGION = "us-east-1"
HIGHLIGHTS_S3_BUCKET_PREFIX = "/tutor/v2/"
ASU_ATHENA_WORK_GROUP    = "crate-test-data-workgroup"
ASU_ATHENA_DATABASE_NAME = "asu-sample-data"


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)

_MISSING = object()

def _env(name: str, default: object = _MISSING) -> str:
    value = os.environ.get(name)
    if value is None:
        if default is _MISSING:
            print(f"ERROR: {name} is not set", file=sys.stderr)
            sys.exit(1)
        print(f"WARNING: {name} not set, using default: {default!r}", file=sys.stderr)
        return default
    return value


# Environment-specific defaults. Set ENVIRONMENT to dev, staging, or prod.
# Defaults are the prod names; for dev/staging they are suffixed with
# -dev / -staging.
_ENV = _env("ENVIRONMENT", "production").lower()
if _ENV == "production": pass
elif _ENV in ("dev", "staging"):
    HIGHLIGHTS_S3_BUCKET_NAME += f"-{_ENV}"
    ASU_ATHENA_WORK_GROUP     += f"-{_ENV}"
else:
    fail(f"ENVIRONMENT must be one of dev, staging, production, got {_ENV!r}")


HIGHLIGHTS_S3_BUCKET_NAME   = _env("HIGHLIGHTS_S3_BUCKET_NAME",   HIGHLIGHTS_S3_BUCKET_NAME)
HIGHLIGHTS_S3_BUCKET_REGION = _env("HIGHLIGHTS_S3_BUCKET_REGION",  HIGHLIGHTS_S3_BUCKET_REGION)
HIGHLIGHTS_S3_BUCKET_PREFIX = _env("HIGHLIGHTS_S3_BUCKET_PREFIX",  HIGHLIGHTS_S3_BUCKET_PREFIX)

# https://openstax.atlassian.net/browse/OTTER-480?focusedCommentId=40237
ASU_ATHENA_WORK_GROUP = _env("ASU_ATHENA_WORK_GROUP",    ASU_ATHENA_WORK_GROUP)
ASU_ATHENA_DATABASE   = _env("ASU_ATHENA_DATABASE_NAME", ASU_ATHENA_DATABASE_NAME)

TERC_ENCLAVE_DB_URL = _env("TERC_ENCLAVE_DB_URL")
RDS_SSL_CA = "./global-bundle.pem" # How does TERC expect to handle this?

MAX_COLUMNS_DISPLAY = 15


def run_athena_query(client, sql: str, retries: int = 3) -> list[dict]:
    response = client.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={"Database": ASU_ATHENA_DATABASE},
        WorkGroup=ASU_ATHENA_WORK_GROUP,
    )
    exec_id = response["QueryExecutionId"]

    for _ in range(retries):
        status = client.get_query_execution(QueryExecutionId=exec_id)
        state = status["QueryExecution"]["Status"]["State"]
        if state == "SUCCEEDED":
            break
        if state in ("FAILED", "CANCELLED"):
            fail(f"Query {exec_id} {state}")
        time.sleep(5)

    result = client.get_query_results(QueryExecutionId=exec_id)
    return result["ResultSet"]["Rows"]


def describe_s3(s3, bucket: str, prefix: str, region: str) -> None:
    print()
    print("==================================")
    print(f"Bucket contents: {bucket} {prefix}")
    print("==================================")
    if prefix.startswith("/"):
        print("WARNING: prefix has a leading slash, removing it", file=sys.stderr)
        prefix = prefix.lstrip("/")
    paginator = s3.get_paginator("list_objects_v2")
    found = False
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            size_kb = obj["Size"] / 1024
            print(f"  {size_kb:>10.1f} KiB  {obj['Key']}")
            found = True
    if not found:
        fail(f"Bucket s3://{bucket}/{prefix} is empty")


def val(row: dict, col: int) -> str:
    data = row["Data"]
    if col >= len(data):
        return ""
    return data[col].get("VarCharValue", "")


def describe_athena(athena) -> None:
    print()
    print("==================================")
    print(f"Athena Database: {ASU_ATHENA_DATABASE}")
    print("==================================")

    rows = run_athena_query(athena, f"SHOW TABLES IN `{ASU_ATHENA_DATABASE}`;")
    tables = [val(r, 0) for r in rows]
    if not tables:
        fail(f"No tables found in Athena database '{ASU_ATHENA_DATABASE}'")
    print(f"Tables ({len(tables)}): {' '.join(tables)}")

    for table in tables:
        row_count = val(run_athena_query(athena, f'SELECT COUNT(*) FROM "{table}";')[1], 0)
        if int(row_count) == 0:
            fail(f"Table '{table}' has 0 rows")

        describe_rows = run_athena_query(athena, f"DESCRIBE `{table}`;")
        col_rows = describe_rows[1:]  # skip header
        col_count = len(col_rows)
        columns = [f"  {val(r, 0)}\t{val(r, 1)}" for r in col_rows[:MAX_COLUMNS_DISPLAY]]
        if col_count > MAX_COLUMNS_DISPLAY:
            columns.append("  (...)")

        print(f"\n--------------------------------------------------")
        print(f"Table: '{table}' ({row_count} rows, {col_count} columns). Columns:")
        print(f"--------------------------------------------------")
        print("\n".join(columns))


def _print_rds_table(db: str, table: str, row_count: int, col_rows: list) -> None:
    col_count = len(col_rows)
    columns = [f"  {r[0]}\t{r[1]}" for r in col_rows[:MAX_COLUMNS_DISPLAY]]
    if col_count > MAX_COLUMNS_DISPLAY:
        columns.append("  (...)")
    print(f"\n--------------------------------------------------")
    print(f"Table: '{db}.{table}' ({row_count} rows, {col_count} columns). Columns:")
    print(f"--------------------------------------------------")
    print("\n".join(columns))


def describe_rds() -> None:
    parsed = urlparse(TERC_ENCLAVE_DB_URL)
    host     = parsed.hostname
    port     = parsed.port or 3306
    user     = parsed.username
    password = parsed.password
    database = parsed.path.lstrip("/")

    print()
    print("==================================")
    print(f"RDS Host: {host}")
    print("==================================")

    if not os.path.exists(RDS_SSL_CA):
        fail(
            f"SSL CA file not found at {RDS_SSL_CA!r}. Download it with:\n"
            f"  curl -sS https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o {RDS_SSL_CA}"
        )
    ssl = {"ca": RDS_SSL_CA}

    conn = pymysql.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database or None,
        ssl=ssl,
        connect_timeout=10,
    )

    system_dbs = {"information_schema", "mysql", "performance_schema", "sys"}
    with conn:
        with conn.cursor() as cur:
            if database:
                databases = [database]
            else:
                cur.execute("SHOW DATABASES;")
                databases = [r[0] for r in cur.fetchall() if r[0] not in system_dbs]
            if not databases:
                fail("No user databases found")
            print(f"Databases ({len(databases)}): {' '.join(databases)}")

            for db in databases:
                cur.execute(f"USE `{db}`;")
                cur.execute("SHOW TABLES;")
                tables = [r[0] for r in cur.fetchall()]
                if not tables:
                    fail(f"RDS database '{db}' has no tables")

                for table in tables:
                    cur.execute(f"SELECT COUNT(*) FROM `{table}`;")
                    row_count = cur.fetchone()[0]
                    if row_count == 0:
                        fail(f"RDS table '{db}.{table}' has 0 rows")

                    cur.execute(f"DESCRIBE `{table}`;")
                    _print_rds_table(db, table, row_count, cur.fetchall())


def main() -> None:
    s3     = boto3.client("s3", region_name=HIGHLIGHTS_S3_BUCKET_REGION)
    athena = boto3.client("athena", region_name=HIGHLIGHTS_S3_BUCKET_REGION)

    describe_s3(s3, HIGHLIGHTS_S3_BUCKET_NAME, HIGHLIGHTS_S3_BUCKET_PREFIX, HIGHLIGHTS_S3_BUCKET_REGION)
    describe_athena(athena)
    # describe_rds()


if __name__ == "__main__":
    main()
