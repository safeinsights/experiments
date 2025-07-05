

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
output_file <- "preview_additional_tables.txt"
writeLines(all_output, con = output_file)
cat("Wrote preview output to:", output_file, "\n")
