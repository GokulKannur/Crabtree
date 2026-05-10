/// CSV engine: delimiter detection, row parsing, indexing, filtering, sorting.
/// Extracted from lib.rs to clarify ownership boundaries.

use serde::{Deserialize, Serialize};
use regex::RegexBuilder;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

// ─── Public Types ───

#[derive(Clone)]
pub struct CsvIndexCache {
    pub delimiter: u8,
    pub header: Vec<String>,
    pub row_offsets: Vec<u64>,
    pub estimated_bytes: usize,
    pub last_access: u64,
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
pub struct CsvFilterResult {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub match_count: usize,
    pub scanned_count: usize,
    pub truncated: bool,
    pub error: String,
}

#[derive(Serialize, Deserialize)]
pub struct CsvSortResult {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub row_count: usize,
    pub col_count: usize,
    pub offset: usize,
    pub total_rows: usize,
    pub truncated: bool,
    pub error: String,
}

// ─── Delimiter Detection ───

pub fn detect_csv_delimiter(sample: &[u8]) -> u8 {
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

// ─── Record Parsing ───

pub fn parse_csv_record(line: &str, delimiter: char) -> Vec<String> {
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

// ─── Index Building ───

pub fn build_csv_index(path: &Path, size: u64, encoding_name: &str, access: u64) -> Result<CsvIndexCache, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open CSV: {}", e))?;
    let mut sample = vec![0_u8; size.min(4096) as usize];
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
    if header_end.is_some() && row_start < size {
        row_offsets.push(row_start);
    }

    let header_cut = header_bytes.iter().position(|b| *b == b'\n').unwrap_or(header_bytes.len());
    let header_text = decode_with_encoding(&header_bytes[..header_cut], encoding_name);
    let header = parse_csv_record(&header_text, delimiter as char);
    let estimated_bytes = row_offsets.len() * std::mem::size_of::<u64>() + header.iter().map(|h| h.len()).sum::<usize>();
    Ok(CsvIndexCache {
        delimiter,
        header,
        row_offsets,
        estimated_bytes,
        last_access: access,
    })
}

/// Decode bytes with the given encoding name.
fn decode_with_encoding(bytes: &[u8], encoding_name: &str) -> String {
    let encoding = encoding_rs::Encoding::for_label(encoding_name.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (content, _, _) = encoding.decode(bytes);
    content.to_string()
}

// ─── Row Retrieval ───

pub fn get_csv_rows_paged(
    path: &Path,
    size: u64,
    encoding_name: &str,
    index: &CsvIndexCache,
    offset: usize,
    limit: usize,
) -> Result<CsvRowsResult, String> {
    let row_count = index.row_offsets.len();
    let start = offset.min(row_count);
    let end = (start + limit.max(1)).min(row_count);
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open CSV: {}", e))?;
    let mut rows = Vec::with_capacity(end.saturating_sub(start));
    let delimiter = index.delimiter as char;

    for idx in start..end {
        let from = index.row_offsets[idx];
        let to = if idx + 1 < row_count { index.row_offsets[idx + 1] } else { size };
        let len = (to - from).min(1024 * 1024);
        let mut bytes = vec![0_u8; len as usize];
        file.seek(SeekFrom::Start(from))
            .map_err(|e| format!("Failed to seek CSV row: {}", e))?;
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read CSV row: {}", e))?;
        let text = decode_with_encoding(&bytes, encoding_name);
        rows.push(parse_csv_record(&text, delimiter));
    }

    let mut col_count = index.header.len().max(1);
    for row in &rows {
        col_count = col_count.max(row.len());
    }
    let mut header = index.header.clone();
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

// ─── Filtering ───

pub fn filter_csv_rows_impl(
    path: &Path,
    size: u64,
    encoding_name: &str,
    index: &CsvIndexCache,
    column_index: usize,
    pattern: &str,
    max_results: usize,
    case_insensitive: bool,
    cancelled: &Arc<AtomicBool>,
    cancellation_metric: &std::sync::atomic::AtomicU64,
) -> Result<CsvFilterResult, String> {
    if pattern.trim().is_empty() {
        return Err("Filter pattern is empty".to_string());
    }
    if pattern.len() > 256 {
        return Err("Filter pattern too long (max 256 chars)".to_string());
    }

    let re = RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .size_limit(2 * 1024 * 1024)
        .build()
        .map_err(|e| format!("Invalid filter regex: {}", e))?;

    let capped_max = max_results.max(1).min(5000);
    let row_count = index.row_offsets.len();
    let delimiter = index.delimiter as char;
    let mut file = fs::File::open(path)
        .map_err(|e| format!("Failed to open CSV: {}", e))?;
    let mut matched_rows = Vec::new();
    let mut scanned = 0_usize;
    let mut was_cancelled = false;

    for idx in 0..row_count {
        // Cooperative cancellation check every 1024 rows
        if scanned & 0x3FF == 0 && scanned > 0 && cancelled.load(Ordering::Relaxed) {
            was_cancelled = true;
            cancellation_metric.fetch_add(1, Ordering::Relaxed);
            break;
        }

        let from = index.row_offsets[idx];
        let to = if idx + 1 < row_count { index.row_offsets[idx + 1] } else { size };
        let len = (to - from).min(1024 * 1024);
        let mut bytes = vec![0_u8; len as usize];
        file.seek(SeekFrom::Start(from))
            .map_err(|e| format!("Failed to seek CSV row: {}", e))?;
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read CSV row: {}", e))?;
        let text = decode_with_encoding(&bytes, encoding_name);
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

    Ok(CsvFilterResult {
        header: index.header.clone(),
        rows: matched_rows,
        match_count: scanned,
        scanned_count: scanned,
        truncated: was_cancelled || scanned < row_count,
        error: if was_cancelled { "cancelled".to_string() } else { String::new() },
    })
}

// ─── Sorting ───

/// Native CSV column sort with bounded paged output.
/// Sorts by reading only the sort column values, building a sorted index,
/// then returning a paged window of full rows.
pub fn sort_csv_rows_impl(
    path: &Path,
    size: u64,
    encoding_name: &str,
    index: &CsvIndexCache,
    column_index: usize,
    ascending: bool,
    offset: usize,
    limit: usize,
    cancelled: &Arc<AtomicBool>,
    cancellation_metric: &std::sync::atomic::AtomicU64,
) -> Result<CsvSortResult, String> {
    let row_count = index.row_offsets.len();
    let delimiter = index.delimiter as char;
    let capped_limit = limit.max(1).min(5000);

    // Phase 1: Read sort-column values for all rows
    let mut sort_keys: Vec<(usize, String)> = Vec::with_capacity(row_count);
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open CSV: {}", e))?;

    for idx in 0..row_count {
        // Cooperative cancellation every 1024 rows
        if idx & 0x3FF == 0 && idx > 0 && cancelled.load(Ordering::Relaxed) {
            cancellation_metric.fetch_add(1, Ordering::Relaxed);
            return Ok(CsvSortResult {
                header: index.header.clone(),
                rows: vec![],
                row_count,
                col_count: index.header.len(),
                offset: 0,
                total_rows: row_count,
                truncated: true,
                error: "cancelled".to_string(),
            });
        }

        let from = index.row_offsets[idx];
        let to = if idx + 1 < row_count { index.row_offsets[idx + 1] } else { size };
        let len = (to - from).min(1024 * 1024);
        let mut bytes = vec![0_u8; len as usize];
        file.seek(SeekFrom::Start(from))
            .map_err(|e| format!("Failed to seek CSV row: {}", e))?;
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read CSV row: {}", e))?;
        let text = decode_with_encoding(&bytes, encoding_name);
        let cells = parse_csv_record(&text, delimiter);
        let key = cells.get(column_index).cloned().unwrap_or_default();
        sort_keys.push((idx, key));
    }

    // Phase 2: Sort
    sort_keys.sort_by(|(_, a), (_, b)| {
        let na = a.parse::<f64>();
        let nb = b.parse::<f64>();
        if let (Ok(na), Ok(nb)) = (na, nb) {
            let cmp = na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal);
            return if ascending { cmp } else { cmp.reverse() };
        }
        let cmp = a.to_lowercase().cmp(&b.to_lowercase());
        if ascending { cmp } else { cmp.reverse() }
    });

    // Phase 3: Read paged window of full rows
    let start = offset.min(row_count);
    let end = (start + capped_limit).min(row_count);
    let mut rows = Vec::with_capacity(end.saturating_sub(start));

    for (row_idx, _) in &sort_keys[start..end] {
        let from = index.row_offsets[*row_idx];
        let to = if *row_idx + 1 < row_count { index.row_offsets[*row_idx + 1] } else { size };
        let len = (to - from).min(1024 * 1024);
        let mut bytes = vec![0_u8; len as usize];
        file.seek(SeekFrom::Start(from))
            .map_err(|e| format!("Failed to seek CSV row: {}", e))?;
        file.read_exact(&mut bytes)
            .map_err(|e| format!("Failed to read CSV row: {}", e))?;
        let text = decode_with_encoding(&bytes, encoding_name);
        rows.push(parse_csv_record(&text, delimiter));
    }

    let mut col_count = index.header.len().max(1);
    for row in &rows {
        col_count = col_count.max(row.len());
    }
    let mut header = index.header.clone();
    while header.len() < col_count {
        header.push(format!("col_{}", header.len() + 1));
    }
    for row in &mut rows {
        while row.len() < col_count {
            row.push(String::new());
        }
    }

    Ok(CsvSortResult {
        header,
        rows,
        row_count: end.saturating_sub(start),
        col_count,
        offset: start,
        total_rows: row_count,
        truncated: end < row_count,
        error: String::new(),
    })
}
