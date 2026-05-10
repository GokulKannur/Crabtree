# CrabTree — Known Issues

## Lifecycle

- **~~Session eviction uses `created_at` not `last_access`~~**: FIXED — `evict_stale_sessions` now uses `last_access_at` (wall-clock Instant updated on every `get_session` call). Active sessions are no longer prematurely evicted.

- **~~`open_file_session` has no MAX_SESSION_COUNT enforcement~~**: FIXED — `open_file_session` now evicts oldest inactive sessions (by `last_access` counter) when at capacity before inserting.

- **`compact_session_caches` only evicts empty inactive sessions**: Sessions with only small CSV/line indexes are not evicted even if stale. Could add age-based eviction to compaction.

## Memory

- **`ensure_json_index` still clones on return**: A full `JsonIndexCache` clone is unavoidable across the Mutex lock boundary. For very large indexes (96MB cap), this clone itself is expensive. Consider arc-wrapped shared indexes.

- **`filter_csv_rows` allocates matched rows into a Vec**: For huge match sets (5000 cap), this could be significant. Consider streaming results or handle-based paging.

- **JS `tab.content` holds full file content in memory**: Even for non-progressive files under 25MB, the full decoded content lives in JS. No eviction of inactive tab content.

## Cancellation

- **~~No Rust-side cancellation for long-running scans~~**: FIXED — `filter_log_session` and `filter_csv_rows` now support cooperative cancellation via `Arc<AtomicBool>` tokens. Cancellation is checked every 8192 lines (log) or 1024 rows (CSV). `cancel_filter` command triggers cancellation from JS. Session close also cancels in-flight operations.

- **Worker bridge `cancelAll()` sends cancel messages but worker may ignore them**: The query-worker.js doesn't implement cancel message handling — it relies on the bridge discarding stale responses.

## Query

- **Log filter scans entire file every time**: No incremental indexing or cached filter results. Repeated queries re-scan from byte 0.

- **JSON path lookup re-indexes on every query**: Each `lookup_json_path_session` call goes through `ensure_json_index` which checks cache compatibility but still acquires the lock twice.

## Build

- **System dependency**: GTK3 dev headers (`libgtk-3-dev`) required for Linux builds. Not documented in README.
