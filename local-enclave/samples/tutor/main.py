"""OpenStax Research Container entry point, as the python-base image's template ships it.

query_tutor reads the Tutor parquet files from S3 via DuckDB using HIGHLIGHTS_S3_BUCKET_NAME,
HIGHLIGHTS_S3_BUCKET_PREFIX, HIGHLIGHTS_S3_BUCKET_REGION and the default AWS credential chain, all
forwarded by setup-app through RESEARCH_CONTAINER_ENV.
"""

from osenclave.openstax import query_tutor
from osenclave.safeinsights_common import initialize, toa_results_upload

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
