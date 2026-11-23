#!/usr/bin/env bash

# Checks the CRATE sample data sources from inside a Coder workspace: OpenStax's Tutor parquet files in
# S3, the ASU, ASSISTments and CourseKata databases in Athena, the Quill (Postgres) and TERC (MySQL)
# sample databases, and the Khan Academy dataset in BigQuery. For each source it reports the environment
# variables it read, or the default it used when one is not set, counts the rows in every table and
# compares them with the counts in EXPECTED.
#
#   ./check-data-sources.sh                    # every source
#   ./check-data-sources.sh --only asu,terc    # some of them
#   ./check-data-sources.sh --baseline         # also print the counts in the form EXPECTED takes
#
# Installs python3 and its venv module with the system package manager when they are missing (as root
# or with passwordless sudo), and its Python packages into a venv under ~/.cache/crate-data-check, one per
# Python interpreter.
# Exits 1 when any source fails.

set -euo pipefail

cache="${XDG_CACHE_HOME:-$HOME/.cache}/crate-data-check"
packages=(boto3 certifi google-auth google-cloud-bigquery pyarrow pymysql 'psycopg[binary]')

as_root() {
    if [ "$(id -u)" = 0 ]; then
        "$@"
    elif command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
        sudo -n "$@"
    else
        echo "Error: installing system packages needs root or passwordless sudo: $*" >&2
        exit 1
    fi
}

if ! command -v python3 >/dev/null || ! python3 -c 'import venv, ensurepip' 2>/dev/null; then
    echo "Installing python3 and its venv module" >&2
    if command -v apt-get >/dev/null; then
        as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
        as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates python3 python3-venv >/dev/null
    elif command -v apk >/dev/null; then
        as_root apk add --quiet ca-certificates python3
    elif command -v dnf >/dev/null; then
        as_root dnf install -y -q ca-certificates python3
    else
        echo "Error: python3 with the venv module is missing, and there is no apt-get, apk or dnf to install it" >&2
        exit 1
    fi
fi

# A venv only works with the interpreter that made it, and workspaces on different images share one home
python=$(readlink -f "$(command -v python3)")
venv="$cache/venv${python//\//-}"
if ! "$venv/bin/python" -c '' 2>/dev/null; then
    echo "Creating a Python venv in $venv" >&2
    python3 -m venv --clear "$venv"
fi

# pip's own cache is under ~/.cache/pip, which a workspace can leave owned by another user; this one was
# just written to. One package that has no wheel for this platform should cost only the checks that need it.
export PIP_CACHE_DIR="$cache/pip"
if ! "$venv/bin/python" -c 'import boto3, certifi, google.auth.aws, google.cloud.bigquery, psycopg, pyarrow, pymysql' 2>/dev/null; then
    echo "Installing ${packages[*]} into $venv (a minute or two the first time)" >&2
    "$venv/bin/pip" install --quiet --disable-pip-version-check "${packages[@]}" ||
        for package in "${packages[@]}"; do
            "$venv/bin/pip" install --quiet --disable-pip-version-check "$package" ||
                echo "Warning: could not install $package; the checks that need it will fail" >&2
        done
fi

CRATE_CHECK_CACHE="$cache" exec "$venv/bin/python" - "$@" <<'PY'
import argparse
import concurrent.futures as cf
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request

import boto3
from botocore.config import Config

# The AWS account of each environment, from the permissions boundary ARNs in iac's Coder template tfvars
ACCOUNTS = {
    "872515273917": "dev",
    "867344442985": "staging",
    "533267019973": "production",
    "031067831476": "demo",
}
SUFFIX = {"dev": "-dev", "staging": "-staging", "production": "", "demo": "-demo"}

SOURCES = {
    "openstax": "OpenStax Tutor parquet files in S3",
    "asu": "ASU in Athena",
    "assistments": "ASSISTments in Athena",
    "coursekata": "CourseKata in Athena",
    "quill": "Quill sample database (Postgres)",
    "terc": "TERC sample database (MySQL)",
    "khan": "Khan Academy in BigQuery",
}
# Glue databases from partnerDatasets in iac's crate-example-data/si-*/cdk.json
ATHENA_DATABASES = {
    "asu": "asu-sample-data",
    "assistments": "assistments_sample_data",
    "coursekata": "coursekata_sample_data",
}
# Set by the Coder template (none in demo): the variables each engine's own clients read, so a bare psql or
# mysql connects too. Host, port, database and user come from sample_data_postgres / sample_data_mysql in
# iac's tfvars; the password from the sample-data secret named in sample_data_secrets.
DB_VARIABLES = {
    "quill": {"host": "PGHOST", "port": "PGPORT", "user": "PGUSER", "password": "PGPASSWORD", "database": "PGDATABASE"},
    "terc": {"host": "MYSQL_HOST", "port": "MYSQL_TCP_PORT", "user": "MYSQL_USER", "password": "MYSQL_PWD", "database": "MYSQL_DATABASE"},
}
DB_DEFAULT_PORT = {"quill": 5432, "terc": 3306}
# Where scripts/load-avro-to-bigquery.ts in iac loads the Khan Academy drop
KHAN_PROJECT = "si-crate-example-data"
KHAN_DATASET = "khan_academy_sample_data"

# Rows each table should hold. Every environment loads the same drop of each partner's data, so one set
# of counts covers them all; a source whose counts do differ by environment can key them by environment
# name instead ({"dev": {...}, "staging": {...}}). Update a source's counts when its data is reloaded:
# --baseline prints them in this form.
EXPECTED = {
    "openstax": {
        "content_pages_lookup_2018-01-01_2024-12-31": 100,
        "highlights_notes_2018-01-01_2019-12-31": 274455,
        "highlights_notes_2020-01-01_2021-12-31": 861215,
        "highlights_notes_2022-01-01_2024-12-31": 326451,
        "openstax_tutor_2018-01-01__2018-12-31": 3628513,
        "openstax_tutor_2019-01-01__2019-12-31": 4872979,
        "openstax_tutor_2020-01-01__2020-12-31": 6071316,
        "openstax_tutor_2021-01-01__2021-12-31": 6557159,
        "openstax_tutor_2022-01-01__2022-12-31": 5222821,
        "openstax_tutor_2023-01-01__2023-12-31": 1636748,
        "openstax_tutor_2024-01-01__2024-12-31": 7280,
        "openstax_tutor_assessment_content_exercises": 100
    },
    "asu": {
        "standard_cls_sum": 32,
        "standard_demographics": 1297,
        "standard_stdnt_cls": 1549,
        "standard_stdnt_term": 15894,
        "standard_term": 3
    },
    "assistments": {
        "sia_assignment": 1297,
        "sia_assignment_settings": 1297,
        "sia_class": 6,
        "sia_curriculum": 6017,
        "sia_date": 9496,
        "sia_group": 1,
        "sia_problem": 9702,
        "sia_problem_logs": 299706,
        "sia_problem_set": 670,
        "sia_problem_skills": 21265,
        "sia_school": 1,
        "sia_standard": 2,
        "sia_user": 178
    },
    "coursekata": {
        "book_pages": 106,
        "classes": 4,
        "enrollments": 26,
        "institutions": 13,
        "media_views": 40,
        "page_views": 1016,
        "questions": 925,
        "responses": 1910,
        "users": 26
    },
    "quill": {
        "accessibility_settings": 10811,
        "active_activity_sessions": 0,
        "active_storage_attachments": 99,
        "active_storage_blobs": 99,
        "active_storage_variant_records": 0,
        "activities": 2432,
        "activities_unit_templates": 2808,
        "activity_categories": 31,
        "activity_category_activities": 1645,
        "activity_classifications": 8,
        "activity_healths": 866,
        "activity_sessions": 1000,
        "activity_survey_responses": 0,
        "activity_topics": 1043,
        "admin_accounts": 22,
        "admin_accounts_admins": 22,
        "admin_accounts_teachers": 145,
        "admin_approval_requests": 515,
        "admin_infos": 9869,
        "admin_report_filter_selections": 1610,
        "announcements": 2,
        "app_settings": 3,
        "ar_internal_metadata": 1,
        "auth_credentials": 0,
        "authors": 64,
        "blog_post_user_ratings": 7630,
        "blog_posts": 288,
        "canvas_accounts": 0,
        "canvas_configs": 0,
        "canvas_instance_auth_credentials": 0,
        "canvas_instance_schools": 0,
        "canvas_instances": 0,
        "categories": 56,
        "change_logs": 639789,
        "checkboxes": 2421268,
        "classlink_accounts": 214081,
        "classlink_instance_schools": 136,
        "classlink_instances": 837,
        "classroom_activities": 2773351,
        "classroom_unit_activity_states": 1718737,
        "classroom_units": 10170255,
        "classrooms": 2085902,
        "classrooms_teachers": 2168433,
        "comprehension_activities": 256,
        "comprehension_automl_models": 615,
        "comprehension_feedbacks": 8861,
        "comprehension_highlights": 3196,
        "comprehension_labels": 3111,
        "comprehension_passages": 247,
        "comprehension_plagiarism_texts": 1605,
        "comprehension_prompts": 741,
        "comprehension_prompts_rules": 58824,
        "comprehension_regex_rules": 1343,
        "comprehension_rules": 6037,
        "comprehension_turking_round_activity_sessions": 70119,
        "comprehension_turking_rounds": 348,
        "concept_feedbacks": 740,
        "concept_practice_recommendations": 107,
        "concept_result_directions": 192937,
        "concept_result_instructions": 315,
        "concept_result_previous_feedbacks": 29092,
        "concept_result_prompts": 19880,
        "concept_result_question_types": 8,
        "concept_results": 1000,
        "concepts": 973,
        "content_partner_activities": 201,
        "content_partners": 6,
        "coteacher_classroom_invitations": 41433,
        "credit_transactions": 20862,
        "criteria": 517,
        "csv_exports": 4839,
        "diagnostic_question_optimal_concepts": 281,
        "diagnostic_question_skills": 610,
        "district_admins": 222,
        "district_subscriptions": 337,
        "districts": 22980,
        "districts_users": 23671,
        "email_subscriptions": 11,
        "english_texts": 5304,
        "evidence_activated_llm_prompts": 568,
        "evidence_activity_healths": 166,
        "evidence_automl_models": 366,
        "evidence_entry_embeddings": 2099342,
        "evidence_gen_ai_highlight_groups": 469,
        "evidence_gen_ai_highlights": 531,
        "evidence_hints": 62,
        "evidence_imported_entries": 157286,
        "evidence_labeled_entries": 560834,
        "evidence_prompt_healths": 498,
        "evidence_prompt_response_feedbacks": 0,
        "evidence_prompt_responses": 0,
        "evidence_prompt_text_batches": 525,
        "evidence_prompt_texts": 545074,
        "evidence_research_gen_ai_activities": 180,
        "evidence_research_gen_ai_buckets": 19404,
        "evidence_research_gen_ai_clusterings": 90,
        "evidence_research_gen_ai_comparisons": 1072,
        "evidence_research_gen_ai_dataset_relevant_texts": 752,
        "evidence_research_gen_ai_datasets": 1683,
        "evidence_research_gen_ai_examples": 615596,
        "evidence_research_gen_ai_feedback_evaluations": 1460387,
        "evidence_research_gen_ai_feedback_revision_examples": 2,
        "evidence_research_gen_ai_feedback_revision_rules": 20,
        "evidence_research_gen_ai_feedback_revision_trial_llm_examples": 0,
        "evidence_research_gen_ai_feedback_revision_trials": 0,
        "evidence_research_gen_ai_feedback_revisions": 117,
        "evidence_research_gen_ai_feedback_rules": 1,
        "evidence_research_gen_ai_g_eval_scores": 984572,
        "evidence_research_gen_ai_g_evals": 1,
        "evidence_research_gen_ai_guidelines": 7579,
        "evidence_research_gen_ai_llm_examples": 4105338,
        "evidence_research_gen_ai_llm_prompt_guidelines": 33217,
        "evidence_research_gen_ai_llm_prompt_prompt_examples": 472324,
        "evidence_research_gen_ai_llm_prompt_relevant_texts": 8610,
        "evidence_research_gen_ai_llm_prompt_templates": 74,
        "evidence_research_gen_ai_llm_prompts": 11800,
        "evidence_research_gen_ai_llms": 21,
        "evidence_research_gen_ai_prompt_template_variables": 15,
        "evidence_research_gen_ai_relevant_texts": 711,
        "evidence_research_gen_ai_representative_samples": 50,
        "evidence_research_gen_ai_stem_vaults": 545,
        "evidence_research_gen_ai_step_connections": 0,
        "evidence_research_gen_ai_step_executions": 0,
        "evidence_research_gen_ai_student_responses": 2100,
        "evidence_research_gen_ai_trial_comparisons": 2335,
        "evidence_research_gen_ai_trials": 11854,
        "evidence_research_gen_ai_workflow_executions": 0,
        "evidence_research_gen_ai_workflow_steps": 0,
        "evidence_research_gen_ai_workflows": 0,
        "evidence_text_generations": 363837,
        "feedback_histories": 1000,
        "feedback_history_flags": 6227634,
        "feedback_history_ratings": 221889,
        "feedback_sessions": 3643325,
        "file_uploads": 0,
        "firebase_apps": 3,
        "gengo_jobs": 0,
        "images": 2899,
        "invitations": 71499,
        "ip_locations": 0,
        "learn_worlds_account_course_events": 2661,
        "learn_worlds_accounts": 2668,
        "learn_worlds_courses": 12,
        "lockers": 6,
        "milestones": 19,
        "oauth_access_grants": 0,
        "oauth_access_tokens": 0,
        "oauth_applications": 4,
        "objectives": 9,
        "pack_sequence_items": 1134283,
        "pack_sequences": 183027,
        "page_areas": 0,
        "partner_activity_sessions": 102,
        "partner_contents": 7,
        "pdf_subscriptions": 49,
        "plans": 10,
        "prompt_healths": 6194,
        "provider_classroom_users": 0,
        "provider_classrooms": 0,
        "questions": 14804,
        "raw_scores": 16,
        "recommendations": 256,
        "referrals_users": 2533,
        "referrer_users": 568436,
        "sales_contacts": 77785,
        "sales_form_submissions": 49,
        "sales_stage_types": 13,
        "sales_stages": 940699,
        "schema_migrations": 732,
        "school_subscriptions": 5875,
        "schools": 145670,
        "schools_admins": 9366,
        "schools_users": 456944,
        "skill_concepts": 130,
        "skill_group_activities": 192,
        "skill_groups": 108,
        "skills": 113,
        "standard_categories": 26,
        "standard_levels": 17,
        "standards": 89,
        "state_standard_concepts": 18662,
        "state_standard_grades": 761,
        "state_standards": 648,
        "state_standards_frameworks": 14,
        "stripe_checkout_sessions": 0,
        "stripe_webhook_events": 0,
        "student_feedback_responses": 0,
        "student_learning_sequence_activities": 222047253,
        "student_learning_sequences": 17416660,
        "student_problem_reports": 5086,
        "students_classrooms": 33845495,
        "subject_areas": 7,
        "subscriptions": 100959,
        "teacher_info_subject_areas": 464279,
        "teacher_infos": 641639,
        "teacher_notification_settings": 601400,
        "teacher_notifications": 10421387,
        "teacher_saved_activities": 254917,
        "third_party_user_ids": 66,
        "title_cards": 69,
        "topics": 89,
        "translated_texts": 84051,
        "translation_mappings": 65127,
        "unit_activities": 20639198,
        "unit_template_categories": 11,
        "unit_templates": 671,
        "units": 4921082,
        "user_activity_classifications": 30795512,
        "user_email_verifications": 427807,
        "user_logins": 1265615,
        "user_milestones": 1097686,
        "user_pack_sequence_items": 12904761,
        "user_subscriptions": 193482,
        "users": 1000,
        "zipcode_infos": 0
    },
    "terc": {
        "academic_years": 7,
        "ace_reports": 1,
        "activity_logs": 0,
        "assessment_sequences": 37,
        "assessments": 82,
        "calendar": 9131,
        "countries": 201,
        "course_grade_levels": 18,
        "course_levels": 3,
        "course_subjects": 4,
        "courses": 5,
        "delayed_jobs": 0,
        "educator_roles": 3,
        "events": 0,
        "export_datasets": 13,
        "export_datasets_requests": 4,
        "export_request_filters": 0,
        "export_requests": 2,
        "feature_categories": 0,
        "feature_lookup_tables": 0,
        "feature_names": 0,
        "features": 11359,
        "game_data": 1,
        "game_data_labellers": 1,
        "game_data_labels": 122,
        "game_documents": 2,
        "game_flags": 0,
        "game_platforms": 5,
        "game_player_action_events": 4,
        "game_scripts": 3,
        "game_team_data": 0,
        "game_unlockable_contents": 13,
        "games": 1,
        "grade_levels": 14,
        "group_assessment_sequence_logs": 0,
        "group_assessment_sequences": 4,
        "group_games": 7,
        "group_grade_levels": 19,
        "group_users": 87,
        "groups": 8,
        "infact_activities": 0,
        "infact_activity_game_configs": 0,
        "infact_game_configs": 0,
        "infact_game_videos": 0,
        "infact_grade_levels": 0,
        "infact_group_grade_levels": 0,
        "infact_group_subjects": 0,
        "infact_groups": 0,
        "infact_parent_infact_kids": 0,
        "infact_sequence_activities": 0,
        "infact_sequence_components": 0,
        "infact_sequence_game_results": 0,
        "infact_sequence_groups": 0,
        "infact_sequence_infact_components": 0,
        "infact_sequence_infact_themes": 0,
        "infact_sequence_kids": 0,
        "infact_sequence_progresses": 0,
        "infact_sequence_subjects": 0,
        "infact_sequence_themes": 0,
        "infact_sequence_topics": 0,
        "infact_sequences": 0,
        "infact_subjects": 0,
        "infact_user_grade_levels": 0,
        "infact_user_subjects": 0,
        "infact_users": 0,
        "level_groups": 0,
        "levels": 0,
        "locations": 0,
        "organizations": 4,
        "platforms": 8,
        "playback_categories": 2,
        "playback_visualisation_groups": 0,
        "playback_visualisations": 0,
        "primary_labeller_assignments": 0,
        "research_instruments": 3,
        "schema_migrations": 369,
        "states": 50,
        "subjects": 5,
        "system_settings": 1,
        "teams": 0,
        "unique_sequences": 3,
        "user_assessments": 27,
        "user_data": 0,
        "user_games": 1,
        "user_grade_levels": 321,
        "user_infact_grade_levels": 0,
        "user_infact_subjects": 0,
        "user_sessions": 41,
        "user_sessions_old": 0,
        "user_sessions_old2": 0,
        "users": 3
    },
    "khan": {
        "classrooms": 50,
        "learning_time_daily": 116237,
        "offset_classroom": 50,
        "offset_student": 644,
        "question_attempts": 2685241,
        "skill_mastery_changes": 963740,
        "users": 644
    }
}

RDS_CA_URL = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem"
AWS_CONFIG = Config(retries={"mode": "standard", "max_attempts": 10})


def short(error):
    response = getattr(error, "response", None)
    code = response.get("Error", {}).get("Code") if isinstance(response, dict) else None
    message = error.args[0] if error.args and isinstance(error.args[0], str) else str(error)
    text = message.strip().splitlines()[0] if message.strip() else type(error).__name__
    return f"{code}: {text}" if code and code not in text else text


def masked(url):
    parts = urllib.parse.urlsplit(url)
    if not parts.password:
        return url
    return parts._replace(netloc=parts.netloc.replace(f":{parts.password}@", ":****@")).geturl()


variables = []


def setting(name, default=None, why=None, secret=False):
    """The value of an environment variable, or its default, noting which for the report."""
    value = os.environ.get(name)
    if value:
        variables.append(("set", name, masked(value) if secret else value))
        return value
    if default is None:
        variables.append(("MISSING", name, why or "no default"))
        return None
    variables.append(("not set", name, f"using {default}" + (f" ({why})" if why else "")))
    return default


def detect_environment(region):
    try:
        account = boto3.client("sts", region_name=region, config=AWS_CONFIG).get_caller_identity()["Account"]
    except Exception as error:
        return None, f"no AWS credentials: {short(error)}"
    if account in ACCOUNTS:
        return ACCOUNTS[account], f"from AWS account {account}"
    return None, f"AWS account {account} is not a CRATE environment"


def expected_for(source, environment):
    counts = EXPECTED.get(source, {})
    if counts and set(counts) <= set(SUFFIX):
        counts = counts.get(environment, {})
    return counts


def collect(futures):
    counts = {}
    for table, future in futures.items():
        error = future.exception()
        counts[table] = error if error else future.result()
    return counts


def parquet_counts(bucket, prefix, region):
    import pyarrow.fs
    import pyarrow.parquet

    prefix = prefix.lstrip("/")
    s3 = boto3.client("s3", region_name=region, config=AWS_CONFIG)
    keys = [
        item["Key"]
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix)
        for item in page.get("Contents", [])
    ]
    if not keys:
        raise RuntimeError(f"s3://{bucket}/{prefix} is empty")

    # Each file is counted on its own, so a missing date range shows up; a folder of parts counts as one
    tables = {}
    for key in keys:
        if not key.endswith(".parquet"):
            continue
        relative = key[len(prefix):]
        table = relative.split("/")[0] if "/" in relative else relative[: -len(".parquet")]
        tables.setdefault(table, []).append(key)

    # Only the footer of each file is read; boto3's credentials work wherever the script runs
    credentials = boto3.Session().get_credentials().get_frozen_credentials()
    fs = pyarrow.fs.S3FileSystem(
        access_key=credentials.access_key,
        secret_key=credentials.secret_key,
        session_token=credentials.token,
        region=region,
    )

    def rows(files):
        return sum(pyarrow.parquet.ParquetFile(fs.open_input_file(f"{bucket}/{key}")).metadata.num_rows for key in files)

    with cf.ThreadPoolExecutor(8) as pool:
        futures = {table: pool.submit(rows, files) for table, files in tables.items()}
    counts = collect(futures)
    others = len(keys) - sum(len(files) for files in tables.values())
    return counts, f"{len(keys)} objects" + (f", {others} not parquet and not counted" if others else "")


def athena_counts(database, workgroup, region, timeout):
    glue = boto3.client("glue", region_name=region, config=AWS_CONFIG)
    tables = [
        table["Name"]
        for page in glue.get_paginator("get_tables").paginate(DatabaseName=database)
        for table in page["TableList"]
    ]
    athena = boto3.client("athena", region_name=region, config=AWS_CONFIG)

    def count(table):
        quoted = table.replace('"', '""')
        execution = athena.start_query_execution(
            QueryString=f'SELECT COUNT(*) FROM "{quoted}"',
            QueryExecutionContext={"Database": database},
            WorkGroup=workgroup,
        )["QueryExecutionId"]
        deadline = time.monotonic() + timeout
        delay = 0.5
        while True:
            status = athena.get_query_execution(QueryExecutionId=execution)["QueryExecution"]["Status"]
            if status["State"] == "SUCCEEDED":
                break
            if status["State"] in ("FAILED", "CANCELLED"):
                raise RuntimeError(status.get("StateChangeReason", status["State"]))
            if time.monotonic() > deadline:
                athena.stop_query_execution(QueryExecutionId=execution)
                raise TimeoutError(f"no result after {timeout}s")
            time.sleep(delay)
            delay = min(delay * 2, 5)
        rows = athena.get_query_results(QueryExecutionId=execution)["ResultSet"]["Rows"]
        return int(rows[1]["Data"][0]["VarCharValue"])

    with cf.ThreadPoolExecutor(8) as pool:
        futures = {table: pool.submit(count, table) for table in tables}
    return collect(futures), f"workgroup {workgroup}"


def rds_ca_bundle():
    """The RDS CA bundle, so TLS to the sample databases is verified; None if it cannot be fetched."""
    path = os.path.join(os.environ["CRATE_CHECK_CACHE"], "rds-global-bundle.pem")
    if not os.path.exists(path):
        try:
            import certifi

            context = ssl.create_default_context(cafile=certifi.where())
            with urllib.request.urlopen(RDS_CA_URL, timeout=20, context=context) as response:
                data = response.read()
            with open(path, "wb") as file:
                file.write(data)
        except Exception as error:
            print(f"Warning: could not fetch {RDS_CA_URL} ({short(error)}); TLS to the databases is not verified", file=sys.stderr)
            return None
    return path


def database_settings(source, why):
    """The connection to a sample database from its client's environment variables, or None if one is missing."""
    names = DB_VARIABLES[source]
    db = {
        "host": setting(names["host"], why=why),
        "port": setting(names["port"], DB_DEFAULT_PORT[source]),
        "user": setting(names["user"], why=why),
        "password": setting(names["password"], why=why, secret=True),
        "database": setting(names["database"], why=why),
    }
    return None if any(value is None for value in db.values()) else db


def postgres_counts(db, timeout):
    import psycopg
    from psycopg import sql

    ca = rds_ca_bundle()
    tls = {"sslmode": "verify-full", "sslrootcert": ca} if ca else {"sslmode": "require"}
    with psycopg.connect(
        host=db["host"],
        port=int(db["port"]),
        user=db["user"],
        password=db["password"],
        dbname=db["database"],
        connect_timeout=10,
        autocommit=True,
        options=f"-c statement_timeout={timeout * 1000}",
        **tls,
    ) as conn:
        # The schema the loader restores into (iac management-app/db-loader/postgres/load.sh)
        tables = [
            row[0]
            for row in conn.execute(
                "SELECT table_name FROM information_schema.tables"
                " WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
            )
        ]
        counts = {}
        for table in tables:
            try:
                query = sql.SQL("SELECT count(*) FROM public.{}").format(sql.Identifier(table))
                counts[table] = conn.execute(query).fetchone()[0]
            except Exception as error:
                counts[table] = error
    return counts, f"database {db['database']} on {db['host']}"


def mysql_counts(db, timeout):
    import pymysql

    ca = rds_ca_bundle()
    conn = pymysql.connect(
        host=db["host"],
        port=int(db["port"]),
        user=db["user"],
        password=db["password"],
        database=db["database"],
        ssl={"ca": ca} if ca else {"check_hostname": False},
        connect_timeout=10,
        read_timeout=timeout,
    )
    counts = {}
    with conn, conn.cursor() as cursor:
        cursor.execute(
            "SELECT table_name FROM information_schema.tables"
            " WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name"
        )
        for (table,) in cursor.fetchall():
            try:
                cursor.execute(f"SELECT COUNT(*) FROM `{table.replace('`', '``')}`")
                counts[table] = cursor.fetchone()[0]
            except Exception as error:
                counts[table] = error
    return counts, f"database {db['database']} on {db['host']}"


def google_credentials(path, region):
    """Credentials from the file GOOGLE_APPLICATION_CREDENTIALS names.

    In a workspace that file is the workload identity federation config the Coder template writes, which
    trades the task role's AWS credentials for a Google token. Google's library only looks for those in
    environment variables or EC2 metadata, and Fargate serves them from neither, so they are handed over
    from boto3, which reads them where Fargate does serve them. Any other kind of file (a laptop's
    application default credentials) is loaded as it is.
    """
    import google.auth
    from google.auth import aws

    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    with open(path) as file:
        config = json.load(file)
    source = config.get("credential_source", {})
    if config.get("type") != "external_account" or not source.get("environment_id", "").startswith("aws"):
        credentials, _ = google.auth.load_credentials_from_file(path, scopes=scopes)
        return credentials

    session = boto3.Session()

    class TaskRole(aws.AwsSecurityCredentialsSupplier):
        def get_aws_security_credentials(self, context, request):
            found = session.get_credentials()
            if found is None:
                raise RuntimeError("no AWS credentials to exchange for a Google token")
            frozen = found.get_frozen_credentials()
            return aws.AwsSecurityCredentials(frozen.access_key, frozen.secret_key, frozen.token)

        def get_aws_region(self, context, request):
            return region

    return aws.Credentials(
        audience=config["audience"],
        subject_token_type=config["subject_token_type"],
        token_url=config["token_url"],
        service_account_impersonation_url=config.get("service_account_impersonation_url"),
        universe_domain=config.get("universe_domain", "googleapis.com"),
        aws_security_credentials_supplier=TaskRole(),
        scopes=scopes,
    )


def bigquery_counts(project, dataset, credentials_path, region, timeout):
    from google.cloud import bigquery

    client = bigquery.Client(project=project, credentials=google_credentials(credentials_path, region))
    tables = [table.table_id for table in client.list_tables(f"{project}.{dataset}")]

    def count(table):
        rows = client.query(f"SELECT COUNT(*) FROM `{project}.{dataset}.{table}`").result(timeout=timeout)
        return next(iter(rows))[0]

    with cf.ThreadPoolExecutor(8) as pool:
        futures = {table: pool.submit(count, table) for table in tables}
    return collect(futures), f"dataset {project}.{dataset}"


def compare(counts, expected):
    """Rows for the report, and the source's status."""
    rows, wrong, new = [], 0, 0
    for table in sorted(set(counts) | set(expected)):
        got, want = counts.get(table), expected.get(table)
        if isinstance(got, Exception):
            rows.append(("ERROR", table, "", short(got)))
            wrong += 1
        elif got is None:
            rows.append(("MISSING", table, "", f"expected {want:,}, table not found"))
            wrong += 1
        elif want is None:
            rows.append(("NEW", table, f"{got:,}", "no expected count"))
            new += 1
        elif got != want:
            rows.append(("WRONG", table, f"{got:,}", f"expected {want:,}"))
            wrong += 1
        else:
            rows.append(("ok", table, f"{got:,}", ""))

    if not rows:
        return rows, "FAIL", "no tables found"
    if wrong:
        return rows, "FAIL", f"{wrong} of {len(rows)} tables wrong, missing or failed"
    if not expected:
        return rows, "WARN", f"{len(rows)} tables counted, no expected counts recorded"
    if new:
        return rows, "WARN", f"{len(rows) - new} tables match, {new} have no expected count"
    return rows, "PASS", f"all {len(rows)} tables match"


def main():
    parser = argparse.ArgumentParser(prog="check-data-sources.sh", description="Check the CRATE sample data sources.")
    parser.add_argument("--only", help=f"comma-separated sources to check: {', '.join(SOURCES)}")
    parser.add_argument("--timeout", type=int, default=600, help="seconds to allow each count query (default 600)")
    parser.add_argument("--baseline", action="store_true", help="also print the counts in the form EXPECTED takes")
    args = parser.parse_args()

    selected = list(SOURCES)
    if args.only:
        selected = [name.strip() for name in args.only.split(",") if name.strip()]
        unknown = [name for name in selected if name not in SOURCES]
        if unknown:
            parser.error(f"unknown source {', '.join(unknown)}; choose from {', '.join(SOURCES)}")

    region = setting("AWS_REGION", "us-east-1")
    detected, how = detect_environment(region)
    environment = setting("CRATE_ENV", detected, how)
    if environment not in SUFFIX:
        sys.exit(f"Error: cannot tell the environment ({how}); set CRATE_ENV to one of {', '.join(SUFFIX)}")
    suffix = SUFFIX[environment]

    checks = {}
    if "openstax" in selected:
        bucket = setting("HIGHLIGHTS_S3_BUCKET_NAME", f"safeinsights-test-data-s3{suffix}")
        prefix = setting("HIGHLIGHTS_S3_BUCKET_PREFIX", "/tutor/v2/")
        bucket_region = setting("HIGHLIGHTS_S3_BUCKET_REGION", region)
        checks["openstax"] = lambda: parquet_counts(bucket, prefix, bucket_region)

    if any(source in ATHENA_DATABASES for source in selected) or os.environ.get("AWS_ATHENA_DATABASE_NAME"):
        workgroup = setting("AWS_ATHENA_WORK_GROUP", f"crate-test-data-workgroup{suffix}")
        for source, database in ATHENA_DATABASES.items():
            if source in selected:
                checks[source] = lambda database=database: athena_counts(database, workgroup, region, args.timeout)
        # The management app sets this for the study's own data environment when that is in Athena
        own = setting("AWS_ATHENA_DATABASE_NAME", why="set only when the study's data environment is in Athena")
        if own and own not in ATHENA_DATABASES.values():
            SOURCES["workspace"] = f"This workspace's Athena database {own}"
            checks["workspace"] = lambda: athena_counts(own, workgroup, region, args.timeout)

    for source, count in (("quill", postgres_counts), ("terc", mysql_counts)):
        if source in selected:
            # No defaults but the port: iac's Coder template sets these, so a missing one is the template's fault
            why = "the Coder template sets no sample-data variables in demo" if environment == "demo" else (
                "the Coder template should set it; check sample_data_postgres, sample_data_mysql and"
                " sample_data_secrets in its tfvars"
            )
            db = database_settings(source, why)
            checks[source] = (lambda db=db, count=count: count(db, args.timeout)) if db else (
                f"{', '.join(DB_VARIABLES[source].values())} are not all set"
            )

    if "khan" in selected:
        # The Coder template sets this and writes the file when its tfvars name a GCP identity provider
        credentials_path = setting(
            "GOOGLE_APPLICATION_CREDENTIALS",
            why="the Coder template sets it when its tfvars set gcp_workload_identity_provider",
        )
        # Khan Academy's research container reads these two
        google_project = os.environ.get("GOOGLE_CLOUD_PROJECT")
        project = setting("GCP_PROJECT", google_project or KHAN_PROJECT, "from GOOGLE_CLOUD_PROJECT" if google_project else None)
        dataset = setting("BQ_DATASET", KHAN_DATASET)
        if credentials_path:
            checks["khan"] = lambda: bigquery_counts(project, dataset, credentials_path, region, args.timeout)
        else:
            checks["khan"] = "GOOGLE_APPLICATION_CREDENTIALS is not set"

    print(f"CRATE data source check, {environment} environment\n")
    print("Environment variables")
    width = max(len(name) for _, name, _ in variables)
    for status, name, value in variables:
        print(f"  {status:<8} {name:<{width}}  {value}")

    results = {}
    for source, check in checks.items():
        print(f"\n== {SOURCES[source]}")
        if isinstance(check, str):
            print(f"  not checked: {check}")
            results[source] = ("FAIL", check, {})
            continue
        print("  counting rows ...", flush=True)
        try:
            counts, where = check()
        except Exception as error:
            print(f"  ERROR {short(error)}")
            results[source] = ("FAIL", short(error), {})
            continue
        rows, status, summary = compare(counts, expected_for(source, environment))
        print(f"  {where}")
        table_width = max([len(table) for _, table, _, _ in rows] + [5])
        count_width = max([len(count) for _, _, count, _ in rows] + [1])
        for mark, table, count, note in rows:
            print(f"  {mark:<8} {table:<{table_width}}  {count:>{count_width}}  {note}".rstrip())
        results[source] = (status, summary, counts)

    print("\nSummary")
    for source, (status, summary, _) in results.items():
        print(f"  {status:<5} {source:<12} {summary}")

    if args.baseline:
        baseline = {
            source: {table: count for table, count in sorted(counts.items()) if isinstance(count, int)}
            for source, (_, _, counts) in results.items()
            if counts
        }
        print("\nEXPECTED = " + json.dumps(baseline, indent=4))

    sys.exit(1 if any(status == "FAIL" for status, _, _ in results.values()) else 0)


main()
PY
