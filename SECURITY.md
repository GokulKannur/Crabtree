# CrabTree Security

Version: `v3.2.0`  
Last Updated: `2026-02-17`

## Security Model

CrabTree uses a layered model:

1. Frontend path validation and traversal blocking
2. Backend allowlist enforcement for read/write operations
3. Workspace trust gating for risky capabilities
4. Regex safety limits to prevent catastrophic backtracking
5. Safe rendering practices for user-controlled content

## Implemented Protections

### File Access and Path Safety

- `approve_path` allowlist gate in backend
- `validate_write_path` enforcement for save operations
- Traversal checks for `../`, encoded traversal, and null-byte input
- Unified save helper flow in frontend (`safeSaveToPath`)

### Regex and Search Safety

- Regex input validation (length, flags, nested quantifiers)
- Worker-thread regex execution path with time budget
- Cancelation of stale searches

### CSV Safety

- RFC4180-compatible CSV parsing behavior
- Formula neutralization on CSV export (`=`, `+`, `-`, `@` prefixed)

### UI and Content Safety

- Escaped output for user content in rendered HTML contexts
- CSP configured in `src-tauri/tauri.conf.json`

### Workspace Trust Controls

- Restricted mode for untrusted worktrees
- Trust-aware extension/task execution gates
- Extension unload and reload flow tied to workspace trust state

## Validation and Testing

Current automated checks:

- `npm test`: 44 tests passing
- `npm run benchmark:ci`: threshold-gated benchmark pass
- `npm run build`: frontend production build pass

Test coverage includes:

- Regex safety and timeout behavior
- CSV parser correctness and formula neutralization
- Path traversal blocking checks
- Worktree trust behavior
- Extension path safety checks

## Reporting

If you find a security issue, open a private report with reproduction steps, impact, and affected files.
