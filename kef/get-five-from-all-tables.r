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

# List of additional tables to inspect
tables_to_query <- c("users", "user_sources", "curator_scopes", "precalculusteds")

# Placeholder for all output strings
all_output <- c("=== Preview of Additional Tables ===", "")

# Loop through each table
for (table in tables_to_query) {
  cat(paste("Querying", table, "..."), "\n")
  
  query_result <- tryCatch({
    dbGetQuery(con, paste0("SELECT * FROM ", table, " LIMIT 5"))
  }, error = function(e) {
    return(data.frame(error = paste("Error querying table:", table, "-", e$message)))
  })
  
  output_block <- capture.output({
    cat(paste("=== Table:", table, "===\n"))
    print(query_result)
    cat("\n")
  })
  
  all_output <- c(all_output, output_block)
}

# Write all results to a single text file
csv_file_path <- "preview_additional_tables.txt"
writeLines(all_output, con = output_file)
cat("Wrote preview output to:", output_file, "\n")



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

