/// Log query engine: compilation, matching, and result caching.
/// Extracted from lib.rs to clarify ownership boundaries.

use serde::{Deserialize, Serialize};
use regex::{Regex, RegexBuilder};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

// ─── Public Types ───

#[derive(Serialize, Deserialize, Clone)]
pub struct LogClauseInfo {
    pub token: String,
    pub negate: bool,
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

#[derive(Serialize, Deserialize)]
pub struct LogLineWindow {
    pub lines: Vec<String>,
    pub start_line: usize,
    pub line_count: usize,
}

// ─── Internal Types ───

#[derive(Clone)]
pub enum LogPredicate {
    Contains(String),
    FieldContains { field: String, value: String },
    Regex(Regex),
    Severity(String),
}

#[derive(Clone)]
pub struct LogCondition {
    pub token: String,
    pub negate: bool,
    pub predicate: LogPredicate,
}

pub struct CompiledLogQuery {
    pub clauses: Vec<Vec<LogCondition>>,
    pub term_count: usize,
}

// ─── Result Cache ───

/// Cached filter result: stores byte offsets of matching lines instead of line content.
/// This shifts ownership from JS (holding thousands of strings) to Rust (holding u64 offsets).
pub struct LogQueryResultCache {
    pub query_hash: u64,
    pub line_offsets: Vec<u64>,
    pub total_count: usize,
    pub result_count: usize,
    pub clause_count: usize,
    pub term_count: usize,
    pub clause_info: Vec<Vec<LogClauseInfo>>,
    pub estimated_bytes: usize,
}

impl LogQueryResultCache {
    pub fn estimate_bytes(&self) -> usize {
        self.line_offsets.len() * std::mem::size_of::<u64>()
            + self.clause_info.iter().map(|c| c.iter().map(|i| i.token.len() + 2).sum::<usize>()).sum::<usize>()
            + std::mem::size_of::<Self>()
    }
}

/// Compute a cache key hash from query text + file identity.
pub fn log_query_cache_key(raw_query: &str, file_size: u64, modified_millis: u128) -> u64 {
    let mut hasher = DefaultHasher::new();
    raw_query.hash(&mut hasher);
    file_size.hash(&mut hasher);
    modified_millis.hash(&mut hasher);
    hasher.finish()
}

// ─── Query Parsing ───

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

pub fn compile_log_query_native(raw_query: &str) -> Result<CompiledLogQuery, String> {
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

// ─── Matching ───

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

pub fn matches_compiled_log_query(compiled: &CompiledLogQuery, line: &str) -> bool {
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

pub fn log_clause_info(compiled: &CompiledLogQuery) -> Vec<Vec<LogClauseInfo>> {
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
