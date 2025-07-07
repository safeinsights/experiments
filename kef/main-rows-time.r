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

# Grab an example row
query_time <- system.time({
  example_row_query_result <- dbGetQuery(con,
  "SELECT * FROM highlights LIMIT 5" #select 5 rows from highlights, all columns
)
})
print("Finished row query.")

# Prepare output strings
query_time_str <- capture.output({
  cat("=== Example Row Query Time ===\n")
  print(query_time)
  cat("\n")
})

example_row_str <- capture.output({
  cat("=== Example Row Query Result ===\n")
  print(example_row_query_result)
  cat("\n")
})


# Write/append to text file
csv_file_path <- "query_result.txt"

writeLines(c("Example Row Query Result:", example_row_str,
             "Row query took (in seconds):", query_time_str),
           con = csv_file_path,
           sep = "\n")



# DBM test ----------------------------------------------------------------

# query_time_row <- system.time({
#     table_row <- dbGetQuery(con,
#                             "SELECT COUNT(*) AS row_count
#                             FROM highlights;" #count num rows
#     )
# })
# print(query_time_row)
#
# query_time_col <- system.time({
#     table_col <- dbGetQuery(con,
#                             "SELECT COUNT(*) AS column_count
#                             FROM information_schema.columns
#                             WHERE table_name = 'highlights';" # count num cols
#     )
# })
#
#
# print(query_time_col)
#
# write_csv(data_frame(table_row, table_col), file= "table_dimensions.csv")
highlights_2025 <- dbGetQuery(con,
                              "SELECT *
                               FROM highlights
                               WHERE created_at >= '2025-01-01' AND created_at <= '2025-06-30';")


###############################################################################
# Insert Analysis code here

library(tidyverse)
str(highlights_2025)
highlights_2025_color <- highlights_2025 %>%
    group_by(color) %>%
    count()
print("Completed the counts by highlight color")
write_csv("./highlights_2025_color.csv")


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
