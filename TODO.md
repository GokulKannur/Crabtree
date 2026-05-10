# CrabTree — TODO

## High Priority

- [x] **Rust-side cancellation tokens**: Add `AtomicBool` abort signals to `filter_log_session`, `filter_csv_rows` for interruptible long-running scans.
- [x] **`last_access`-based session eviction**: Switch `evict_stale_sessions` to use `last_access_at` Instant instead of `created_at`.
- [x] **Session count cap enforcement**: Evict oldest inactive session in `open_file_session` when `FILE_SESSIONS.len() >= MAX_SESSION_COUNT`.
- [ ] **Arc-wrapped JSON indexes**: Replace `JsonIndexCache` cloning with `Arc<JsonIndexCache>` to eliminate the clone-across-lock-boundary overhead.
- [ ] **Cancellation for `build_json_index_cache`**: Add abort signal to JSON index building for very large files.

## Medium Priority

- [ ] **Extract JSON engine module** (`engine/json.rs`): Move `JsonScanner`, `JsonIndexNode`, `JsonIndexCache`, `build_json_index_cache`, `ensure_json_index`, `evict_json_indexes_if_needed` out of lib.rs.
- [ ] **Extract log engine module** (`engine/logs.rs`): Move `CompiledLogQuery`, `LogPredicate`, `LogCondition`, compilation and matching functions.
- [ ] **Extract CSV engine module** (`engine/csv.rs`): Move `CsvIndexCache`, `detect_csv_delimiter`, `parse_csv_record`, `build_csv_index`, `ensure_csv_index`.
- [ ] **Worker cancel message handling**: Implement `cancel` message type in `query-worker.js` to actually abort in-progress work.
- [ ] **Inactive tab content eviction**: Evict `tab.content` for non-active, non-modified tabs after a timeout. Re-load from disk on switch.
- [ ] **Log filter result caching**: Cache compiled query + result offsets per session to avoid full re-scan on repeated queries.

## Low Priority

- [ ] **Benchmark suite for native commands**: Add benchmark scripts for `filter_log_session`, `filter_csv_rows`, `index_json_session` with generated test data.
- [ ] **Session diagnostics UI panel**: Surface `get_session_diagnostics()` and `get_lifecycle_metrics()` output in a diagnostics panel.
- [ ] **CSV sort command**: Native Rust-backed column sort with bounded output.
- [ ] **Streaming query results**: Replace bulk Vec returns with handle-based paged retrieval for large result sets.
- [ ] **README build prerequisites**: Document `libgtk-3-dev` / `libwebkit2gtk-4.1-dev` requirements for Linux.
