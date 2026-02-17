# CrabTree v3.2.0

CrabTree is a local-first desktop investigation app for large JSON, logs, and CSV files.
It is built with Tauri, Rust, and CodeMirror 6.

## What It Does

- Multi-tab editor with session restore
- JSON code/tree investigation with path navigation
- Log filtering with AND/OR/NOT and regex support
- CSV table viewer with large-file handling
- Global search, command palette, problems panel, and file finder
- Local processing only (no cloud dependency required)

## Security and Stability

CrabTree includes:

- Path traversal protection for save and open flows
- Allowlist-based file access enforcement in backend
- Regex safety validation for ReDoS protection
- Worker-thread regex search with timeout budget
- CSV formula neutralization on export
- Secret scanning guardrails and caching
- Workspace trust gating for risky actions

See `SECURITY.md` for full details.

## Development

Prerequisites:

- Node.js 18+
- Rust toolchain

Commands:

```bash
npm install
npm run dev
npm run build
npm test
npm run benchmark:quick
npm run benchmark:ci
```

## Build Desktop App and Installer (Windows)

Build release app + installer artifacts:

```bash
npm run tauri build -- --bundles nsis,msi
```

Output directories:

- `src-tauri/target/release/bundle/nsis/` for one-click `.exe` installer
- `src-tauri/target/release/bundle/msi/` for `.msi` installer

End users only run the installer. They do not need Node, Rust, or Tauri CLI.

## Release Notes

Current release: `v3.2.0`

Key updates in this release:

- Extension trust and unload flow improvements
- Bulk close error collection improvements
- Security hardening and path checks
- Incremental diagnostics refresh path
- Encoding cleanup in source files

## License

AGPL-3.0. See `LICENSE`.
