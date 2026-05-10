/// Session lifecycle management constants and helpers.
/// Extracted from lib.rs to clarify ownership boundaries and reduce monolith growth.

/// Maximum number of sessions before forcing eviction of oldest entries.
pub const MAX_SESSION_COUNT: usize = 64;

/// Default session inactivity TTL in seconds for periodic sweeps.
pub const DEFAULT_INACTIVITY_TTL_SECS: u64 = 600;

/// Maximum preview bytes for a single file session open.
pub const MAX_SESSION_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;

/// Maximum bytes per range read from a file session.
pub const MAX_RANGE_READ_BYTES: u64 = 8 * 1024 * 1024;

/// Maximum line length in bytes when reading individual log lines.
pub const MAX_LINE_READ_BYTES: u64 = 1024 * 1024;
