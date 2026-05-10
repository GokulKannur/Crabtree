# CrabTree Architecture

## Overview

CrabTree is a local-first desktop investigation engine for massive JSON, logs, and CSV files. Built on **Tauri + Rust + JavaScript + CodeMirror 6**.

## Core Systems

### Rust Backend (`src-tauri/src/`)

- **`lib.rs`** (~2300 lines) — Monolith containing all Tauri commands: file I/O, session management, JSON indexing, CSV indexing, log filtering, encoding detection, security allowlist, task runner.
- **`engine/cache.rs`** — JSON index memory cap and disk version constants.
- **`engine/sessions.rs`** — Session lifecycle constants: preview caps, range read limits, line read limits, session count ceiling, inactivity TTL.
- **`engine/mod.rs`** — Module declarations.

### JavaScript Frontend (`src/`)

- **`main.js`** (~4600 lines) — Application core: tabs, editor lifecycle, query system, view modes, session persistence, command palette, diagnostics, security scanning.
- **`worker-bridge.js`** — Promise-based worker API with auto-cancellation, stale cleanup (30s TTL), and dispose lifecycle.
- **`query-worker.js`** — Web Worker for log filtering, JSON path location, regex search.
- **`query-core.js`** — Query compilation, JSON path parsing, log filter execution.
- **`json-viewer.js`** — Tree-view JSON renderer.
- **`csv-viewer.js`** — Table-view CSV renderer with column stats.
- **`diagnostics-core.js`** — Content diagnostics (JSON validation, log severity detection).
- **`outline-core.js`** — Document outline extraction.
- **`command-palette.js`** — Command palette UI.
- **`fuzzy-index.js`** — Fuzzy file finder index.
- **`worktree-trust.js`** — Workspace trust/security boundaries.
- **`extension-host.js`** — Extension loading/execution.
- **`task-runner.js`** — Task execution UI.

## Key Architecture Decisions

### File Sessions
- Large files (>25MB) use **Rust file sessions** with range reads and progressive loading.
- Sessions are reference-counted via `fileSessionId` on tabs.
- **Inactivity eviction**: sessions older than 10 minutes are automatically swept by periodic JS timer calling `evict_inactive_sessions`.
- `beforeunload` fires `close_all_file_sessions` for clean shutdown.

### Bounded Execution
- JSON structural indexing is capped by `max_nodes`, `max_depth`, `max_bytes`.
- JSON child retrieval is hard-capped to 500 nodes per fetch (`MAX_JSON_CHILDREN_LIMIT`).
- CSV row reads are bounded per-page.
- Log filter results are capped at `max_results` (2000 for native, QUERY_PREVIEW_CHAR_LIMIT for JS).
- Regex patterns are size-limited to 256 chars with 2MB DFA limit.
- Range reads capped at 8MB per call.

### Cache Governance
- JSON indexes have a 96MB memory cap with LRU eviction.
- Session compaction strips indexes from inactive sessions.
- Empty sessions (no indexes, no offsets) are auto-evicted during compaction.
- Disk-backed JSON indexes with versioned cache keys.

### Security
- **Path allowlist**: Only user-opened paths are accessible. Cleared on quit.
- **Path traversal protection**: Canonical path resolution, symlink-escape blocking.
- **Secret detection**: Regex-based scanning for API keys, tokens, private keys.
- **Extension sandboxing**: Workspace trust boundaries for extension file access.

### Query System
- **JSON**: Path-based navigation (dot/bracket notation), locate-and-scroll.
- **Log**: Multi-clause boolean query (AND/OR/NOT), field filters, regex, severity filters.
- **Worker offloading**: Heavy queries run in Web Worker with auto-cancellation of stale requests.
- **Native fallback**: Large files use Rust-native filtering via `filter_log_session` / `filter_csv_rows`.

### Editor Lifecycle
- Only one CodeMirror instance lives at a time (destroyed on tab switch).
- Cursor position preserved across switches via `_savedCursorPos`.
- Tab teardown nullifies all heavy state (`disposeTabFullState`).
- Worker bridge has stale request cleanup (30s TTL) and `dispose()` on shutdown.
