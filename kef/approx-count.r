# this main.r is a starting point for testing the MVP by actually connecting
# the data. Notes and Highlights RDS instance has been deployed. Commented
# sections of the code are for functions that will be moved to the
# safeinsights_common.R file

library(httr)  # For sending files to an API
library(readr) # For writing CSV files
library(jsonlite)
library(RPostgres) # For PostgreSQL connection

###############################################################################
# import from safeinsights_common.R
# Set Trusted Output App API Endpoint
trusted_output_endpoint <- Sys.getenv("TRUSTED_OUTPUT_ENDPOINT")

# Retrieve the basic auth credentials from the environment variable
auth_credentials <- Sys.getenv("TRUSTED_OUTPUT_BASIC_AUTH")

###############################################################################
# import from safeinsights_common.R
# Split the credentials into username and password
auth_parts <- strsplit(auth_credentials, ":", fixed = TRUE)[[1]]
username <- auth_parts[1]
password <- auth_parts[2]

response <- PUT(
  url = trusted_output_endpoint,
  body = toJSON(list(status = "JOB-RUNNING"), auto_unbox = TRUE),
  encode = "json",
  authenticate(username, password),  # Add the basic authentication
  content_type_json()
)
response_content <- content(response, as = "parsed", type = "application/json")
print(response_content)

###############################################################################
# Insert RDS Connection and Query code here
db_host <- Sys.getenv("HIGHLIGHTS_DB_HOST")
db_port <- Sys.getenv("HIGHLIGHTS_DB_PORT")
db_user <- Sys.getenv("HIGHLIGHTS_DB_USER")
db_password <- Sys.getenv("HIGHLIGHTS_DB_PASSWORD")
db_name <- Sys.getenv("HIGHLIGHTS_DB_NAME")

# Establish a connection to the PostgreSQL database
con <- dbConnect(
  drv = Postgres(),
  host = db_host,
  port = db_port,
  dbname = db_name,
  user = db_user,
  password = db_password
)

# Check the connection
if (!dbIsValid(con)) {
  stop("Failed to connect to the database.")
} else {
  print("Successfully connected to the database!")
}

###############################################################################
# Summary Statistics Queries

# Run COUNT(id) and time it
count_time <- system.time({
  highlights_count_by_id <- dbGetQuery(con,
    "SELECT reltuples::BIGINT as approx_count from pg_class WHERE relname = 'highlights'"
  )
})

# Run EXPLAIN to check query plan
explain_plan_result <- dbGetQuery(con,
  "EXPLAIN SELECT reltuples::BIGINT as approx_count from pg_class WHERE relname = 'highlights'"
)

# Convert explain plan (which is a data frame with 1 column) to a character vector
explain_plan_text <- paste(explain_plan_result[[1]], collapse = "\n")

# Prepare output strings
count_result_str <- capture.output({
  cat("=== Approximate Count Result ===\n")
  print(highlights_count_by_id)
  cat("\n")
})

count_time_str <- capture.output({
  cat("=== COUNT(id) Query Time (s) ===\n")
  print(count_time["elapsed"])
  cat("\n")
})

explain_str <- c("=== EXPLAIN Plan ===", explain_plan_text, "")

# Write everything to a single text file, put in csv_file_path which will be used by the POST later
csv_file_path <- "count_id_query_output.txt"
writeLines(c(count_result_str, count_time_str, explain_str), con = csv_file_path)

# Optional log message
cat("Wrote output to:", csv_file_path, "\n")

print("Finished everything.")


###############################################################################
# Insert Analysis code here







###############################################################################
# import from safeinsights_common.R
# Send aggregate results to Trusted Output App
# Make the POST request with basic authentication
response <- POST(
  url = paste0(trusted_output_endpoint, "/upload"),
  body = list(file = upload_file(csv_file_path)),  # Attach the CSV file
  encode = "multipart",  # Multipart form data encoding
  authenticate(username, password)  # Add the basic authentication
)

# DEBUG: Print the response content
response_content <- content(response, as = "parsed", type = "application/json")
print(response_content)

# Check the API response
if (response$status_code == 200) {
  print("File uploaded successfully.")
} else {
  print(paste("File upload failed. Status code:", response$status_code))
}







