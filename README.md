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
- **Secret Detection** — Scans for AWS keys, Stripe tokens, RSA/PGP private keys, GitHub/GitLab tokens, JWTs, passwords. Shows severity-coded warning banner with clickable line numbers.
- **Path Traversal Protection** — Blocks `../`, URL-encoded traversal, null byte injection
- **Content Security Policy** — Strict CSP, no remote scripts
- **Allowlist-based file access** — Backend validates all paths against user-approved allowlist
- **Safe DOM rendering** — No innerHTML injection vectors

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
cargo tauri dev      # Run as desktop app
npm run dev          # Run frontend only (browser)
npm run build        # Production build
npm test             # Run tests
npm run benchmark    # Performance benchmarks
```

---

## Benchmarks

| Dataset | JSON Parse | JSON Path | JSON Locate | Log Filter | RSS |
|---------|----------:|----------:|------------:|-----------:|----:|
| 50 MB   | 991 ms    | 0.15 ms   | 2,809 ms    | 696 ms     | 704 MB |
| 200 MB  | 18,224 ms | 3.76 ms   | 13,216 ms   | 4,381 ms   | 1,480 MB |

```bash
npm run benchmark           # Full run
npm run benchmark:quick     # Quick run
```

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
