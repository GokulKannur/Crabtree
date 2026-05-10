/// JSON structural indexing engine: scanner, index cache, disk persistence.
/// Extracted from lib.rs to clarify ownership boundaries.

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::cache::{JSON_INDEX_DISK_VERSION};

// ─── Public Types ───

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
pub struct JsonIndexCache {
    pub nodes: Vec<JsonIndexNode>,
    pub truncated: bool,
    pub error: String,
    pub max_nodes: usize,
    pub max_depth: usize,
    pub max_bytes: u64,
    pub estimated_bytes: usize,
    pub last_access: u64,
    pub cache_key: String,
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

// ─── Helpers ───

pub fn estimate_json_index_bytes(nodes: &[JsonIndexNode]) -> usize {
    nodes
        .iter()
        .map(|node| std::mem::size_of::<JsonIndexNode>() + node.path.len() + node.kind.len())
        .sum()
}

fn file_modified_millis(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn json_cache_key(path: &Path, size: u64, max_nodes: usize, max_depth: usize, max_bytes: u64) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    size.hash(&mut hasher);
    file_modified_millis(path).hash(&mut hasher);
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

pub fn load_json_index_from_disk(cache_key: &str) -> Option<JsonIndexCache> {
    let path = json_cache_path(cache_key);
    let raw = fs::read_to_string(path).ok()?;
    let persisted: PersistedJsonIndexCache = serde_json::from_str(&raw).ok()?;
    if persisted.version != JSON_INDEX_DISK_VERSION || persisted.cache_key != cache_key {
        return None;
    }
    Some(persisted.cache)
}

pub fn persist_json_index_to_disk(cache: &JsonIndexCache) {
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

// ─── JSON Scanner ───

pub struct JsonScanner {
    bytes: Vec<u8>,
    pos: usize,
    nodes: Vec<JsonIndexNode>,
    max_nodes: usize,
    max_depth: usize,
    truncated: bool,
}

impl JsonScanner {
    pub fn new(bytes: Vec<u8>, max_nodes: usize, max_depth: usize) -> Self {
        Self {
            bytes,
            pos: 0,
            nodes: Vec::new(),
            max_nodes,
            max_depth,
            truncated: false,
        }
    }

    pub fn scan(mut self) -> JsonIndexResult {
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

// ─── Index Building ───

/// Build a JSON structural index for a file session.
/// `path` is the file path, `size` is file size, `access` is the cache access counter value.
pub fn build_json_index_cache(
    path: &Path,
    size: u64,
    max_nodes: usize,
    max_depth: usize,
    max_bytes: u64,
    access: u64,
) -> Result<JsonIndexCache, String> {
    let cache_key = json_cache_key(path, size, max_nodes.max(1), max_depth.max(1), max_bytes);
    if let Some(mut cache) = load_json_index_from_disk(&cache_key) {
        cache.last_access = access;
        return Ok(cache);
    }

    let read_len = size.min(max_bytes.max(1));
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut bytes = vec![0_u8; read_len as usize];
    if read_len > 0 {
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read JSON for indexing: {}", e))?;
    }
    let result = JsonScanner::new(bytes, max_nodes.max(1), max_depth.max(1)).scan();
    let estimated_bytes = estimate_json_index_bytes(&result.nodes);
    let cache = JsonIndexCache {
        nodes: result.nodes,
        truncated: result.truncated || read_len < size,
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

// ─── Path Normalization ───

pub fn normalize_json_path(raw_path: &str) -> String {
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
