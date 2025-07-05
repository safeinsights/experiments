# this main.r is a starting point for testing the MVP by actually connecting
# the data. Notes and Highlights RDS instance has been deployed. Commented
# sections of the code are for functions that will be moved to the
# safeinsights_common.R file

library(httr)  # For sending files to an API
library(readr) # For writing CSV files
library(jsonlite)
library(RPostgres) # For PostgreSQL connection
# kef added, not sure it is available
library(DBI)
library(dplyr)
library(readr)
library(lubridate)

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

# Query 1000 rows from highlights created in 2023
query_time <- system.time({
  highlights_2023 <- dbGetQuery(con, "
    SELECT * FROM highlights
    WHERE created_at >= '2023-01-01' AND created_at < '2024-01-01'
    LIMIT 10000
  ")
})

print(paste("Finished highlights query in", query_time["elapsed"], "seconds"))

# Convert created_at to proper date-time if needed
highlights_2023$created_at <- ymd_hms(highlights_2023$created_at)

# ---- Summary Block ----
total_rows <- nrow(highlights_2023)
unique_users <- length(unique(highlights_2023$user_id))
unique_books <- length(unique(highlights_2023$scope_id))

summary_df <- data.frame(
  Metric = c("Total Rows", "Unique Users", "Unique Books"),
  Value = c(total_rows, unique_users, unique_books)
)

# ---- User Summary ----
user_summary <- highlights_2023 %>%
  group_by(user_id) %>%
  summarise(
    highlights_count = n(),
    annotations_count = sum(!is.na(annotation)),
    .groups = "drop"
  )

# ---- Top User  ----
# Determine the user with the most annotations
top_user <- user_summary %>%
  arrange(desc(annotations_count)) %>%
  slice(1) %>%
  pull(user_id)

# ---- Sample Top User  ----
sample_preview <- highlights_2023 %>%
  filter(user_id == top_user & !is.na(annotation)) %>%
  slice_head(n = 5)



# ---- Book Summary ----
book_summary <- highlights_2023 %>%
  group_by(scope_id) %>%
  summarise(
    highlights_count = n(),
    .groups = "drop"
  )
# Replace user_id with anonymous labels
user_summary$user_id <- paste0(seq_len(nrow(user_summary)))

# ---- Write All to One CSV File ----
csv_file_path <- "highlight_2023_summary.csv"

# Write summary block first
write.table(summary_df, file = csv_file_path, sep = ",", row.names = FALSE, col.names = TRUE)

# Append sample preview
write("\n\nSample Preview (Top Annotator)\n", file = csv_file_path, append = TRUE)
write.table(sample_preview, file = csv_file_path, sep = ",", row.names = FALSE, col.names = TRUE, append = TRUE, quote = TRUE)

# Append book summary
write("\n\nBook Summary\n", file = csv_file_path, append = TRUE)
write.table(book_summary, file = csv_file_path, sep = ",", row.names = FALSE, col.names = TRUE, append = TRUE)

# Append user summary
write("\n\nUser Summary\n", file = csv_file_path, append = TRUE)
write.table(user_summary, file = csv_file_path, sep = ",", row.names = FALSE, col.names = TRUE, append = TRUE)

print(paste("Wrote results to", csv_file_path))



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
