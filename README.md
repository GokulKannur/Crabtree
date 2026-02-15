# 🦀 CrabTree v3

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

A local-first desktop tool for investigating massive JSON, logs, and CSVs. Built with Tauri + Rust + CodeMirror 6.

**Core promise**: Open huge data files, filter to root cause, jump to exact values — all without cloud dependency.

---

## Features

### 📝 Editor
- Multi-tab code editor (CodeMirror 6)
- Open/save files and folders with drag-and-drop
- Session persistence (tabs, state, layout restored on restart)
- Theme toggle (dark/light), font size, word wrap, line numbers

### 🔍 JSON Investigation
- Code view + interactive tree view toggle
- Path query bar (`stats.errors`, `items[120].status`)
- Exact line/column jump for resolved JSON paths
- JSON path autocomplete suggestions

### 📋 Log Investigation
- Structured filter: `AND`, `OR`, `NOT` operators
- Field filters: `severity:`, `ip:`, `text:`, `message:`
- Regex: `re:/timeout|latency/i`
- Tokenized filter visualization chips
- Save/reuse log filters (persisted)
- Export filtered results

### 📊 CSV Investigation
- Table view with virtualized rendering
- Column/row stats, delimiter auto-detection
- Switch between table and code views

### 📂 File Management
- Sidebar file explorer with folder tree
- Color-coded file type icons (80+ extensions)
- Breadcrumb path bar (Zed-inspired)
- Tab pinning, close-other/close-right actions
- Large file safety: auto read-only, progressive chunk loading

### ⚡ Power Features
- **Command Palette** (`Ctrl+Shift+P`) — Search all commands
- **Fuzzy File Finder** (`Ctrl+P`) — Quick-open files from tabs and folder tree
- **Problems Panel** (`Ctrl+Shift+E`) — Aggregate errors/warnings across tabs
- **Data Analyzer** — Statistical analysis modal for structured data
- **Go To Line** (`Ctrl+G`)

### 🔒 Security
- **Secret Detection** — Scans for AWS keys, Stripe tokens, RSA/PGP private keys, GitHub/GitLab tokens, JWTs, passwords. Capped at 10K lines, cached with FNV-1a hash, debounced after edits.
- **Regex Safety Gate** — Validates all user-provided regex patterns for catastrophic backtracking (nested quantifiers). Rejects patterns >256 chars.
- **Worker-Thread Regex** — Global search and multi-tab regex matching runs off-main-thread with time budgets (5s default). Prevents hangs.
- **CSV Safety** — RFC4180-compliant parser handles multiline quoted fields; formula injection neutralized (`=`, `+`, `-`, `@` prefixed with `'` on export).
- **Path Traversal Protection** — Blocks `../`, URL-encoded traversal, null byte injection. Unified `safeSaveToPath()` checks all save paths.
- **Content Security Policy** — Strict CSP, no remote scripts; Google Fonts allowed via `fonts.googleapis.com`/`fonts.gstatic.com`
- **Allowlist-based file access** — Backend validates all paths against user-approved allowlist; `validate_write_path()` enforces on save.
- **Safe DOM rendering** — No innerHTML injection vectors; all user content escaped before regex highlighting

### 🎨 Design
- Zed-inspired UI with exact Sand color scale
- Compact titlebar, seamless tabs, clean sidebar
- Thin scrollbars, transparent track
- Both dark and light themes

---

## Dev Setup

**Prerequisites**: Node.js 18+, Rust toolchain

```bash
npm install
cargo tauri dev           # Run as desktop app
npm run dev              # Run frontend only (browser)
npm run build            # Production build
npm test                 # Run all tests (30 tests, incl. security)
npm run benchmark        # Full performance benchmarks
npm run benchmark:quick  # Quick benchmarks (2 sizes)
npm run benchmark:ci     # CI-gated benchmarks with threshold checks
```

---

## Performance & Testing

### Benchmarks (Feb 2026, Node 20, single-pass)

| Dataset | JSON Parse | JSON Path | JSON Locate | Log Filter | RSS |
|---------|----------:|----------:|------------:|-----------:|----:|
| 10 MB   | 122 ms    | 0.11 ms   | 464 ms      | 112 ms     | 305 MB |
| 25 MB   | 325 ms    | 0.02 ms   | 1,016 ms    | 194 ms     | 435 MB |

**Stress scenarios** (CSV parsing 10MB: 354ms, regex validation 10K patterns: 2.2ms, multi-tab search: 103ms)

```bash
npm run benchmark              # Full 50MB + 200MB
npm run benchmark:quick        # Quick 10MB + 25MB
npm run benchmark:ci           # CI mode: quick + threshold checks, exits non-zero on regression
npm test                       # Unit + integration + security tests (30 tests)
```

### Test Suite
- **30 tests total**: 14 query/CSV functional + 16 new security-hardened tests
- **Regex ReDoS payloads** rejected: `(a+)+`, `(.*)*`, `(a{2,})+`, all >256 chars
- **CSV multiline + formula** injection neutralization verified
- **FNV-1a hash collisions** resistance confirmed
- **Coverage**: regex validation, worker timeouts, CSV RFC4180, CSV formula, cache correctness

---

## Security

See [SECURITY.md](SECURITY.md) for full details on security protections, secret detection patterns, and path validation.

---

## License

**GNU Affero General Public License v3 (AGPL-3.0)**

- ✅ Free to use for any purpose
- ✅ Free to modify and distribute
- ✅ Modifications must be open-sourced
- ✅ Network use covered (SaaS must share source)

See [LICENSE](LICENSE) for full terms.
