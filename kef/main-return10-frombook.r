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
