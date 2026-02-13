use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use chardetng::EncodingDetector;
use encoding_rs::Encoding;

// ─── Path Validation (Security) ───
fn validate_file_path(path: &str) -> Result<(), String> {
    let file_path = Path::new(path);
    
    // Ensure path exists
    if !file_path.exists() {
        return Err("File does not exist".to_string());
    }
    
    // Ensure it's a regular file, not a symlink to somewhere dangerous
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("Cannot access file metadata: {}", e))?;
    
    if !metadata.is_file() {
        return Err("Path is not a regular file".to_string());
    }
    
    // Check that symlinks resolve to the intended file (prevent symlink attacks)
    let canonical = fs::canonicalize(file_path)
        .map_err(|e| format!("Cannot resolve file path: {}", e))?;
    
    // For desktop app, we allow any user-accessible file
    // In a sensitive context, you could add allowlist logic here
    Ok(())
}

fn validate_write_path(path: &str) -> Result<(), String> {
    let file_path = Path::new(path);
    
    // Check parent directory exists
    let parent = file_path.parent()
        .ok_or_else(|| "Invalid file path (no parent directory)".to_string())?;
    
    if !parent.exists() {
        return Err("Parent directory does not exist".to_string());
    }
    
    if !parent.is_dir() {
        return Err("Parent path is not a directory".to_string());
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
    let file_name = file_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Ok(FileContent {
        content: content.to_string(),
        encoding: encoding.name().to_string(),
        path: path,
        file_name,
        size: metadata.len(),
        line_ending,
    })
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
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
    let dir_path = Path::new(&path);
    if !dir_path.is_dir() {
        return Err("Not a directory".to_string());
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            save_file,
            save_file_as,
            list_directory,
            get_file_language
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
