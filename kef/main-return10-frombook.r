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

# Query 10 rows with a specific scope_id
query_time <- system.time({
  scoped_highlights <- dbGetQuery(con,
    "SELECT * FROM highlights 
     WHERE scope_id = 'a7ba2fb8-8925-4987-b182-5f4429d48daa' 
     LIMIT 10"
  )
})

print(paste("Finished scoped query in", query_time["elapsed"], "seconds"))

# Write result to CSV
csv_file_path <- "scoped_highlights.csv"
write.csv(scoped_highlights, csv_file_path, row.names = FALSE)
print(paste("Wrote CSV to", csv_file_path))

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


