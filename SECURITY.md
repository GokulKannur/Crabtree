# CrabTree Security

**Version**: v3.1.0
**Last Updated**: 2026-02-15
**Status**: ✅ Production-Hardened (10 New Hardening Fixes)

---

## Overview

CrabTree handles sensitive data — logs, configs, exports, and files that may contain credentials. All security layers are active and enforced.

---

## v3.1.0 Hardening (Feb 2026)

This release includes 10 targeted security and performance hardening fixes:

### 1. **Regex ReDoS Safety Gate** (Critical)
**Problem**: User-provided regex patterns in global search and filter could cause catastrophic backtracking (ReDoS).  
**Fix**: `validateRegexInput(pattern, flags)` function validates all regex inputs:
- Length limit: 256 characters
- Flags validation: only `[gimsuy]` allowed
- Nested quantifier detection: rejects `(a+)+`, `(.*)*`, patterns that trigger backtracking
- Enforced at: query-core.js (parseRegexValue), main.js (runGlobalSearch, runRegexTest)

**Testing**: 5 new test cases covering ReDoS payloads; all rejected.

---

### 2. **Worker-Thread Regex Matching** (Performance)
**Problem**: Global search blocking main thread on large files; regex.test() called synchronously.  
**Fix**: New `regexSearch()` function in query-core.js runs off-worker-thread with time budgets:
- Exported to worker (query-worker.js), called via WorkerBridge
- Time budget enforced: 5s default, configurable
- Results streamed back; previous search auto-canceled (prevents stale results)
- Main thread only builds highlight regex (already validated)

**Testing**: 1 test case confirms time budget enforcement and no hangs.

---

### 3. **FNV-1a Content Hash (Cache Correctness)** (Security)
**Problem**: Secret-scan cache key was weak (djb2 with sampling); could miss changes or have false negatives.  
**Fix**: Replaced with FNV-1a full-string hash:
- `fnv1a()` function hashes all characters
- Key format: `${length}:${hex_hash}`
- Collision resistance verified (tests confirm distinct hashes for 1-char diffs, same-length different content)

**Testing**: 3 new test cases for hash collision resistance.

---

### 4. **RFC4180 CSV State Machine** (Correctness)
**Problem**: CSV parser split-then-parse approach broke on multiline quoted fields; lost newlines within cells.  
**Fix**: New `parseCsvStateMachine(raw, delimiter)` in csv-viewer.js:
- Single-pass char-by-char parsing with states (`inQuotes`, field, row)
- Handles `""` (escaped quote), CRLF/LF/CR line endings
- Multiline quoted fields preserved as-is (including embedded newlines)

**Testing**: 3 new test cases cover multiline fields, escaped quotes, CRLF.

---

### 5. **CSV Formula Injection Neutralization** (Security)
**Problem**: Exported CSV cells starting with `=`, `+`, `-`, `@` execute as formulas in Excel/Google Sheets.  
**Fix**: `neutralizeCsvCell()` function in main.js prefixes formula-leading chars with single quote (`'`):
- Applied before CSV quoting: `=SUM(...)` → `'=SUM(...)`
- Prevents formula execution; value visible with quote prefix

**Testing**: 2 new test cases confirm neutralization of all 4 dangerous chars and pass-through of safe values.

---

### 6. **Error-Overlay Bundling** (Correctness)
**Problem**: error-overlay.js was external script tag; not bundled by Vite.  
**Fix**: Import error-overlay.js into main.js module system; removed standalone script tag from index.html.  
**Result**: Bundled as part of app, available immediately on startup.

---

### 7. **Unified Save Flow (safeSaveToPath)** (Security)
**Problem**: saveFile, saveFileAs, and export all had duplicate path checks and invoke calls.  
**Fix**: New `safeSaveToPath(filePath, content)` helper in main.js:
- Single entry point: checks isPathTraversalSafe, calls approve_path, then save_file
- Consistent error handling and user feedback
- Backend remains final authority (validate_write_path in lib.rs)

**Testing**: Covered by existing saveFile/saveFileAs tests; no new test needed (already tested path checks).

---

### 8. **Secret Scan Guardrails (Line Cap & Debounce)** (Performance)
**Problem**: scanSecrets scanned all lines on every render; on 1M+ line files, severe lag.  
**Fix**: Two safeguards in main.js:
- **Line cap**: `maxLines` parameter (default 10K), notifies user if truncated
- **Debounce**: `renderSecurityBannerDebounced()` waits 300ms after edit before re-scanning

**Testing**: Covered implicitly by test execution timing; real-world impact verified by benchmark runs.

---

### 9. **New Security Test Suite** (Coverage)
**File**: tests/security.test.js  
**30 total tests**: 14 existing + 16 new security-hardened

New tests cover:
- ✅ Regex ReDoS 5 cases (nested quantifiers, length limit, invalid flags, safe patterns, filterLogContent rejection)
- ✅ regexSearch worker timeout (does not hang)
- ✅ CSV RFC4180: multiline, escaped quotes, CRLF
- ✅ Formula neutralization: 4 dangerous chars, safe pass-through
- ✅ FNV-1a: collision resistance, length prefix

All 30 tests passing (npm test).

---

### 10. **Stress Benchmark + CI Gating** (CI/CD)
**Files**: scripts/benchmark.js, package.json  
**New features**:
- Stress scenarios: CSV parsing, regex validation 10K, multi-tab search
- CI mode (`npm run benchmark:ci`): exits non-zero on threshold regression
- Thresholds defined per size: 10MB parse <2s, filter <3s; 25MB parse <5s, filter <8s

**Result**: benchmark/latest.json/md contain perf data; CI fails fast on regressions.

---

## Protections

### 🔒 Secret Detection (v3.0)

CrabTree automatically scans file content for exposed credentials and shows a severity-coded warning banner above the editor.

**Detected patterns**:

| Severity | Pattern | Example |
|----------|---------|---------|
| 🚨 Critical | AWS Access Key | `AKIA...` (20 chars) |
| 🚨 Critical | AWS Secret Key | `aws_secret_access_key=...` |
| 🚨 Critical | RSA/EC/DSA/OPENSSH Private Key | `-----BEGIN RSA PRIVATE KEY-----` |
| 🚨 Critical | PGP Private Key | `-----BEGIN PGP PRIVATE KEY BLOCK-----` |
| ⚠️ High | Stripe API Key | `sk_live_...` / `pk_live_...` |
| ⚠️ High | GitHub Token | `ghp_...` / `gho_...` / `ghu_...` |
| ⚠️ High | GitLab Token | `glpat-...` |
| 🔍 Warning | Generic password/secret | `password = "..."`, `api_key = "..."` |
| 🔍 Warning | JWT Token | `eyJ...eyJ...` (3-part base64) |

**Behavior**: Findings are grouped by type with clickable line numbers that jump directly to the offending line in the editor.

---

### 🛡️ Path Traversal Protection (v3.0)

File paths are validated against directory traversal attacks:

| Attack Vector | Blocked |
|---------------|---------|
| `../../../etc/passwd` | ✅ |
| `..\..\Windows\System32\config\SAM` | ✅ |
| `%2e%2e%2f%2e%2e%2fetc%2fpasswd` | ✅ (URL-encoded) |
| Null byte injection (`\0`) | ✅ |

---

### 🔐 Backend Allowlist (v2.0+)

All file system operations are gated by an allowlist in `src-tauri/src/lib.rs`:

- `approve_path()` — Adds paths only after user dialog selection
- `read_file()`, `save_file()`, `list_directory()` — All check allowlist before proceeding
- `fs::canonicalize()` — Resolves symlinks to prevent symlink attacks
- `clear_approved_paths()` — Called on app quit to wipe session state

---

### 🌐 Content Security Policy

Strict CSP configured in `tauri.conf.json`:

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
```

- ❌ No remote script loading
- ❌ No iframe embedding
- ❌ No external connections

---

### 🧱 Safe DOM Rendering

- All user content rendered via `textContent` or `escapeHtml()`
- No raw `innerHTML` with user data
- XSS payloads like `<script>`, `<img onerror>`, `<svg onload>` render as visible text

---

## Version History

| Version | Date | Security Changes |
|---------|------|-----------------|
| **v3.1.0** | 2026-02-15 | Regex ReDoS safety gate, worker-thread regex matching, FNV-1a cache, RFC4180 CSV, formula injection, guardrails (10 fixes) |
| **v3.0.0** | 2026-02-15 | Secret detection scanner, path traversal protection, Zed UI overhaul |
| **v2.0.0** | 2026-02-14 | Allowlist-based file access, CSP hardening, HTML injection fix, permission reduction |
| **v1.0.0** | 2026-02-01 | Initial release |

---

## Reporting Vulnerabilities

If you discover a security issue, please open an issue on the GitHub repository or contact the maintainer directly.
