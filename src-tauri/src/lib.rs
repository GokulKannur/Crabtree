use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};
use chardetng::EncodingDetector;
use encoding_rs::Encoding;
use once_cell::sync::Lazy;

mod engine;
use engine::cache::JSON_INDEX_MEMORY_CAP_BYTES;
use engine::sessions::{MAX_SESSION_PREVIEW_BYTES, MAX_RANGE_READ_BYTES, MAX_LINE_READ_BYTES, MAX_SESSION_COUNT, DEFAULT_INACTIVITY_TTL_SECS};
use engine::json::{
    JsonIndexNode, JsonIndexCache, JsonIndexResult, JsonChildrenResult, JsonPathLookupResult,
    JsonScanner, build_json_index_cache, normalize_json_path, json_cache_key,
    estimate_json_index_bytes, load_json_index_from_disk, persist_json_index_to_disk,
};
use engine::logs::{
    LogClauseInfo, LogFilterResult, LogLineWindow,
    CompiledLogQuery, compile_log_query_native, matches_compiled_log_query, log_clause_info,
    LogQueryResultCache, log_query_cache_key,
};
use engine::csv::{
    CsvIndexCache, CsvIndexResult, CsvRowsResult, CsvFilterResult, CsvSortResult,
    detect_csv_delimiter, parse_csv_record, build_csv_index,
    get_csv_rows_paged, filter_csv_rows_impl, sort_csv_rows_impl,
};

// ─── Cancellation Token Registry ───
/// Maps operation keys to cancel flags for cooperative cancellation.
static CANCEL_TOKENS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

fn register_cancel_token(key: &str) -> Arc<AtomicBool> {
    let token = Arc::new(AtomicBool::new(false));
    if let Ok(mut tokens) = CANCEL_TOKENS.lock() {
        // Cancel any previous operation with same key
        if let Some(prev) = tokens.get(key) {
            prev.store(true, Ordering::Relaxed);
        }
        tokens.insert(key.to_string(), token.clone());
    }
    token
}

fn cancel_token(key: &str) -> bool {
    if let Ok(mut tokens) = CANCEL_TOKENS.lock() {
        if let Some(token) = tokens.remove(key) {
            token.store(true, Ordering::Relaxed);
            return true;
        }
    }
    false
}

// ─── Lifecycle Metrics (lightweight atomic counters) ───
static METRIC_SESSIONS_CREATED: AtomicU64 = AtomicU64::new(0);
static METRIC_SESSIONS_CLOSED: AtomicU64 = AtomicU64::new(0);
static METRIC_FORCED_EVICTIONS: AtomicU64 = AtomicU64::new(0);
static METRIC_EXPIRED_EVICTIONS: AtomicU64 = AtomicU64::new(0);
static METRIC_CANCELLATIONS: AtomicU64 = AtomicU64::new(0);
static METRIC_COMPACTIONS: AtomicU64 = AtomicU64::new(0);

// ─── Allowlist for approved file/folder access (Security) ───
/// Tracks paths approved by user through dialogs.
/// Only these paths (and their contents) are accessible.
static APPROVED_PATHS: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| {
    Mutex::new(Vec::new())
});

#[derive(Clone)]
struct FileSession {
    path: PathBuf,
    size: u64,
    encoding_name: String,
    line_offsets: Option<Vec<u64>>,
    json_index: Option<JsonIndexCache>,
    csv_index: Option<CsvIndexCache>,
    last_access: u64,
    created_at: Instant,
    last_access_at: Instant,
}

static FILE_SESSIONS: Lazy<Mutex<HashMap<String, FileSession>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});
static NEXT_FILE_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_CACHE_ACCESS: AtomicU64 = AtomicU64::new(1);

fn add_approved_path(canonical: PathBuf) -> Result<(), String> {
    let mut allowed = APPROVED_PATHS.lock()
        .map_err(|_| "Allowlist lock poisoned".to_string())?;

    if !allowed.contains(&canonical) {
        allowed.push(canonical);
    }
    Ok(())
}

/// Add a path to the allowlist (called after user opens file/folder via dialog).
/// Deduplicates to prevent unbounded growth from repeated saves.
#[tauri::command]
fn approve_path(path: String) -> Result<(), String> {
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("Cannot resolve path: {}", e))?;

    add_approved_path(canonical)
}

/// Add a path to the allowlist only if it canonicalizes within a canonical workspace root.
/// This blocks symlink-based escapes for extension-driven open_file requests.
#[tauri::command]
fn approve_path_within(path: String, root: String) -> Result<(), String> {
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("Cannot resolve path: {}", e))?;
    let canonical_root = fs::canonicalize(&root)
        .map_err(|e| format!("Cannot resolve root path: {}", e))?;

    let root_meta = fs::metadata(&canonical_root)
        .map_err(|e| format!("Cannot access root metadata: {}", e))?;
    if !root_meta.is_dir() {
        return Err("Root path is not a directory".to_string());
    }

    if !canonical.starts_with(&canonical_root) {
        return Err("Path is outside workspace root".to_string());
    }

    add_approved_path(canonical)
}

/// Check if a path is under an approved parent or is approved itself
fn is_path_allowed(path: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve path: {}", e))?;
    
    let allowed = APPROVED_PATHS.lock()
        .map_err(|_| "Allowlist lock poisoned".to_string())?;
    
    // Check if path is in the allowlist or under an approved folder
    for approved in allowed.iter() {
        if canonical.starts_with(approved) || &canonical == approved {
            return Ok(canonical);
        }
    }
    
    Err(format!(
        "Access denied: {} not in approved paths. User must open file/folder first.",
        path
    ))
}

/// Clear the allowlist (for testing or session reset)
#[tauri::command]
fn clear_approved_paths() -> Result<(), String> {
    let mut allowed = APPROVED_PATHS.lock()
        .map_err(|_| "Allowlist lock poisoned".to_string())?;
    allowed.clear();
    Ok(())
}

// ─── Path Validation (Security) ───
fn validate_file_path(path: &str) -> Result<(), String> {
    // First check allowlist
    let canonical = is_path_allowed(path)?;
    
    // Ensure it's a regular file, not a directory
    let metadata = fs::metadata(&canonical)
        .map_err(|e| format!("Cannot access file metadata: {}", e))?;
    
    if !metadata.is_file() {
        return Err("Path is not a regular file".to_string());
    }
    
    Ok(())
}

fn validate_write_path(path: &str) -> Result<(), String> {
    let file_path = Path::new(path);
    
    // First check allowlist for parent directory
    let parent = file_path.parent()
        .ok_or_else(|| "Invalid file path (no parent directory)".to_string())?;
    
    is_path_allowed(parent.to_str().ok_or_else(|| "Invalid path encoding".to_string())?)?;
    
    if !parent.exists() {
        return Err("Parent directory does not exist".to_string());
    }
    
    if !parent.is_dir() {
        return Err("Parent path is not a directory".to_string());
    }
    
    Ok(())
}

fn validate_read_dir(path: &str) -> Result<(), String> {
    // Check allowlist
    let canonical = is_path_allowed(path)?;
    
    // Ensure it's a directory
    let metadata = fs::metadata(&canonical)
        .map_err(|e| format!("Cannot access directory metadata: {}", e))?;
    
    if !metadata.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
}

#[derive(Serialize, Deserialize)]
pub struct FileContent {
    pub content: String,
    pub encoding: String,
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub line_ending: String,
    pub session_id: Option<String>,
    pub loaded_bytes: u64,
    pub partial: bool,
}

#[derive(Serialize, Deserialize)]
pub struct FileMetadata {
    pub path: String,
    pub file_name: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize)]
pub struct FileRange {
    pub content: String,
    pub offset: u64,
    pub loaded_bytes: u64,
    pub eof: bool,
}








#[derive(Serialize, Deserialize)]
pub struct SessionCacheStats {
    pub session_count: usize,
    pub json_index_count: usize,
    pub json_node_count: usize,
    pub json_estimated_bytes: usize,
    pub line_offset_count: usize,
}

#[derive(Serialize, Deserialize)]
pub struct SessionCompactResult {
    pub compacted_sessions: usize,
    pub freed_estimated_bytes: usize,
}

#[derive(Serialize, Deserialize)]
pub struct SessionEvictResult {
    pub evicted_count: usize,
    pub remaining_count: usize,
}

#[derive(Serialize, Deserialize)]
pub struct SessionDiagnosticEntry {
    pub session_id: String,
    pub path: String,
    pub size: u64,
    pub age_secs: u64,
    pub has_json_index: bool,
    pub json_node_count: usize,
    pub json_estimated_bytes: usize,
    pub has_line_offsets: bool,
    pub line_offset_count: usize,
    pub has_csv_index: bool,
    pub csv_row_count: usize,
    pub csv_estimated_bytes: usize,
    pub total_estimated_bytes: usize,
}

#[derive(Serialize, Deserialize)]
pub struct SessionDiagnosticsResult {
    pub sessions: Vec<SessionDiagnosticEntry>,
    pub total_sessions: usize,
    pub total_json_bytes: usize,
    pub total_csv_bytes: usize,
    pub total_line_offsets: usize,
    pub total_memory_pressure: usize,
}




fn detect_encoding(bytes: &[u8]) -> &'static Encoding {
    // Check BOM first
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        return encoding_rs::UTF_8;
    }
    if bytes.len() >= 2 {
        if bytes[0] == 0xFF && bytes[1] == 0xFE {
            return encoding_rs::UTF_16LE;
        }
        if bytes[0] == 0xFE && bytes[1] == 0xFF {
            return encoding_rs::UTF_16BE;
        }
    }

    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    detector.guess(None, true)
}

fn detect_line_ending(content: &str) -> String {
    if content.contains("\r\n") {
        "CRLF".to_string()
    } else if content.contains('\r') {
        "CR".to_string()
    } else {
        "LF".to_string()
    }
}

fn file_name_for_path(file_path: &Path) -> String {
    file_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

fn decode_with_encoding(bytes: &[u8], encoding_name: &str) -> String {
    let encoding = Encoding::for_label(encoding_name.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (content, _, _) = encoding.decode(bytes);
    content.to_string()
}


fn line_col_for_session_offset(session: &FileSession, offset: u64) -> Result<(usize, usize), String> {
    let mut file = fs::File::open(&session.path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut remaining = offset;
    let mut line = 1_usize;
    let mut col = 1_usize;
    let mut buf = vec![0_u8; 1024 * 1024];

    while remaining > 0 {
        let to_read = (buf.len() as u64).min(remaining) as usize;
        let read = file
            .read(&mut buf[..to_read])
            .map_err(|e| format!("Failed to read file for line lookup: {}", e))?;
        if read == 0 {
            break;
        }
        for byte in &buf[..read] {
            if *byte == b'\n' {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
        }
        remaining -= read as u64;
    }

    Ok((line, col))
}

fn ensure_json_index(
    session_id: &str,
    max_nodes: usize,
    max_depth: usize,
    max_bytes: u64,
) -> Result<JsonIndexCache, String> {
    let session = get_session(session_id)?;
    if let Some(cache) = &session.json_index {
        if cache.max_nodes >= max_nodes && cache.max_depth >= max_depth && cache.max_bytes >= max_bytes {
            let access = NEXT_CACHE_ACCESS.fetch_add(1, Ordering::Relaxed);
            let mut sessions = FILE_SESSIONS
                .lock()
                .map_err(|_| "File session lock poisoned".to_string())?;
            if let Some(s) = sessions.get_mut(session_id) {
                s.last_access = access;
                if let Some(ref mut c) = s.json_index {
                    c.last_access = access;
                }
            }
            let result = sessions.get(session_id)
                .and_then(|s| s.json_index.clone())
                .ok_or_else(|| "Session lost during index access".to_string())?;
            return Ok(result);
        }
    }

    let access = NEXT_CACHE_ACCESS.fetch_add(1, Ordering::Relaxed);
    let cache = build_json_index_cache(&session.path, session.size, max_nodes, max_depth, max_bytes, access)?;
    let mut sessions = FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?;
    if let Some(session) = sessions.get_mut(session_id) {
        session.last_access = cache.last_access;
        session.json_index = Some(cache.clone());
    }
    drop(sessions);
    evict_json_indexes_if_needed(JSON_INDEX_MEMORY_CAP_BYTES);
    Ok(cache)
}

fn evict_json_indexes_if_needed(max_bytes: usize) {
    let mut sessions = match FILE_SESSIONS.lock() {
        Ok(sessions) => sessions,
        Err(_) => return,
    };
    let mut total: usize = sessions
        .values()
        .filter_map(|session| session.json_index.as_ref().map(|cache| cache.estimated_bytes))
        .sum();
    if total <= max_bytes {
        return;
    }

    let mut candidates: Vec<(String, u64, usize)> = sessions
        .iter()
        .filter_map(|(id, session)| {
            session
                .json_index
                .as_ref()
                .map(|cache| (id.clone(), cache.last_access, cache.estimated_bytes))
        })
        .collect();
    candidates.sort_by_key(|(_, last_access, _)| *last_access);

    for (id, _, bytes) in candidates {
        if total <= max_bytes {
            break;
        }
        if let Some(session) = sessions.get_mut(&id) {
            session.json_index = None;
            total = total.saturating_sub(bytes);
        }
    }
}

fn ensure_csv_index(session_id: &str) -> Result<CsvIndexCache, String> {
    let session = get_session(session_id)?;
    if let Some(mut cache) = session.csv_index.clone() {
        cache.last_access = NEXT_CACHE_ACCESS.fetch_add(1, Ordering::Relaxed);
        let mut sessions = FILE_SESSIONS
            .lock()
            .map_err(|_| "File session lock poisoned".to_string())?;
        if let Some(session) = sessions.get_mut(session_id) {
            session.csv_index = Some(cache.clone());
            session.last_access = cache.last_access;
        }
        return Ok(cache);
    }

    let access = NEXT_CACHE_ACCESS.fetch_add(1, Ordering::Relaxed);
    let cache = build_csv_index(&session.path, session.size, &session.encoding_name, access)?;
    let mut sessions = FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?;
    if let Some(session) = sessions.get_mut(session_id) {
        session.last_access = cache.last_access;
        session.csv_index = Some(cache.clone());
    }
    Ok(cache)
}

#[tauri::command]
fn read_file(path: String) -> Result<FileContent, String> {
    // Validate path before reading
    validate_file_path(&path)?;
    
    let file_path = Path::new(&path);
    let bytes = fs::read(file_path).map_err(|e| format!("Failed to read file: {}", e))?;
    let metadata = fs::metadata(file_path).map_err(|e| format!("Failed to get metadata: {}", e))?;

    let encoding = detect_encoding(&bytes);
    let (content, _, _) = encoding.decode(&bytes);

    let line_ending = detect_line_ending(&content);
    let file_name = file_name_for_path(file_path);

    Ok(FileContent {
        content: content.to_string(),
        encoding: encoding.name().to_string(),
        path: path,
        file_name,
        size: metadata.len(),
        line_ending,
        session_id: None,
        loaded_bytes: metadata.len(),
        partial: false,
    })
}

#[tauri::command]
fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    validate_file_path(&path)?;
    let canonical = is_path_allowed(&path)?;
    let metadata = fs::metadata(&canonical).map_err(|e| format!("Failed to get metadata: {}", e))?;
    if !metadata.is_file() {
        return Err("Path is not a regular file".to_string());
    }

    Ok(FileMetadata {
        path,
        file_name: file_name_for_path(&canonical),
        size: metadata.len(),
    })
}

#[tauri::command]
fn open_file_session(path: String, preview_bytes: u64) -> Result<FileContent, String> {
    validate_file_path(&path)?;

    let canonical = is_path_allowed(&path)?;
    let metadata = fs::metadata(&canonical).map_err(|e| format!("Failed to get metadata: {}", e))?;
    if !metadata.is_file() {
        return Err("Path is not a regular file".to_string());
    }

    let size = metadata.len();
    let capped_preview = preview_bytes.min(MAX_SESSION_PREVIEW_BYTES).min(size);
    let mut file = fs::File::open(&canonical).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut bytes = vec![0; capped_preview as usize];
    if capped_preview > 0 {
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read preview: {}", e))?;
    }

    let encoding = detect_encoding(&bytes);
    let (content, _, _) = encoding.decode(&bytes);
    let content_string = content.to_string();
    let line_ending = detect_line_ending(&content_string);
    let session_id = format!("file-{}", NEXT_FILE_SESSION_ID.fetch_add(1, Ordering::Relaxed));

    let session = FileSession {
        path: canonical.clone(),
        size,
        encoding_name: encoding.name().to_string(),
        line_offsets: None,
        json_index: None,
        csv_index: None,
        last_access: NEXT_CACHE_ACCESS.fetch_add(1, Ordering::Relaxed),
        created_at: Instant::now(),
        last_access_at: Instant::now(),
    };
    {
        let mut sessions = FILE_SESSIONS
            .lock()
            .map_err(|_| "File session lock poisoned".to_string())?;
        // Enforce session count cap: evict oldest inactive session(s) before insert
        while sessions.len() >= MAX_SESSION_COUNT {
            let oldest = sessions
                .iter()
                .min_by_key(|(_, s)| s.last_access)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                sessions.remove(&id);
                METRIC_FORCED_EVICTIONS.fetch_add(1, Ordering::Relaxed);
            } else {
                break;
            }
        }
        sessions.insert(session_id.clone(), session);
        METRIC_SESSIONS_CREATED.fetch_add(1, Ordering::Relaxed);
    }

    Ok(FileContent {
        content: content_string,
        encoding: encoding.name().to_string(),
        path,
        file_name: file_name_for_path(&canonical),
        size,
        line_ending,
        session_id: Some(session_id),
        loaded_bytes: capped_preview,
        partial: capped_preview < size,
    })
}

#[tauri::command]
fn read_file_range(session_id: String, offset: u64, length: u64) -> Result<FileRange, String> {
    let session = FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "Unknown file session".to_string())?;

    validate_file_path(
        session
            .path
            .to_str()
            .ok_or_else(|| "Invalid path encoding".to_string())?,
    )?;

    if offset >= session.size {
        return Ok(FileRange {
            content: String::new(),
            offset,
            loaded_bytes: 0,
            eof: true,
        });
    }

    let capped_len = length.min(MAX_RANGE_READ_BYTES).min(session.size - offset);
    let mut file = fs::File::open(&session.path).map_err(|e| format!("Failed to open file: {}", e))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek file: {}", e))?;
    let mut bytes = vec![0; capped_len as usize];
    if capped_len > 0 {
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read file range: {}", e))?;
    }

    let (content, loaded_bytes) = if session.encoding_name.eq_ignore_ascii_case("UTF-8") {
        let mut valid_len = bytes.len();
        while valid_len > 0 && std::str::from_utf8(&bytes[..valid_len]).is_err() {
            valid_len -= 1;
        }
        if valid_len == 0 && !bytes.is_empty() {
            (String::from_utf8_lossy(&bytes).to_string(), capped_len)
        } else {
            (
                std::str::from_utf8(&bytes[..valid_len]).unwrap_or("").to_string(),
                valid_len as u64,
            )
        }
    } else {
        (decode_with_encoding(&bytes, &session.encoding_name), capped_len)
    };
    Ok(FileRange {
        content,
        offset,
        loaded_bytes,
        eof: offset + loaded_bytes >= session.size,
    })
}

#[tauri::command]
fn close_file_session(session_id: String) -> Result<(), String> {
    FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?
        .remove(&session_id);
    METRIC_SESSIONS_CLOSED.fetch_add(1, Ordering::Relaxed);
    // Cancel any in-flight operations for this session
    cancel_token(&format!("log-filter-{}", session_id));
    cancel_token(&format!("csv-filter-{}", session_id));
    Ok(())
}

fn get_session(session_id: &str) -> Result<FileSession, String> {
    let mut sessions = FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| "Unknown file session".to_string())?;
    // Touch wall-clock last access time on every read
    session.last_access_at = Instant::now();
    Ok(session.clone())
}

fn build_line_offsets(path: &Path) -> Result<Vec<u64>, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut offsets = vec![0_u64];
    let mut absolute = 0_u64;
    let mut buf = vec![0_u8; 1024 * 1024];

    loop {
        let read = file.read(&mut buf).map_err(|e| format!("Failed to index file: {}", e))?;
        if read == 0 {
            break;
        }
        for (idx, byte) in buf[..read].iter().enumerate() {
            if *byte == b'\n' {
                offsets.push(absolute + idx as u64 + 1);
            }
        }
        absolute += read as u64;
    }
    Ok(offsets)
}

fn ensure_line_offsets(session_id: &str) -> Result<Vec<u64>, String> {
    let existing = FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Unknown file session".to_string())?;

    if let Some(offsets) = existing.line_offsets {
        return Ok(offsets);
    }

    let offsets = build_line_offsets(&existing.path)?;
    let mut sessions = FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?;
    if let Some(session) = sessions.get_mut(session_id) {
        session.line_offsets = Some(offsets.clone());
    }
    Ok(offsets)
}

#[tauri::command]
fn get_log_lines(session_id: String, start_line: usize, count: usize) -> Result<LogLineWindow, String> {
    let session = get_session(&session_id)?;
    let offsets = ensure_line_offsets(&session_id)?;
    let line_count = offsets.len();
    if line_count == 0 || count == 0 {
        return Ok(LogLineWindow { lines: vec![], start_line, line_count });
    }

    let start_idx = start_line.saturating_sub(1).min(line_count);
    let end_idx = (start_idx + count).min(line_count);
    let mut lines = Vec::with_capacity(end_idx.saturating_sub(start_idx));
    let mut file = fs::File::open(&session.path).map_err(|e| format!("Failed to open file: {}", e))?;

    for idx in start_idx..end_idx {
        let from = offsets[idx];
        let to = if idx + 1 < offsets.len() { offsets[idx + 1] } else { session.size };
        if to <= from {
            lines.push(String::new());
            continue;
        }
        let len = (to - from).min(MAX_LINE_READ_BYTES);
        let mut bytes = vec![0_u8; len as usize];
        file.seek(SeekFrom::Start(from))
            .map_err(|e| format!("Failed to seek file: {}", e))?;
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read line: {}", e))?;
        let mut line = decode_with_encoding(&bytes, &session.encoding_name);
        while line.ends_with('\n') || line.ends_with('\r') {
            line.pop();
        }
        lines.push(line);
    }

    Ok(LogLineWindow { lines, start_line, line_count })
}

#[tauri::command]
fn filter_log_session(
    session_id: String,
    raw_query: String,
    max_results: usize,
) -> Result<LogFilterResult, String> {
    let session = get_session(&session_id)?;
    let cancel_key = format!("log-filter-{}", session_id);
    let cancelled = register_cancel_token(&cancel_key);

    let compiled = match compile_log_query_native(&raw_query) {
        Ok(compiled) => compiled,
        Err(error) => {
            let total_count = ensure_line_offsets(&session_id).map(|o| o.len()).unwrap_or(0);
            return Ok(LogFilterResult {
                error,
                filtered_lines: vec![],
                result_count: 0,
                total_count,
                clause_count: 0,
                term_count: 0,
                clauses: vec![],
                truncated: false,
            });
        }
    };

    let mut file = fs::File::open(&session.path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut buf = vec![0_u8; 1024 * 1024];
    let mut line = Vec::with_capacity(512);
    let mut filtered_lines = Vec::new();
    let mut result_count = 0_usize;
    let mut total_count = 0_usize;
    let mut was_cancelled = false;

    'outer: loop {
        let read = file.read(&mut buf).map_err(|e| format!("Failed to scan log: {}", e))?;
        if read == 0 {
            break;
        }
        for byte in &buf[..read] {
            if *byte == b'\n' {
                let text = decode_with_encoding(&line, &session.encoding_name);
                let trimmed = text.trim_end_matches(|ch| ch == '\r' || ch == '\n');
                if !trimmed.trim().is_empty() {
                    total_count += 1;
                    if matches_compiled_log_query(&compiled, trimmed) {
                        result_count += 1;
                        if filtered_lines.len() < max_results {
                            filtered_lines.push(trimmed.to_string());
                        }
                    }
                    // Cooperative cancellation check every 8192 lines
                    if total_count & 0x1FFF == 0 && cancelled.load(Ordering::Relaxed) {
                        was_cancelled = true;
                        METRIC_CANCELLATIONS.fetch_add(1, Ordering::Relaxed);
                        break 'outer;
                    }
                }
                line.clear();
            } else {
                line.push(*byte);
            }
        }
    }

    if !was_cancelled && !line.is_empty() {
        let text = decode_with_encoding(&line, &session.encoding_name);
        let trimmed = text.trim_end_matches(|ch| ch == '\r' || ch == '\n');
        if !trimmed.trim().is_empty() {
            total_count += 1;
            if matches_compiled_log_query(&compiled, trimmed) {
                result_count += 1;
                if filtered_lines.len() < max_results {
                    filtered_lines.push(trimmed.to_string());
                }
            }
        }
    }

    // Clean up cancel token
    if let Ok(mut tokens) = CANCEL_TOKENS.lock() {
        tokens.remove(&cancel_key);
    }

    if was_cancelled {
        return Ok(LogFilterResult {
            error: "cancelled".to_string(),
            filtered_lines,
            result_count,
            total_count,
            clause_count: compiled.clauses.len(),
            term_count: compiled.term_count,
            clauses: log_clause_info(&compiled),
            truncated: true,
        });
    }

    Ok(LogFilterResult {
        error: String::new(),
        filtered_lines,
        result_count,
        total_count,
        clause_count: compiled.clauses.len(),
        term_count: compiled.term_count,
        clauses: log_clause_info(&compiled),
        truncated: result_count > max_results,
    })
}

#[tauri::command]
fn index_json_session(
    session_id: String,
    max_nodes: usize,
    max_depth: usize,
    max_bytes: u64,
) -> Result<JsonIndexResult, String> {
    let cache = ensure_json_index(&session_id, max_nodes.max(1), max_depth.max(1), max_bytes)?;
    Ok(JsonIndexResult {
        nodes: cache.nodes,
        truncated: cache.truncated,
        error: cache.error,
    })
}

#[tauri::command]
fn lookup_json_path_session(
    session_id: String,
    raw_path: String,
    max_nodes: usize,
    max_depth: usize,
    max_bytes: u64,
) -> Result<JsonPathLookupResult, String> {
    let wanted = normalize_json_path(&raw_path);
    let cache = ensure_json_index(&session_id, max_nodes.max(1), max_depth.max(1), max_bytes)?;
    if !cache.error.is_empty() {
        return Ok(JsonPathLookupResult {
            found: false,
            path: wanted,
            kind: String::new(),
            depth: 0,
            from: 0,
            to: 0,
            child_count: 0,
            line: 1,
            col: 1,
            truncated: cache.truncated,
            error: cache.error,
        });
    }

    if let Some(node) = cache.nodes.into_iter().find(|node| node.path == wanted) {
        let session = get_session(&session_id)?;
        let (line, col) = line_col_for_session_offset(&session, node.from)?;
        return Ok(JsonPathLookupResult {
            found: true,
            path: node.path,
            kind: node.kind,
            depth: node.depth,
            from: node.from,
            to: node.to,
            child_count: node.child_count,
            line,
            col,
            truncated: cache.truncated,
            error: String::new(),
        });
    }

    Ok(JsonPathLookupResult {
        found: false,
        path: wanted,
        kind: String::new(),
        depth: 0,
        from: 0,
        to: 0,
        child_count: 0,
        line: 1,
        col: 1,
        truncated: cache.truncated,
        error: String::new(),
    })
}

/// Hard cap on children per fetch to prevent unbounded response payloads.
const MAX_JSON_CHILDREN_LIMIT: usize = 500;

#[tauri::command]
fn fetch_json_children(
    session_id: String,
    node_id: usize,
    offset: usize,
    limit: usize,
    max_nodes: usize,
    max_depth: usize,
    max_bytes: u64,
) -> Result<JsonChildrenResult, String> {
    let capped_limit = limit.max(1).min(MAX_JSON_CHILDREN_LIMIT);
    let cache = ensure_json_index(&session_id, max_nodes.max(1), max_depth.max(1), max_bytes)?;
    if !cache.error.is_empty() {
        return Ok(JsonChildrenResult {
            parent_id: node_id,
            offset,
            total: 0,
            nodes: vec![],
            truncated: cache.truncated,
            error: cache.error,
        });
    }

    // Avoid collecting all children — use skip/take for bounded iteration
    let mut total = 0_usize;
    let mut result_nodes = Vec::with_capacity(capped_limit);
    for node in cache.nodes.iter() {
        if node.parent_id == Some(node_id) {
            if total >= offset && result_nodes.len() < capped_limit {
                result_nodes.push(node.clone());
            }
            total += 1;
        }
    }
    let start = offset.min(total);
    Ok(JsonChildrenResult {
        parent_id: node_id,
        offset: start,
        total,
        nodes: result_nodes,
        truncated: cache.truncated,
        error: String::new(),
    })
}

#[tauri::command]
fn index_csv_session(session_id: String) -> Result<CsvIndexResult, String> {
    let index = ensure_csv_index(&session_id)?;
    Ok(CsvIndexResult {
        delimiter: if index.delimiter == b'\t' { "\\t".to_string() } else { (index.delimiter as char).to_string() },
        header: index.header,
        row_count: index.row_offsets.len(),
        estimated_bytes: index.estimated_bytes,
    })
}

#[tauri::command]
fn get_csv_rows(session_id: String, offset: usize, limit: usize) -> Result<CsvRowsResult, String> {
    let session = get_session(&session_id)?;
    let index = ensure_csv_index(&session_id)?;
    get_csv_rows_paged(&session.path, session.size, &session.encoding_name, &index, offset, limit)
}

#[tauri::command]
fn get_session_cache_stats() -> Result<SessionCacheStats, String> {
    let sessions = FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?;
    let mut json_index_count = 0_usize;
    let mut json_node_count = 0_usize;
    let mut json_estimated_bytes = 0_usize;
    let mut line_offset_count = 0_usize;

    for session in sessions.values() {
        if let Some(offsets) = &session.line_offsets {
            line_offset_count += offsets.len();
        }
        if let Some(index) = &session.json_index {
            json_index_count += 1;
            json_node_count += index.nodes.len();
            json_estimated_bytes += index.estimated_bytes;
        }
    }

    Ok(SessionCacheStats {
        session_count: sessions.len(),
        json_index_count,
        json_node_count,
        json_estimated_bytes,
        line_offset_count,
    })
}

#[tauri::command]
fn compact_session_caches(active_session_ids: Vec<String>) -> Result<SessionCompactResult, String> {
    let active: std::collections::HashSet<String> = active_session_ids.into_iter().collect();
    let mut sessions = FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?;
    let mut compacted_sessions = 0_usize;
    let mut freed_estimated_bytes = 0_usize;

    for (id, session) in sessions.iter_mut() {
        if active.contains(id) {
            continue;
        }
        let mut compacted = false;
        if let Some(index) = session.json_index.take() {
            freed_estimated_bytes += index.estimated_bytes;
            compacted = true;
        }
        if let Some(offsets) = session.line_offsets.take() {
            freed_estimated_bytes += offsets.len() * std::mem::size_of::<u64>();
            compacted = true;
        }
        if let Some(csv) = session.csv_index.take() {
            freed_estimated_bytes += csv.estimated_bytes;
            compacted = true;
        }
        if compacted {
            compacted_sessions += 1;
        }
    }

    // Also evict sessions with no remaining data to prevent empty session accumulation
    let stale_ids: Vec<String> = sessions
        .iter()
        .filter(|(id, s)| {
            !active.contains(*id)
                && s.json_index.is_none()
                && s.line_offsets.is_none()
                && s.csv_index.is_none()
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in &stale_ids {
        sessions.remove(id);
        compacted_sessions += 1;
    }

    METRIC_COMPACTIONS.fetch_add(1, Ordering::Relaxed);
    Ok(SessionCompactResult {
        compacted_sessions,
        freed_estimated_bytes,
    })
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    // Validate path against write allowlist (same as save_file_as)
    validate_write_path(&path)?;
    fs::write(&path, content.as_bytes()).map_err(|e| format!("Failed to save file: {}", e))
}

#[tauri::command]
fn save_file_as(path: String, content: String) -> Result<(), String> {
    // Validate that parent directory exists and is writable
    validate_write_path(&path)?;
    
    fs::write(&path, content.as_bytes()).map_err(|e| format!("Failed to save file: {}", e))
}

fn build_file_tree(dir: &Path, depth: u32, max_depth: u32) -> Vec<FileEntry> {
    if depth > max_depth {
        return vec![];
    }

    let mut entries: Vec<FileEntry> = Vec::new();

    if let Ok(read_dir) = fs::read_dir(dir) {
        let mut items: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
        items.sort_by(|a, b| {
            let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
            b_is_dir.cmp(&a_is_dir).then(
                a.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .cmp(&b.file_name().to_string_lossy().to_lowercase()),
            )
        });

        for item in items {
            let name = item.file_name().to_string_lossy().to_string();

            // Skip hidden files/dirs and common non-useful dirs
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }

            let path = item.path();
            let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

            let children = if is_dir {
                Some(build_file_tree(&path, depth + 1, max_depth))
            } else {
                None
            };

            entries.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                children,
            });
        }
    }

    entries
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    // Check allowlist first (security)
    validate_read_dir(&path)?;
    
    let dir_path = Path::new(&path);
    Ok(build_file_tree(dir_path, 0, 10))
}

#[tauri::command]
fn get_file_language(file_name: String) -> String {
    let ext = Path::new(&file_name)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();

    match ext.as_str() {
        "rs" => "rust",
        "js" | "mjs" | "cjs" => "javascript",
        "ts" | "mts" | "cts" => "typescript",
        "jsx" => "jsx",
        "tsx" => "tsx",
        "py" | "pyw" => "python",
        "java" => "java",
        "c" => "c",
        "cpp" | "cc" | "cxx" | "c++" => "cpp",
        "h" | "hpp" | "hxx" => "cpp",
        "cs" => "csharp",
        "go" => "go",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "scala" => "scala",
        "r" => "r",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "sass",
        "less" => "less",
        "json" => "json",
        "xml" | "xsl" | "xslt" | "svg" => "xml",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "md" | "markdown" => "markdown",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "shell",
        "ps1" | "psm1" => "powershell",
        "bat" | "cmd" => "shell",
        "lua" => "lua",
        "perl" | "pl" | "pm" => "perl",
        "dockerfile" => "dockerfile",
        "makefile" => "cmake",
        "cmake" => "cmake",
        "ini" | "cfg" | "conf" => "ini",
        "txt" | "log" => "plaintext",
        _ => "plaintext",
    }
    .to_string()
}

#[derive(Serialize, Deserialize)]
struct TaskRunResult {
    ok: bool,
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u128,
}

fn validate_task_command(command: &str) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Task command cannot be empty".to_string());
    }
    if command.contains('\0') {
        return Err("Invalid task command".to_string());
    }
    Ok(())
}

#[tauri::command]
fn run_task(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<TaskRunResult, String> {
    validate_task_command(&command)?;

    let mut cmd = Command::new(command.trim());
    cmd.args(args);

    if let Some(raw_cwd) = cwd {
        if !raw_cwd.trim().is_empty() {
            validate_read_dir(&raw_cwd)?;
            let canonical = fs::canonicalize(&raw_cwd)
                .map_err(|e| format!("Cannot resolve task cwd: {}", e))?;
            cmd.current_dir(canonical);
        }
    }

    if let Some(env_map) = env {
        for (k, v) in env_map {
            if k.len() > 64 {
                eprintln!("Warning: env var name '{}' exceeds 64 chars, skipping", &k[..k.len().min(32)]);
                continue;
            }
            if v.len() > 8192 {
                eprintln!("Warning: env var '{}' value exceeds 8192 chars, skipping", k);
                continue;
            }
            cmd.env(k, v);
        }
    }

    let started = Instant::now();
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run task: {}", e))?;
    let elapsed = started.elapsed().as_millis();
    let exit_code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(TaskRunResult {
        ok: output.status.success(),
        exit_code,
        stdout,
        stderr,
        duration_ms: elapsed,
    })
}

fn evict_stale_sessions(max_age_secs: u64) -> usize {
    let mut sessions = match FILE_SESSIONS.lock() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let now = Instant::now();
    let stale: Vec<String> = sessions
        .iter()
        .filter(|(_, s)| now.duration_since(s.last_access_at).as_secs() > max_age_secs)
        .map(|(id, _)| id.clone())
        .collect();
    let count = stale.len();
    for id in stale {
        sessions.remove(&id);
    }
    METRIC_EXPIRED_EVICTIONS.fetch_add(count as u64, Ordering::Relaxed);
    count
}

#[tauri::command]
fn evict_inactive_sessions(max_age_secs: u64) -> Result<SessionEvictResult, String> {
    let age = if max_age_secs == 0 { DEFAULT_INACTIVITY_TTL_SECS } else { max_age_secs };
    let evicted = evict_stale_sessions(age);
    let remaining = FILE_SESSIONS
        .lock()
        .map(|s| s.len())
        .unwrap_or(0);
    Ok(SessionEvictResult {
        evicted_count: evicted,
        remaining_count: remaining,
    })
}

#[tauri::command]
fn get_session_diagnostics() -> Result<SessionDiagnosticsResult, String> {
    let sessions = FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?;
    let now = Instant::now();
    let mut entries = Vec::with_capacity(sessions.len());
    let mut total_json_bytes = 0_usize;
    let mut total_csv_bytes = 0_usize;
    let mut total_line_offsets = 0_usize;

    for (id, s) in sessions.iter() {
        let json_node_count = s.json_index.as_ref().map(|c| c.nodes.len()).unwrap_or(0);
        let json_estimated_bytes = s.json_index.as_ref().map(|c| c.estimated_bytes).unwrap_or(0);
        let line_offset_count = s.line_offsets.as_ref().map(|o| o.len()).unwrap_or(0);
        let csv_row_count = s.csv_index.as_ref().map(|c| c.row_offsets.len()).unwrap_or(0);
        let csv_estimated_bytes = s.csv_index.as_ref().map(|c| c.estimated_bytes).unwrap_or(0);
        let line_offset_bytes = line_offset_count * std::mem::size_of::<u64>();

        total_json_bytes += json_estimated_bytes;
        total_csv_bytes += csv_estimated_bytes;
        total_line_offsets += line_offset_count;
        let total_estimated_bytes = json_estimated_bytes + csv_estimated_bytes + line_offset_bytes;

        entries.push(SessionDiagnosticEntry {
            session_id: id.clone(),
            path: s.path.to_string_lossy().to_string(),
            size: s.size,
            age_secs: now.duration_since(s.last_access_at).as_secs(),
            has_json_index: s.json_index.is_some(),
            json_node_count,
            json_estimated_bytes,
            has_line_offsets: s.line_offsets.is_some(),
            line_offset_count,
            has_csv_index: s.csv_index.is_some(),
            csv_row_count,
            csv_estimated_bytes,
            total_estimated_bytes,
        });
    }

    Ok(SessionDiagnosticsResult {
        total_sessions: entries.len(),
        sessions: entries,
        total_json_bytes,
        total_csv_bytes,
        total_line_offsets,
        total_memory_pressure: total_json_bytes + total_csv_bytes + total_line_offsets * std::mem::size_of::<u64>(),
    })
}

#[tauri::command]
fn filter_csv_rows(
    session_id: String,
    column_index: usize,
    pattern: String,
    max_results: usize,
    case_insensitive: bool,
) -> Result<CsvFilterResult, String> {
    let session = get_session(&session_id)?;
    let index = ensure_csv_index(&session_id)?;
    let cancel_key = format!("csv-filter-{}", session_id);
    let cancelled = register_cancel_token(&cancel_key);

    let result = filter_csv_rows_impl(
        &session.path, session.size, &session.encoding_name, &index,
        column_index, &pattern, max_results, case_insensitive,
        &cancelled, &METRIC_CANCELLATIONS,
    );

    // Clean up cancel token
    if let Ok(mut tokens) = CANCEL_TOKENS.lock() {
        tokens.remove(&cancel_key);
    }

    result
}


#[tauri::command]
fn sort_csv_rows(
    session_id: String,
    column_index: usize,
    ascending: bool,
    offset: usize,
    limit: usize,
) -> Result<CsvSortResult, String> {
    let session = get_session(&session_id)?;
    let index = ensure_csv_index(&session_id)?;
    let cancel_key = format!("csv-sort-{}", session_id);
    let cancelled = register_cancel_token(&cancel_key);

    let result = sort_csv_rows_impl(
        &session.path, session.size, &session.encoding_name, &index,
        column_index, ascending, offset, limit,
        &cancelled, &METRIC_CANCELLATIONS,
    );

    if let Ok(mut tokens) = CANCEL_TOKENS.lock() {
        tokens.remove(&cancel_key);
    }

    result
}

#[tauri::command]
fn close_all_file_sessions() -> Result<usize, String> {
    let mut sessions = FILE_SESSIONS
        .lock()
        .map_err(|_| "File session lock poisoned".to_string())?;
    let count = sessions.len();
    sessions.clear();
    Ok(count)
}

#[tauri::command]
fn cancel_filter(session_id: String) -> bool {
    let a = cancel_token(&format!("log-filter-{}", session_id));
    let b = cancel_token(&format!("csv-filter-{}", session_id));
    a || b
}

#[derive(Serialize, Deserialize)]
pub struct LifecycleMetrics {
    pub sessions_created: u64,
    pub sessions_closed: u64,
    pub forced_evictions: u64,
    pub expired_evictions: u64,
    pub cancellations: u64,
    pub compactions: u64,
    pub active_sessions: usize,
}

#[tauri::command]
fn get_lifecycle_metrics() -> Result<LifecycleMetrics, String> {
    let active = FILE_SESSIONS
        .lock()
        .map(|s| s.len())
        .unwrap_or(0);
    Ok(LifecycleMetrics {
        sessions_created: METRIC_SESSIONS_CREATED.load(Ordering::Relaxed),
        sessions_closed: METRIC_SESSIONS_CLOSED.load(Ordering::Relaxed),
        forced_evictions: METRIC_FORCED_EVICTIONS.load(Ordering::Relaxed),
        expired_evictions: METRIC_EXPIRED_EVICTIONS.load(Ordering::Relaxed),
        cancellations: METRIC_CANCELLATIONS.load(Ordering::Relaxed),
        compactions: METRIC_COMPACTIONS.load(Ordering::Relaxed),
        active_sessions: active,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            approve_path,
            approve_path_within,
            clear_approved_paths,
            get_file_metadata,
            read_file,
            open_file_session,
            read_file_range,
            close_file_session,
            close_all_file_sessions,
            get_log_lines,
            filter_log_session,
            cancel_filter,
            index_json_session,
            lookup_json_path_session,
            fetch_json_children,
            get_session_cache_stats,
            get_session_diagnostics,
            get_lifecycle_metrics,
            evict_inactive_sessions,
            index_csv_session,
            get_csv_rows,
            filter_csv_rows,
            sort_csv_rows,
            compact_session_caches,
            save_file,
            save_file_as,
            list_directory,
            get_file_language,
            run_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
