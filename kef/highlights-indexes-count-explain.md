## 📊 Notes and Highlights Performance Info 

### Indexes in the PostgreSQL Table 

main.r file: <https://github.com/safeinsights/experiments/blob/main/kef/main-index.r>

### Code Snippet
```
# Find out what is indexed 
query_time <- system.time({
  highlights_indexes_result <- dbGetQuery(con,
    "SELECT * FROM pg_indexes WHERE tablename = 'highlights';"
  )
})
```

### 🧾 Results

```
Indexes Result:
=== Highlights Indexes Result ===
schemaname tablename indexname tablespace
1 public highlights highlights_pkey <NA>
2 public highlights index_highlights_on_next_highlight_id <NA>
3 public highlights index_highlights_on_prev_highlight_id <NA>
4 public highlights index_highlights_on_scope_id <NA>
5 public highlights index_highlights_on_source_type <NA>
6 public highlights index_highlights_on_user_id <NA>
7 public highlights index_highlights_on_user_id_and_source_id <NA>
indexdef
1 CREATE UNIQUE INDEX highlights_pkey ON public.highlights USING btree (id)
2 CREATE INDEX index_highlights_on_next_highlight_id ON public.highlights USING btree (next_highlight_id)
3 CREATE INDEX index_highlights_on_prev_highlight_id ON public.highlights USING btree (prev_highlight_id)
4 CREATE INDEX index_highlights_on_scope_id ON public.highlights USING btree (scope_id)
5 CREATE INDEX index_highlights_on_source_type ON public.highlights USING btree (source_type)
6 CREATE INDEX index_highlights_on_user_id ON public.highlights USING btree (user_id)
7 CREATE INDEX index_highlights_on_user_id_and_source_id ON public.highlights USING btree (user_id
```
### Counting performance
main.r file: <https://github.com/safeinsights/experiments/blob/main/kef/main-count-index-explain.r>

### ✅ Code Snippet for Count(id) (with `EXPLAIN` Plan)

```r
# Run COUNT(id) and time it
count_time <- system.time({
  highlights_count_by_id <- dbGetQuery(con,
    "SELECT COUNT(id) as highlights_count FROM highlights"
  )
})

# Run EXPLAIN to check query plan
explain_plan_result <- dbGetQuery(con,
  "EXPLAIN SELECT COUNT(id) FROM highlights"
)
```

---

### 🧾 Results

```
highlights_count
1 89574623
```

```
=== COUNT(id) Query Time (s) ===
elapsed
2248.446
```

```
=== EXPLAIN Plan ===
Finalize Aggregate (cost=2754949.23..2754949.24 rows=1 width=8)
  -> Gather (cost=2754949.02..2754949.23 rows=2 width=8)
     Workers Planned: 2
     -> Partial Aggregate (cost=2753949.02..2753949.03 rows=1 width=8)
        -> Parallel Index Only Scan using highlights_pkey on highlights 
           (cost=0.57..2661858.77 rows=36836100 width=16)
```

---

### 💬 What ChatGPT Said Might Explain the Long Runtime

Despite PostgreSQL using a **Parallel Index Only Scan**, the runtime was nearly identical to a full `COUNT(*)` (~37 minutes). This could be due to:

- 📦 The `highlights` table being **very large**
- 🧠 Even index-only scans are **bounded by I/O throughput**
- 📉 If the index is not fully cached in memory, performance suffers
- 🔍 PostgreSQL may need to **check tuple visibility**, which prevents skipping heap reads unless vacuuming is current

---

### 🔁 Optional Improvements Going Forward

#### 1. ⚡ Use Approximate Count for Dashboards or Monitoring

```sql
SELECT reltuples::BIGINT AS estimated_count 
FROM pg_class 
WHERE relname = 'highlights';
```

- Runs **instantly**
- Great for dashboards or exploratory summaries

---

#### 2. 🧱 Maintain a Materialized View

If exact counts are needed frequently but don't change often:

```sql
CREATE MATERIALIZED VIEW highlights_count_cache AS
SELECT COUNT(*) AS count FROM highlights;
```

And refresh it periodically (e.g. nightly):

```sql
REFRESH MATERIALIZED VIEW highlights_count_cache;
```

---

#### 3. 🧹 Ensure Regular Vacuuming

Run `VACUUM` or `ANALYZE` on the `highlights` table regularly:

- Helps PostgreSQL **skip heap visibility checks**
- Enables **true index-only scan** performance
