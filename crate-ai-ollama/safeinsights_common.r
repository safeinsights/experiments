# safeinsights_common.R
# Functions to make a researchers' life easier when creating their analysis
# code in R.

# Load required libraries
library(httr)  # For sending files to an API

# Function to set Trusted Output App Endpoint and Credentials from the environment
# Args: none
toa_set_endpoint_and_creds <- function(){
  # Set Trusted Output App API Endpoint
  trusted_output_endpoint <- Sys.getenv("TRUSTED_OUTPUT_ENDPOINT")

  # Retrieve the basic auth credentials from the environment variable
  auth_credentials <- Sys.getenv("TRUSTED_OUTPUT_BASIC_AUTH")

  # Split the credentials into username and password
  auth_parts <- strsplit(auth_credentials, ":", fixed = TRUE)[[1]]
  username <- auth_parts[1]
  password <- auth_parts[2]

  return(list(endpoint = trusted_output_endpoint, username = username, password = password))
}

# Function to Tell the TOA The Research Analysis as started
# Args: none
toa_job_start <- function() {

  # Set Trusted Output App API Endpoint from Function
  toa <- toa_set_endpoint_and_creds()

  response <- PUT(
    url = toa$endpoint,
    body = toJSON(list(status = "JOB-RUNNING"), auto_unbox = TRUE),
    encode = "json",
    authenticate(toa$username, toa$password),
    content_type_json()
  )

  response_content <- content(response, as = "parsed", type = "application/json")
  print(response_content)
}

# Function to upload results to Trusted Output App
# Args:
#   results_file: The file containing the results of the analysis
toa_results_upload <- function(results_file) {

  # Set Trusted Output App API Endpoint from Function
  toa <- toa_set_endpoint_and_creds()

  response <- POST(
    url = paste0(toa$endpoint, "/upload"),
    body = list(file = upload_file(results_file)),  # Attach the results file
    encode = "multipart",  # Multipart form data encoding
    authenticate(toa$username, toa$password)
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
}