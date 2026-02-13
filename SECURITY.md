# CrabTree Security Audit & Fixes

**Date**: 2026-02-14  
**Status**: ✅ CRITICAL ISSUES ADDRESSED  
**Version**: v0.2.0

## Summary

CrabTree handles sensitive data (logs, configs, exports). This document outlines identified security issues, fixes applied, and remaining tasks.

---

## Release Versions

| Version | Release Date | Security Status | Notes |
|---------|--------------|-----------------|-------|
| **v0.1.0** | 2026-02-01 | 🔴 Vulnerable | Unscoped file access, HTML injection in modal, over-privileged permissions |
| **v0.2.0** | 2026-02-14 | 🟡 Hardened | Critical issues fixed, allowlist implemented, frontend integration pending (v0.3) |
| **v0.3.0** | *Planned* | ✅ Production-Ready | Frontend allowlist integration, session cleanup, full testing |

---

## Vulnerabilities Fixed

### 🔴 Critical: Unscoped File System Access
**Status**: ✅ FIXED (v0.2.0)

**Problem**: Backend functions accepted arbitrary file paths without validating user intent.

**Fix**: Implemented allowlist-based path scoping in `src-tauri/src/lib.rs`
- New `approve_path()` command — adds paths only after user approval
- All operations check allowlist: `read_file()`, `save_file()`, `list_directory()`
- Symlink attacks prevented via `fs::canonicalize()`
- Removed unused permissions: `fs:allow-mkdir`, `fs:allow-remove`, `fs:allow-rename`

**Frontend Integration TODO (v0.3)**:
```javascript
const file = await open();  // User selects file
await invoke('approve_path', { path: file });  // Add to allowlist
```

---

### 🟡 Medium: HTML Injection in Data Analysis Modal
**Status**: ✅ FIXED (v0.2.0)

**Problem**: Modal rendered insights via innerHTML without safe parsing.

**Fix**: Rewrote `showDataAnalysis()` using DOM methods instead of template strings:
```javascript
// BEFORE (unsafe):
overlay.innerHTML = `<div>${insights}</div>`;

// AFTER (safe):
const item = document.createElement('div');
item.innerHTML = escapeHtml(insight);
insightList.appendChild(item);
```

---

### 🟡 Medium: Over-Privileged Tauri Capabilities
**Status**: ✅ FIXED (v0.2.0)

**Removed Unused Permissions**:
- ❌ `fs:allow-mkdir` — Never used
- ❌ `fs:allow-remove` — Never used
- ❌ `fs:allow-rename` — Never used
- ❌ `opener:default` — Dialog handles it

**Reduced blast radius**: App only has minimum permissions needed.

---

## Remaining High-Priority Tasks (v0.3)

1. **Frontend: Call `approve_path()` after file/folder opens**
   - This ties backend access to explicit user dialogs
   - Currently allowlist is validated, but frontend doesn't populate it yet

2. **Test allowlist enforcement**
   - Verify `read_file('/etc/passwd')` fails before approval
   - Verify opened files work correctly

3. **Session cleanup**
   - Call `clear_approved_paths()` on app quit

---

## Dependencies Added

- `once_cell = "1.19"` — Thread-safe lazy static for allowlist

---

**Overall Status**: Core critical issues fixed. Backend allowlist implemented. Frontend integration needed for v0.3 release.
