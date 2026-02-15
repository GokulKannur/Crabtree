# CrabTree Security

**Version**: v3.0.0
**Last Updated**: 2026-02-15
**Status**: ✅ Production-Hardened

---

## Overview

CrabTree handles sensitive data — logs, configs, exports, and files that may contain credentials. All security layers are active and enforced.

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
| **v3.0.0** | 2026-02-15 | Secret detection scanner, path traversal protection, Zed UI overhaul |
| **v2.0.0** | 2026-02-14 | Allowlist-based file access, CSP hardening, HTML injection fix, permission reduction |
| **v1.0.0** | 2026-02-01 | Initial release |

---

## Reporting Vulnerabilities

If you discover a security issue, please open an issue on the GitHub repository or contact the maintainer directly.
