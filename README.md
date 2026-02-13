# CrabTree

CrabTree is a local-first desktop tool for investigating massive JSON, logs, and CSVs.

Core promise:
- Viewer-first workflows for structured data.
- Native desktop performance (Tauri + Rust backend).
- No cloud dependency for analysis workflows.

## Why it is different

CrabTree is not positioned as a generic IDE clone.

It focuses on one painful workflow:
- Open huge data exports and logs.
- Filter/find root cause quickly.
- Jump directly to the exact value in editable source.

## Current capabilities

### Editor base
- Multi-tab code editor (CodeMirror 6).
- Open/save files and folders.
- Drag-and-drop file open.
- Recent files and state persistence.
- Theme, font size, wrap, line numbers.

### JSON investigation
- Code view + tree view toggle.
- Path query (`stats.errors`, `items[120].status`).
- Exact code jump for resolved JSON paths (line/column precise).
- JSON path autocomplete suggestions in query bar.

### Log investigation
- Structured log filter mode with:
  - `AND`, `OR`, `NOT`
  - field filters (`severity:`, `ip:`, `text:`, `message:`)
  - regex filters (`re:/.../i`)
- Inline parse feedback:
  - clause/term counts
  - tokenized filter interpretation chips
- Save and reuse log filters (persisted in local storage).
- Export filtered result set to a file.

### CSV investigation
- CSV/TSV table mode (viewer-first).
- Virtualized row rendering for large files.
- Column/row stats and delimiter detection.
- Fast switch between table and code modes.

### Large file safety
- Automatic read-only safety mode for large files.
- Progressive chunk loading.
- Explicit "Load Full File" controls.

## Query examples

Log queries:
- `severity:error AND ip:127.0.0.1`
- `severity:error AND NOT text:"health check"`
- `re:/timeout|latency/i OR severity:warn`

JSON path queries:
- `summary.errors`
- `items[4].stats.latency_ms`
- `path:items[42].status`

## Benchmarks

Run:

```bash
npm run benchmark
```

Artifacts:
- `benchmark/latest.json`
- `benchmark/latest.md`

### CrabTree core benchmark (auto-generated)

Latest run (from `benchmark/latest.md`):

| Dataset | JSON Parse (ms) | JSON Path (ms) | JSON Locate (ms) | Log Filter (ms) | RSS (MB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 50MB | 990.71 | 0.15 | 2809.09 | 695.54 | 704.4 |
| 200MB | 18223.67 | 3.76 | 13216.08 | 4380.81 | 1479.5 |

### VS Code comparison (manual)

Methodology — same machine, same files, cold start (no cache/recent), measured wall-clock:

| # | Dataset | Task | CrabTree (ms) | VS Code (ms) | Notes |
| --- | --- | --- | ---: | ---: | --- |
| 1 | 50 MB JSON | Open + parse | 990.71 | _measure_ | CrabTree: instant tree view ready |
| 2 | 50 MB JSON | Path lookup (`summary.errors`) | 0.15 | _measure_ | VS Code: Ctrl+G or Ctrl+F manual search |
| 3 | 50 MB JSON | Locate path in source (line+col) | 2,809 | _measure_ | VS Code: no built-in equivalent |
| 4 | 200 MB JSON | Open + parse | 18,224 | _measure_ | VS Code: may refuse to colorize or tree-view |
| 5 | 200 MB JSON | Path lookup (`summary.errors`) | 3.76 | _measure_ | VS Code: manual search across 200 MB |
| 6 | 200 MB log | Filter `severity:error AND NOT text:"health check"` | 4,381 | _measure_ | VS Code: no structured filter; Ctrl+F only |

**How to reproduce the CrabTree column:**

```bash
npm run benchmark          # full run (50 MB + 200 MB)
npm run benchmark:quick    # quick run (10 MB + 25 MB)
```

**How to fill in the VS Code column:**

1. Generate the test files:
   ```bash
   node scripts/generate-comparison-files.js
   ```
2. Open each file in VS Code (cold start: `code --disable-extensions <file>`).
3. Measure wall-clock time for:
   - **Open + parse**: time from `code <file>` until the editor is responsive.
   - **Path lookup**: use Ctrl+F to search for `"errors":` — time until first result.
   - **Log filter**: use Ctrl+F to search for `ERROR` — time until match count appears.
4. Record milliseconds in the table above.

## Dev setup

Prerequisites:
- Node.js 18+
- Rust toolchain

Commands:

```bash
npm install
npm run dev
npm run tauri dev
npm test
npm run build
npm run benchmark
npm run benchmark:quick
npm run benchmark:generate-files
```
"# Crabtree" 
