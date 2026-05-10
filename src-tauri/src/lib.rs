use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};
use chardetng::EncodingDetector;
use encoding_rs::Encoding;
use once_cell::sync::Lazy;
use regex::{Regex, RegexBuilder};

mod engine;
use engine::cache::{JSON_INDEX_DISK_VERSION, JSON_INDEX_MEMORY_CAP_BYTES};
use engine::sessions::{MAX_SESSION_PREVIEW_BYTES, MAX_RANGE_READ_BYTES, MAX_LINE_READ_BYTES, MAX_SESSION_COUNT, DEFAULT_INACTIVITY_TTL_SECS};

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
pub struct LogLineWindow {
    pub lines: Vec<String>,
    pub start_line: usize,
    pub line_count: usize,
}

#[derive(Serialize, Deserialize)]
pub struct LogFilterResult {
    pub error: String,
    pub filtered_lines: Vec<String>,
    pub result_count: usize,
    pub total_count: usize,
    pub clause_count: usize,
    pub term_count: usize,
    pub clauses: Vec<Vec<LogClauseInfo>>,
    pub truncated: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LogClauseInfo {
    pub token: String,
    pub negate: bool,
}

#[derive(Clone)]
enum LogPredicate {
    Contains(String),
    FieldContains { field: String, value: String },
    Regex(Regex),
    Severity(String),
}

#[derive(Clone)]
struct LogCondition {
    token: String,
    negate: bool,
    predicate: LogPredicate,
}

struct CompiledLogQuery {
    clauses: Vec<Vec<LogCondition>>,
    term_count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct JsonIndexNode {
    pub id: usize,
    pub parent_id: Option<usize>,
    pub path: String,
    pub kind: String,
    pub depth: usize,
    pub from: u64,
    pub to: u64,
    pub child_count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
struct JsonIndexCache {
    nodes: Vec<JsonIndexNode>,
    truncated: bool,
    error: String,
    max_nodes: usize,
    max_depth: usize,
    max_bytes: u64,
    estimated_bytes: usize,
    last_access: u64,
    cache_key: String,
}

#[derive(Serialize, Deserialize)]
struct PersistedJsonIndexCache {
    version: u32,
    cache_key: String,
    cache: JsonIndexCache,
}

#[derive(Serialize, Deserialize)]
pub struct JsonIndexResult {
    pub nodes: Vec<JsonIndexNode>,
    pub truncated: bool,
    pub error: String,
}

#[derive(Serialize, Deserialize)]
pub struct JsonChildrenResult {
    pub parent_id: usize,
    pub offset: usize,
    pub total: usize,
    pub nodes: Vec<JsonIndexNode>,
    pub truncated: bool,
    pub error: String,
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
}

#[derive(Serialize, Deserialize)]
pub struct SessionDiagnosticsResult {
    pub sessions: Vec<SessionDiagnosticEntry>,
    pub total_sessions: usize,
    pub total_json_bytes: usize,
    pub total_csv_bytes: usize,
    pub total_line_offsets: usize,
}

#[derive(Serialize, Deserialize)]
pub struct CsvFilterResult {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub match_count: usize,
    pub scanned_count: usize,
    pub truncated: bool,
    pub error: String,
}

#[derive(Clone)]
struct CsvIndexCache {
    delimiter: u8,
    header: Vec<String>,
    row_offsets: Vec<u64>,
    estimated_bytes: usize,
    last_access: u64,
}

#[derive(Serialize, Deserialize)]
pub struct CsvIndexResult {
    pub delimiter: String,
    pub header: Vec<String>,
    pub row_count: usize,
    pub estimated_bytes: usize,
}

#[derive(Serialize, Deserialize)]
pub struct CsvRowsResult {
    pub delimiter: String,
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub row_count: usize,
    pub col_count: usize,
    pub offset: usize,
    pub truncated: bool,
}

#[derive(Serialize, Deserialize)]
pub struct JsonPathLookupResult {
    pub found: bool,
    pub path: String,
    pub kind: String,
    pub depth: usize,
    pub from: u64,
    pub to: u64,
    pub child_count: usize,
    pub line: usize,
    pub col: usize,
    pub truncated: bool,
    pub error: String,
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

fn unquote_filter_value(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0] as char;
        let last = trimmed.as_bytes()[trimmed.len() - 1] as char;
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return trimmed[1..trimmed.len() - 1]
                .replace("\\\"", "\"")
                .replace("\\'", "'")
                .replace("\\\\", "\\");
        }
    }
    trimmed.to_string()
}

fn tokenize_log_query(raw_query: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in raw_query.trim().chars() {
        if let Some(q) = quote {
            current.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == q {
                quote = None;
            }
            continue;
        }

        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            current.push(ch);
            continue;
        }

        if ch.is_whitespace() || ch == ',' {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }

        current.push(ch);
    }

    if quote.is_some() {
        return Err("Unterminated quoted value in filter.".to_string());
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Ok(tokens)
}

fn parse_log_predicate(raw_token: &str) -> Result<LogPredicate, String> {
    let token = raw_token.trim();
    if token.is_empty() {
        return Err("Empty filter term.".to_string());
    }
    if let Some(split_at) = token.find(':') {
        let field = token[..split_at].trim().to_lowercase();
        let raw_value = unquote_filter_value(&token[split_at + 1..]);
        let value = raw_value.to_lowercase();
        if value.is_empty() {
            return Err(format!("Filter value missing for field \"{}\".", field));
        }
        if field == "re" || field == "regex" {
            return build_log_regex(&raw_value).map(LogPredicate::Regex);
        }
        if field == "severity" {
            return Ok(LogPredicate::Severity(value));
        }
        if field == "ip" || field == "text" || field == "msg" || field == "message" {
            return Ok(LogPredicate::Contains(value));
        }
        return Ok(LogPredicate::FieldContains { field, value });
    }

    let value = unquote_filter_value(token).to_lowercase();
    if value.is_empty() {
        return Err("Empty text filter.".to_string());
    }
    Ok(LogPredicate::Contains(value))
}

fn build_log_regex(raw: &str) -> Result<Regex, String> {
    let value = unquote_filter_value(raw);
    let (pattern, flags) = if value.starts_with('/') {
        if let Some(last_slash) = value.rfind('/') {
            if last_slash > 0 {
                (&value[1..last_slash], &value[last_slash + 1..])
            } else {
                (value.as_str(), "i")
            }
        } else {
            (value.as_str(), "i")
        }
    } else {
        (value.as_str(), "i")
    };

    if pattern.is_empty() {
        return Err("Regex pattern is empty".to_string());
    }
    if pattern.len() > 256 {
        return Err("Regex too long (max 256 chars)".to_string());
    }

    let mut builder = RegexBuilder::new(pattern);
    builder.case_insensitive(flags.contains('i'));
    builder.multi_line(flags.contains('m'));
    builder.dot_matches_new_line(flags.contains('s'));
    builder.size_limit(2 * 1024 * 1024);
    builder
        .build()
        .map_err(|err| format!("Invalid regex: {}", err))
}

fn compile_log_query_native(raw_query: &str) -> Result<CompiledLogQuery, String> {
    let input = raw_query.trim();
    if input.is_empty() {
        return Err("Filter is empty.".to_string());
    }
    let tokens = tokenize_log_query(input)?;
    if tokens.is_empty() {
        return Err("Filter is empty.".to_string());
    }

    let mut clauses: Vec<Vec<LogCondition>> = Vec::new();
    let mut current: Vec<LogCondition> = Vec::new();
    let mut pending_not = false;
    let mut term_count = 0;

    for raw in tokens {
        let upper = raw.to_uppercase();
        if raw == "||" || upper == "OR" {
            if current.is_empty() {
                return Err("Unexpected OR operator in filter.".to_string());
            }
            clauses.push(std::mem::take(&mut current));
            pending_not = false;
            continue;
        }
        if raw == "&&" || upper == "AND" {
            continue;
        }
        if raw == "!" || upper == "NOT" {
            pending_not = !pending_not;
            continue;
        }

        let mut token = raw.as_str();
        while token.starts_with('!') {
            pending_not = !pending_not;
            token = &token[1..];
        }
        if token.is_empty() {
            return Err("Invalid NOT usage in filter.".to_string());
        }

        let predicate = parse_log_predicate(token)?;
        current.push(LogCondition {
            token: token.to_string(),
            negate: pending_not,
            predicate,
        });
        pending_not = false;
        term_count += 1;
    }

    if pending_not {
        return Err("Filter cannot end with NOT.".to_string());
    }
    if current.is_empty() {
        return Err("Filter cannot end with OR.".to_string());
    }
    clauses.push(current);

    Ok(CompiledLogQuery { clauses, term_count })
}

fn matches_log_predicate(predicate: &LogPredicate, line: &str, lower: &str) -> bool {
    match predicate {
        LogPredicate::Contains(value) => lower.contains(value),
        LogPredicate::FieldContains { field, value } => {
            lower.contains(&format!("{}={}", field, value)) || lower.contains(&format!("{}:{}", field, value))
        }
        LogPredicate::Regex(regex) => regex.is_match(line),
        LogPredicate::Severity(value) => lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|part| part == value),
    }
}

fn matches_compiled_log_query(compiled: &CompiledLogQuery, line: &str) -> bool {
    let lower = line.to_lowercase();
    for clause in &compiled.clauses {
        let mut matches = true;
        for cond in clause {
            let result = matches_log_predicate(&cond.predicate, line, &lower);
            if (cond.negate && result) || (!cond.negate && !result) {
                matches = false;
                break;
            }
        }
        if matches {
            return true;
        }
    }
    false
}

fn log_clause_info(compiled: &CompiledLogQuery) -> Vec<Vec<LogClauseInfo>> {
    compiled
        .clauses
        .iter()
        .map(|clause| {
            clause
                .iter()
                .map(|cond| LogClauseInfo {
                    token: cond.token.clone(),
                    negate: cond.negate,
                })
                .collect()
        })
        .collect()
}

fn normalize_json_path(raw_path: &str) -> String {
    let input = raw_path.trim().trim_start_matches("path:").trim();
    if input.is_empty() || input == "$" {
        return "$".to_string();
    }
    if input.starts_with('$') {
        return input.to_string();
    }

    let mut out = "$".to_string();
    let mut token = String::new();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '.' => {
                if !token.is_empty() {
                    out.push('.');
                    out.push_str(&token);
                    token.clear();
                }
            }
            '[' => {
                if !token.is_empty() {
                    out.push('.');
                    out.push_str(&token);
                    token.clear();
                }
                let mut bracket = String::new();
                while i < chars.len() {
                    bracket.push(chars[i]);
                    if chars[i] == ']' {
                        break;
                    }
                    i += 1;
                }
                out.push_str(&bracket);
            }
            ch => token.push(ch),
        }
        i += 1;
    }
    if !token.is_empty() {
        out.push('.');
        out.push_str(&token);
    }
    out
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

fn file_modified_millis(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn json_cache_key(session: &FileSession, max_nodes: usize, max_depth: usize, max_bytes: u64) -> String {
    let mut hasher = DefaultHasher::new();
    session.path.to_string_lossy().hash(&mut hasher);
    session.size.hash(&mut hasher);
    file_modified_millis(&session.path).hash(&mut hasher);
    max_nodes.hash(&mut hasher);
    max_depth.hash(&mut hasher);
    max_bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn json_cache_dir() -> PathBuf {
    std::env::temp_dir().join("crabtree-index-cache").join("json")
}

fn json_cache_path(cache_key: &str) -> PathBuf {
    json_cache_dir().join(format!("v{}-{}.json", JSON_INDEX_DISK_VERSION, cache_key))
}

fn estimate_json_index_bytes(nodes: &[JsonIndexNode]) -> usize {
    nodes
        .iter()
        .map(|node| std::mem::size_of::<JsonIndexNode>() + node.path.len() + node.kind.len())
        .sum()
}

fn load_json_index_from_disk(cache_key: &str) -> Option<JsonIndexCache> {
    let path = json_cache_path(cache_key);
    let raw = fs::read_to_string(path).ok()?;
    let persisted: PersistedJsonIndexCache = serde_json::from_str(&raw).ok()?;
    if persisted.version != JSON_INDEX_DISK_VERSION || persisted.cache_key != cache_key {
        return None;
    }
    Some(persisted.cache)
}

fn persist_json_index_to_disk(cache: &JsonIndexCache) {
    if cache.error.is_empty() {
        let _ = fs::create_dir_all(json_cache_dir());
        let path = json_cache_path(&cache.cache_key);
        let persisted = PersistedJsonIndexCache {
            version: JSON_INDEX_DISK_VERSION,
            cache_key: cache.cache_key.clone(),
            cache: cache.clone(),
        };
        if let Ok(raw) = serde_json::to_string(&persisted) {
            let _ = fs::write(path, raw);
        }
    }
}

struct JsonScanner {
    bytes: Vec<u8>,
    pos: usize,
    nodes: Vec<JsonIndexNode>,
    max_nodes: usize,
    max_depth: usize,
    truncated: bool,
}

impl JsonScanner {
    fn new(bytes: Vec<u8>, max_nodes: usize, max_depth: usize) -> Self {
        Self {
            bytes,
            pos: 0,
            nodes: Vec::new(),
            max_nodes,
            max_depth,
            truncated: false,
        }
    }

    fn scan(mut self) -> JsonIndexResult {
        let result = self.parse_value("$".to_string(), 0, None);
        match result {
            Ok(_) => JsonIndexResult {
                nodes: self.nodes,
                truncated: self.truncated,
                error: String::new(),
            },
            Err(error) => JsonIndexResult {
                nodes: self.nodes,
                truncated: self.truncated,
                error,
            },
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let ch = self.peek()?;
        self.pos += 1;
        Some(ch)
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.pos += 1;
        }
    }

    fn add_node(
        &mut self,
        path: String,
        kind: &str,
        depth: usize,
        from: usize,
        parent_id: Option<usize>,
    ) -> Option<usize> {
        if self.nodes.len() >= self.max_nodes {
            self.truncated = true;
            return None;
        }
        let idx = self.nodes.len();
        self.nodes.push(JsonIndexNode {
            id: idx,
            parent_id,
            path,
            kind: kind.to_string(),
            depth,
            from: from as u64,
            to: from as u64,
            child_count: 0,
        });
        Some(idx)
    }

    fn finish_node(&mut self, idx: Option<usize>, to: usize, child_count: usize) {
        if let Some(i) = idx {
            if let Some(node) = self.nodes.get_mut(i) {
                node.to = to as u64;
                node.child_count = child_count;
            }
        }
    }

    fn parse_value(&mut self, path: String, depth: usize, parent_id: Option<usize>) -> Result<(), String> {
        self.skip_ws();
        let start = self.pos;
        match self.peek() {
            Some(b'{') => self.parse_object(path, depth, start, parent_id),
            Some(b'[') => self.parse_array(path, depth, start, parent_id),
            Some(b'"') => {
                let idx = self.add_node(path, "string", depth, start, parent_id);
                self.parse_string()?;
                self.finish_node(idx, self.pos, 0);
                Ok(())
            }
            Some(b't') | Some(b'f') => {
                let idx = self.add_node(path, "boolean", depth, start, parent_id);
                self.parse_literal()?;
                self.finish_node(idx, self.pos, 0);
                Ok(())
            }
            Some(b'n') => {
                let idx = self.add_node(path, "null", depth, start, parent_id);
                self.parse_literal()?;
                self.finish_node(idx, self.pos, 0);
                Ok(())
            }
            Some(b'-' | b'0'..=b'9') => {
                let idx = self.add_node(path, "number", depth, start, parent_id);
                self.parse_number();
                self.finish_node(idx, self.pos, 0);
                Ok(())
            }
            _ => Err("Unexpected JSON token".to_string()),
        }
    }

    fn parse_object(&mut self, path: String, depth: usize, start: usize, parent_id: Option<usize>) -> Result<(), String> {
        let idx = self.add_node(path.clone(), "object", depth, start, parent_id);
        self.bump();
        self.skip_ws();
        let mut child_count = 0;
        if self.peek() == Some(b'}') {
            self.bump();
            self.finish_node(idx, self.pos, child_count);
            return Ok(());
        }

        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err("Expected object key".to_string());
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.bump() != Some(b':') {
                return Err("Expected colon".to_string());
            }
            child_count += 1;
            if depth < self.max_depth && !self.truncated {
                self.parse_value(format!("{}.{}", path, key), depth + 1, idx)?;
            } else {
                self.skip_value()?;
                self.truncated = true;
            }
            self.skip_ws();
            match self.bump() {
                Some(b',') => continue,
                Some(b'}') => break,
                _ => return Err("Expected comma or object end".to_string()),
            }
        }
        self.finish_node(idx, self.pos, child_count);
        Ok(())
    }

    fn parse_array(&mut self, path: String, depth: usize, start: usize, parent_id: Option<usize>) -> Result<(), String> {
        let idx = self.add_node(path.clone(), "array", depth, start, parent_id);
        self.bump();
        self.skip_ws();
        let mut child_count = 0;
        if self.peek() == Some(b']') {
            self.bump();
            self.finish_node(idx, self.pos, child_count);
            return Ok(());
        }

        loop {
            if depth < self.max_depth && !self.truncated {
                self.parse_value(format!("{}[{}]", path, child_count), depth + 1, idx)?;
            } else {
                self.skip_value()?;
                self.truncated = true;
            }
            child_count += 1;
            self.skip_ws();
            match self.bump() {
                Some(b',') => {
                    self.skip_ws();
                    continue;
                }
                Some(b']') => break,
                _ => return Err("Expected comma or array end".to_string()),
            }
        }
        self.finish_node(idx, self.pos, child_count);
        Ok(())
    }

    fn parse_string(&mut self) -> Result<String, String> {
        if self.bump() != Some(b'"') {
            return Err("Expected string".to_string());
        }
        let mut out = String::new();
        while let Some(ch) = self.bump() {
            match ch {
                b'\\' => {
                    if let Some(next) = self.bump() {
                        out.push(next as char);
                    } else {
                        return Err("Invalid escape".to_string());
                    }
                }
                b'"' => return Ok(out),
                _ => out.push(ch as char),
            }
        }
        Err("Unterminated string".to_string())
    }

    fn parse_literal(&mut self) -> Result<(), String> {
        while let Some(ch) = self.peek() {
            if matches!(ch, b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t') {
                break;
            }
            self.pos += 1;
        }
        Ok(())
    }

    fn parse_number(&mut self) {
        while let Some(ch) = self.peek() {
            if !matches!(ch, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E') {
                break;
            }
            self.pos += 1;
        }
    }

    fn skip_value(&mut self) -> Result<(), String> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.skip_compound(b'{', b'}'),
            Some(b'[') => self.skip_compound(b'[', b']'),
            Some(b'"') => self.parse_string().map(|_| ()),
            Some(_) => self.parse_literal(),
            None => Err("Unexpected end of JSON".to_string()),
        }
    }

    fn skip_compound(&mut self, open: u8, close: u8) -> Result<(), String> {
        let mut depth = 0_usize;
        while let Some(ch) = self.bump() {
            if ch == b'"' {
                self.pos -= 1;
                self.parse_string()?;
                continue;
            }
            if ch == open {
                depth += 1;
            } else if ch == close {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Ok(());
                }
            }
        }
        Err("Unterminated JSON structure".to_string())
    }
}

fn build_json_index_cache(
    session: &FileSession,
    max_nodes: usize,
    max_depth: usize,
    max_bytes: u64,
) -> Result<JsonIndexCache, String> {
    let access = NEXT_CACHE_ACCESS.fetch_add(1, Ordering::Relaxed);
    let cache_key = json_cache_key(session, max_nodes.max(1), max_depth.max(1), max_bytes);
    if let Some(mut cache) = load_json_index_from_disk(&cache_key) {
        cache.last_access = access;
        return Ok(cache);
    }

    let read_len = session.size.min(max_bytes.max(1));
    let mut file = fs::File::open(&session.path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut bytes = vec![0_u8; read_len as usize];
    if read_len > 0 {
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read JSON for indexing: {}", e))?;
    }
    let result = JsonScanner::new(bytes, max_nodes.max(1), max_depth.max(1)).scan();
    let estimated_bytes = estimate_json_index_bytes(&result.nodes);
    let cache = JsonIndexCache {
        nodes: result.nodes,
        truncated: result.truncated || read_len < session.size,
        error: result.error,
        max_nodes: max_nodes.max(1),
        max_depth: max_depth.max(1),
        max_bytes,
        estimated_bytes,
        last_access: access,
        cache_key,
    };
    persist_json_index_to_disk(&cache);
    Ok(cache)
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
            // Touch access timestamp without full clone — only clone on return
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
            // Clone once for the return value (unavoidable across lock boundary)
            let result = sessions.get(session_id)
                .and_then(|s| s.json_index.clone())
                .ok_or_else(|| "Session lost during index access".to_string())?;
            return Ok(result);
        }
    }

    let cache = build_json_index_cache(&session, max_nodes, max_depth, max_bytes)?;
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

fn detect_csv_delimiter(sample: &[u8]) -> u8 {
    let candidates = [b',', b';', b'\t', b'|'];
    let mut best = b',';
    let mut best_count = 0_usize;
    for candidate in candidates {
        let mut count = 0_usize;
        let mut in_quotes = false;
        for byte in sample.iter().take(2048) {
            if *byte == b'"' {
                in_quotes = !in_quotes;
            } else if !in_quotes && *byte == candidate {
                count += 1;
            }
        }
        if count > best_count {
            best_count = count;
            best = candidate;
        }
    }
    best
}

fn parse_csv_record(line: &str, delimiter: char) -> Vec<String> {
    let mut cells = Vec::new();
    let mut field = String::new();
    let mut chars = line.chars().peekable();
    let mut in_quotes = false;
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(ch);
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == delimiter {
            cells.push(std::mem::take(&mut field));
        } else if ch != '\r' && ch != '\n' {
            field.push(ch);
        }
    }
    cells.push(field);
    cells
}

fn build_csv_index(session: &FileSession) -> Result<CsvIndexCache, String> {
    let mut file = fs::File::open(&session.path).map_err(|e| format!("Failed to open CSV: {}", e))?;
    let mut sample = vec![0_u8; session.size.min(4096) as usize];
    if !sample.is_empty() {
        file.read_exact(&mut sample)
            .map_err(|e| format!("Failed to read CSV sample: {}", e))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|e| format!("Failed to seek CSV: {}", e))?;
    }
    let delimiter = detect_csv_delimiter(&sample);
    let mut row_offsets = Vec::new();
    let mut buf = vec![0_u8; 1024 * 1024];
    let mut absolute = 0_u64;
    let mut row_start = 0_u64;
    let mut in_quotes = false;
    let mut header_end = None;
    let mut header_bytes = Vec::new();

    loop {
        let read = file.read(&mut buf).map_err(|e| format!("Failed to index CSV: {}", e))?;
        if read == 0 {
            break;
        }
        for (idx, byte) in buf[..read].iter().enumerate() {
            let pos = absolute + idx as u64;
            if *byte == b'"' {
                in_quotes = !in_quotes;
            }
            if !in_quotes && *byte == b'\n' {
                if header_end.is_none() {
                    header_end = Some(pos + 1);
                } else {
                    row_offsets.push(row_start);
                }
                row_start = pos + 1;
            }
        }
        if header_end.is_none() {
            header_bytes.extend_from_slice(&buf[..read]);
        }
        absolute += read as u64;
    }
    if header_end.is_some() && row_start < session.size {
        row_offsets.push(row_start);
    }

    let header_cut = header_bytes.iter().position(|b| *b == b'\n').unwrap_or(header_bytes.len());
    let header_text = decode_with_encoding(&header_bytes[..header_cut], &session.encoding_name);
    let header = parse_csv_record(&header_text, delimiter as char);
    let estimated_bytes = row_offsets.len() * std::mem::size_of::<u64>() + header.iter().map(|h| h.len()).sum::<usize>();
    Ok(CsvIndexCache {
        delimiter,
        header,
        row_offsets,
        estimated_bytes,
        last_access: NEXT_CACHE_ACCESS.fetch_add(1, Ordering::Relaxed),
    })
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

    let cache = build_csv_index(&session)?;
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
    let row_count = index.row_offsets.len();
    let start = offset.min(row_count);
    let end = (start + limit.max(1)).min(row_count);
    let mut file = fs::File::open(&session.path).map_err(|e| format!("Failed to open CSV: {}", e))?;
    let mut rows = Vec::with_capacity(end.saturating_sub(start));
    let delimiter = index.delimiter as char;

    for idx in start..end {
        let from = index.row_offsets[idx];
        let to = if idx + 1 < row_count { index.row_offsets[idx + 1] } else { session.size };
        let len = (to - from).min(1024 * 1024);
        let mut bytes = vec![0_u8; len as usize];
        file.seek(SeekFrom::Start(from))
            .map_err(|e| format!("Failed to seek CSV row: {}", e))?;
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read CSV row: {}", e))?;
        let text = decode_with_encoding(&bytes, &session.encoding_name);
        rows.push(parse_csv_record(&text, delimiter));
    }

    let mut col_count = index.header.len().max(1);
    for row in &rows {
        col_count = col_count.max(row.len());
    }
    let mut header = index.header;
    while header.len() < col_count {
        header.push(format!("col_{}", header.len() + 1));
    }
    for row in &mut rows {
        while row.len() < col_count {
            row.push(String::new());
        }
    }

    Ok(CsvRowsResult {
        delimiter: if index.delimiter == b'\t' { "\\t".to_string() } else { delimiter.to_string() },
        header,
        rows,
        row_count,
        col_count,
        offset: start,
        truncated: end < row_count,
    })
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

        total_json_bytes += json_estimated_bytes;
        total_csv_bytes += csv_estimated_bytes;
        total_line_offsets += line_offset_count;

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
        });
    }

    Ok(SessionDiagnosticsResult {
        total_sessions: entries.len(),
        sessions: entries,
        total_json_bytes,
        total_csv_bytes,
        total_line_offsets,
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

    if pattern.trim().is_empty() {
        return Err("Filter pattern is empty".to_string());
    }
    if pattern.len() > 256 {
        return Err("Filter pattern too long (max 256 chars)".to_string());
    }

    let re = RegexBuilder::new(&pattern)
        .case_insensitive(case_insensitive)
        .size_limit(2 * 1024 * 1024)
        .build()
        .map_err(|e| format!("Invalid filter regex: {}", e))?;

    let capped_max = max_results.max(1).min(5000);
    let row_count = index.row_offsets.len();
    let delimiter = index.delimiter as char;
    let mut file = fs::File::open(&session.path)
        .map_err(|e| format!("Failed to open CSV: {}", e))?;
    let mut matched_rows = Vec::new();
    let mut scanned = 0_usize;
    let mut was_cancelled = false;

    for idx in 0..row_count {
        // Cooperative cancellation check every 1024 rows
        if scanned & 0x3FF == 0 && scanned > 0 && cancelled.load(Ordering::Relaxed) {
            was_cancelled = true;
            METRIC_CANCELLATIONS.fetch_add(1, Ordering::Relaxed);
            break;
        }

        let from = index.row_offsets[idx];
        let to = if idx + 1 < row_count { index.row_offsets[idx + 1] } else { session.size };
        let len = (to - from).min(1024 * 1024);
        let mut bytes = vec![0_u8; len as usize];
        file.seek(SeekFrom::Start(from))
            .map_err(|e| format!("Failed to seek CSV row: {}", e))?;
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read CSV row: {}", e))?;
        let text = decode_with_encoding(&bytes, &session.encoding_name);
        let cells = parse_csv_record(&text, delimiter);
        scanned += 1;

        let cell_value = cells.get(column_index).map(|s| s.as_str()).unwrap_or("");
        if re.is_match(cell_value) {
            matched_rows.push(cells);
            if matched_rows.len() >= capped_max {
                break;
            }
        }
    }

    // Clean up cancel token
    if let Ok(mut tokens) = CANCEL_TOKENS.lock() {
        tokens.remove(&cancel_key);
    }

    Ok(CsvFilterResult {
        header: index.header,
        rows: matched_rows,
        match_count: scanned,
        scanned_count: scanned,
        truncated: was_cancelled || scanned < row_count,
        error: if was_cancelled { "cancelled".to_string() } else { String::new() },
    })
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
