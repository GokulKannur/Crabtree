# Changelog

All notable changes to this project are documented in this file.

## v3.2.0 - 2026-02-17

### Added

- Updated release documentation for installer-based distribution.
- Added explicit release guidance for Windows NSIS/MSI packaging.

### Changed

- Bumped app version metadata to `3.2.0`:
  - `package.json`
  - `package-lock.json`
  - `src-tauri/Cargo.toml`
  - `src-tauri/tauri.conf.json`
- Refreshed `README.md` for current workflow and capabilities.
- Refreshed `SECURITY.md` with current hardening and validation status.

### Fixed

- Cleaned encoding artifacts in source/doc output paths and release-facing text.
