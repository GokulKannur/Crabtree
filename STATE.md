# CrabTree Current State

**Version:** v3.2.0  
**Release Date:** 2026-02-17  
**Maturity:** Investigation-grade stable

## Phase: Optimization & Hardening (Post-Feature-Complete)

The project has moved from feature development into profiling-guided optimization and hardening. Core investigation capabilities are stable; focus is now on scalability and lifecycle robustness.

## Recently Completed Architecture Work

- **v3.2.0** Release stabilization:
  - Extension trust and unload flow improvements
  - Bulk error collection enhancements
  - Path security checks formalized
  - Encoding artifact cleanup across codebase
  - Installer-based distribution (NSIS/MSI)

- **Session persistence**: Multi-tab restore working, localStorage-backed
- **Security posture**: Allowlist enforcement, regex safety, workspace trust gating
- **Indexing maturity**: JSON structural, CSV row offset, line offset all production-ready

## Current Optimization Focus

1. **JSON expansion**: Bounded depth to prevent pathological cases
2. **Worker cancellation**: Latest request cancels stale work immediately
3. **Preview capping**: Query results never exceed 1MB output
4. **IPC reduction**: Structural indexes avoid raw chunk transfers
5. **Cache governance**: LRU eviction prevents unbounded memory growth

## Scaling Direction

Current proven ceiling:
- **10MB file**: Parse 77ms, structural lookup 5ms, index ~2MB
- **25MB file**: Parse 172ms, structural lookup 12ms, index ~4.5MB

Bottleneck pressures identified:
- Deep JSON nesting causes structural lookup regression (O(depth))
- Large CSV files generate large row index (12% of file size)
- Multi-tab workloads pressure memory; index eviction becomes frequent
- Regex queries on large log files hit worker timeout budget at ~50MB raw content

## Current Engine Maturity

**Solved problems:**
- File session management (open/close/restore cycles stable)
- Range-read based file loading (avoids full-buffer memory spike)
- Bounded query previews (no runaway result generation)
- Newline offset indexing (line-based queries O(1) after index build)
- Native log filtering (AND/OR/NOT semantics correctly implemented)
- Rust-native regex (ReDoS protection in place)
- Persistent JSON structural indexes (disk-backed, versioned)
- Paged JSON child retrieval (sparse expansion supported)
- Native CSV row indexing (delimiter auto-detection working)
- Native CSV row paging (RFC4180 correct implementation)
- Cache governance (LRU, memory caps respected)
- Disk-backed indexes (version checking working)
- Lightweight editor mode (CodeMirror 6 integration stable)
- Worker cancellation (stale requests properly rejected)
- Session compaction (unused sessions evicted to disk)

**Remaining problems (non-blocking):**
- Deep JSON expansion still uses recursive traversal (could batch-fetch children)
- CSV formula neutralization only on export (not in-memory views)
- Regex timeout budget is static; large files might timeout unnecessarily
- Index invalidation requires full rebuild (no delta indexing)
- Session eviction is LRU, not cost-aware (large files get same treatment as small)

## Major Systems Implemented

- **Multi-tab editor**: Session restore, auto-save, per-tab state
- **JSON investigation**: Tree viewer, path resolution, structural search
- **Log filtering**: Tokenized query syntax, worker-thread execution, line highlighting
- **CSV viewer**: Virtualized rows, stats, auto-delimiter detection
- **Global search**: Cross-tab results, workspace document generation
- **Command palette**: Fuzzy finder with recency ranking
- **Diagnostics**: Linting for syntax errors, secret detection
- **Workspace trust**: Restricted mode for untrusted directories
- **Extension framework**: Task runner, extension host with trust gating
- **Benchmarking**: Automated performance tracking (JSON parse, query, IPC)

## Current Test Coverage

- 44 automated tests (npm test)
- Regex safety and timeout validation
- CSV parser correctness (RFC4180)
- Path traversal blocking
- Worktree trust gating
- Benchmark thresholds (CI pass gating)

## Known Working Capabilities

- File loading up to 100MB+ (with preview chunking)
- JSON files with 1M+ keys
- CSV files with 100k+ rows
- Regex filtering on 25MB+ log files (within timeout budget)
- Multi-tab sessions with 10+ files
- Session restore after restart
- Disk-backed index persistence
- Memory footprint ~350-800MB for typical workloads (10-25MB files)
