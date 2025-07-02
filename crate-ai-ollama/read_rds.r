# read_db.R

# Load required libraries
library(RPostgres)
library(jsonlite)

# Functions to run SQL queries and retrieve data from a databases.
# 
# R requires a driver for each database type, so there is likely a function
# per database type, but with the same args.
# Args:
#   db_host:     Hostname of the database server
#   db_port:     Port number of the database server
#   db_name:     Name of the database
#   db_user:     Username for accessing the database
#   db_password: Password for accessing the database
#   sql_query:   SQL query to execute on the database
#   output_file: File path to save the query results

query_postgres_db <- function(db_host, db_port, db_name, db_user, db_password, sql_query, output_file) {
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

  # Run the SQL Query
  query_result <- dbGetQuery(con, sql_query)

  return(query_result)
}