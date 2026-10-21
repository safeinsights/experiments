"""OpenStax Research Container entry point, as the python-base image's template ships it.

query_tutor reads the Tutor parquet files from S3 via DuckDB using HIGHLIGHTS_S3_BUCKET_NAME,
HIGHLIGHTS_S3_BUCKET_PREFIX, HIGHLIGHTS_S3_BUCKET_REGION and the default AWS credential chain, all
forwarded by setup-app through RESEARCH_CONTAINER_ENV.
"""

import os
import sys

from osenclave.openstax import query_tutor
from osenclave.safeinsights_common import initialize, toa_results_upload

missing = [
    name
    for name in ("HIGHLIGHTS_S3_BUCKET_NAME", "HIGHLIGHTS_S3_BUCKET_PREFIX", "HIGHLIGHTS_S3_BUCKET_REGION", "AWS_ACCESS_KEY_ID")
    if not os.environ.get(name)
]
if missing:
    # Without these the helper builds paths like s3://NoneNone...; say what is wrong instead.
    print(
        f"missing {', '.join(missing)}: setup-app did not forward the data variables. It needs RESEARCH_CONTAINER_ENV "
        "support (setup-app branch local-dev-enclave) and an AWS session on the host; see local-enclave/README.md.",
        file=sys.stderr,
    )
    sys.exit(1)

###############################################################################
# Initialize Research Container
# DO NOT TOUCH
initialize()
###############################################################################
# Researcher: Insert query code here

# OpenStax Tutor Example: Count unique tasked_id for date range
results = query_tutor("""
    SELECT COUNT(DISTINCT tasks_task_id) as unique_tasked_count
    FROM tutor_data
    WHERE created_at >= '2023-02-02' AND created_at <= '2023-02-03'
""")

###############################################################################
# Researcher: Insert manipulate data and analysis code here

results.to_csv("results.csv", index=False)

###############################################################################
# Researcher: Upload results
toa_results_upload("results.csv")
