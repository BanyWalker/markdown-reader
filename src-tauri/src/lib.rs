use chardetng::EncodingDetector;
use encoding_rs::{
    Encoding, BIG5, EUC_JP, EUC_KR, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252,
};
use rfd::FileDialog;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, MoveFileExW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
    FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, OPEN_EXISTING,
};

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx", "mdown", "mkdn"];
const PLAIN_TEXT_EXTENSIONS: &[&str] = &["txt", "text", "log", "rst"];
const SKIPPED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".tools",
];
const MAX_FILE_SIZE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReaderFile {
    content: String,
    file_path: String,
    file_name: String,
    directory_path: String,
    modified_at: f64,
    is_plain_text: bool,
    encoding: String,
    has_bom: bool,
    is_read_only: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReaderDirectory {
    directory_path: String,
    files: Vec<ReaderFile>,
    skipped_files: u32,
}

struct PendingReaderFile(Mutex<Option<ReaderFile>>);
struct AllowedReaderFiles(Mutex<HashSet<PathBuf>>);
struct WatchedReaderDirectories(Mutex<HashSet<PathBuf>>);

fn extension_in(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|supported| extension.eq_ignore_ascii_case(supported))
        })
}

fn is_supported_text_file(path: &Path) -> bool {
    extension_in(path, MARKDOWN_EXTENSIONS) || extension_in(path, PLAIN_TEXT_EXTENSIONS)
}

fn is_plain_text_file(path: &Path) -> bool {
    extension_in(path, PLAIN_TEXT_EXTENSIONS)
}

fn should_skip_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            SKIPPED_DIRECTORY_NAMES
                .iter()
                .any(|skipped| name.eq_ignore_ascii_case(skipped))
        })
}

struct DecodedReaderText {
    content: String,
    encoding: String,
    has_bom: bool,
}

fn decode_utf32(bytes: &[u8], little_endian: bool) -> Result<String, String> {
    if bytes.len() % 4 != 0 {
        return Err("The file has an incomplete UTF-32 character.".to_string());
    }
    let code_points = bytes.chunks_exact(4).map(|chunk| {
        let value = if little_endian {
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        } else {
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        };
        char::from_u32(value)
            .ok_or_else(|| "The file contains an invalid Unicode character.".to_string())
    });
    code_points.collect()
}

fn looks_like_utf16(bytes: &[u8]) -> Option<&'static Encoding> {
    if bytes.len() < 8 || bytes.len() % 2 != 0 {
        return None;
    }
    let pairs = bytes.chunks_exact(2).take(4096).collect::<Vec<_>>();
    let little_zeroes = pairs.iter().filter(|pair| pair[1] == 0).count();
    let big_zeroes = pairs.iter().filter(|pair| pair[0] == 0).count();
    let threshold = pairs.len() * 3 / 10;
    if little_zeroes >= threshold && little_zeroes > big_zeroes * 2 {
        Some(UTF_16LE)
    } else if big_zeroes >= threshold && big_zeroes > little_zeroes * 2 {
        Some(UTF_16BE)
    } else {
        None
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.is_empty() {
        return false;
    }
    let control_count = sample
        .iter()
        .filter(|byte| **byte == 0 || (**byte < 0x09) || (**byte > 0x0D && **byte < 0x20))
        .count();
    control_count * 100 > sample.len() * 2
}

fn decode_reader_bytes(bytes: &[u8]) -> Result<DecodedReaderText, String> {
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        return Ok(DecodedReaderText {
            content: decode_utf32(&bytes[4..], true)?,
            encoding: "UTF-32LE".to_string(),
            has_bom: true,
        });
    }
    if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
        return Ok(DecodedReaderText {
            content: decode_utf32(&bytes[4..], false)?,
            encoding: "UTF-32BE".to_string(),
            has_bom: true,
        });
    }

    if let Some((encoding, bom_length)) = Encoding::for_bom(bytes) {
        let (content, had_errors) = encoding.decode_without_bom_handling(&bytes[bom_length..]);
        if had_errors {
            return Err(format!(
                "The file contains invalid {} data.",
                encoding.name()
            ));
        }
        return Ok(DecodedReaderText {
            content: content.into_owned(),
            encoding: encoding.name().to_string(),
            has_bom: true,
        });
    }

    if std::str::from_utf8(bytes).is_ok() {
        return Ok(DecodedReaderText {
            content: String::from_utf8(bytes.to_vec())
                .map_err(|_| "Unable to decode the UTF-8 file.".to_string())?,
            encoding: UTF_8.name().to_string(),
            has_bom: false,
        });
    }

    if let Some(encoding) = looks_like_utf16(bytes) {
        let (content, had_errors) = encoding.decode_without_bom_handling(bytes);
        if !had_errors {
            return Ok(DecodedReaderText {
                content: content.into_owned(),
                encoding: encoding.name().to_string(),
                has_bom: false,
            });
        }
    }

    if looks_binary(bytes) {
        return Err(
            "The selected file appears to be binary and cannot be decoded as text.".to_string(),
        );
    }

    let sample = &bytes[..bytes.len().min(1024 * 1024)];
    let mut detector = EncodingDetector::new();
    detector.feed(sample, true);
    let (detected, _) = detector.guess_assess(None, true);
    let candidates = [detected, GBK, BIG5, SHIFT_JIS, EUC_JP, EUC_KR, WINDOWS_1252];
    for encoding in candidates {
        let (content, had_errors) = encoding.decode_without_bom_handling(bytes);
        if !had_errors && !content.contains('\u{FFFD}') {
            return Ok(DecodedReaderText {
                content: content.into_owned(),
                encoding: encoding.name().to_string(),
                has_bom: false,
            });
        }
    }

    Err("Unable to recognize the text encoding of this file.".to_string())
}

fn read_reader_file(path: PathBuf) -> Result<ReaderFile, String> {
    if !is_supported_text_file(&path) {
        return Err("Please select a supported Markdown or text file.".to_string());
    }

    let metadata =
        fs::metadata(&path).map_err(|_| "Unable to read the selected file.".to_string())?;
    if !metadata.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    if metadata.len() > MAX_FILE_SIZE_BYTES {
        return Err("Files larger than 25 MB are not supported.".to_string());
    }

    let raw_content =
        fs::read(&path).map_err(|_| "Unable to read the selected file.".to_string())?;
    let decoded = decode_reader_bytes(&raw_content)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled document")
        .to_string();
    let directory_path = path
        .parent()
        .map(|directory| directory.to_string_lossy().to_string())
        .ok_or_else(|| "Unable to determine the document directory.".to_string())?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);

    Ok(ReaderFile {
        content: decoded.content,
        file_path: path.to_string_lossy().to_string(),
        file_name,
        directory_path,
        modified_at,
        is_plain_text: is_plain_text_file(&path),
        encoding: decoded.encoding,
        has_bom: decoded.has_bom,
        is_read_only: metadata.permissions().readonly(),
    })
}

fn register_reader_file(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|_| "Unable to resolve the selected file.".to_string())?;
    let allowed_reader_files = app.state::<AllowedReaderFiles>();
    let mut allowed_files = allowed_reader_files
        .0
        .lock()
        .map_err(|_| "Unable to authorize the selected file.".to_string())?;

    allowed_files.insert(canonical_path);
    Ok(())
}

fn load_reader_file(app: &tauri::AppHandle, path: PathBuf) -> Result<ReaderFile, String> {
    let directory = path
        .parent()
        .ok_or_else(|| "Unable to determine the document directory.".to_string())?;
    app.asset_protocol_scope()
        .allow_directory(directory, true)
        .map_err(|_| "Unable to allow local images in this document directory.".to_string())?;
    register_reader_file(app, &path)?;

    read_reader_file(path)
}

fn file_modified_at(metadata: &fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[tauri::command]
fn get_reader_file_modified_at(file_path: String) -> Result<f64, String> {
    let path = PathBuf::from(file_path);
    let metadata = fs::metadata(&path).map_err(|_| "Unable to read the current file metadata.".to_string())?;
    if !metadata.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    Ok(file_modified_at(&metadata))
}

fn normalize_line_endings(content: &str, uses_crlf: bool) -> String {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    if uses_crlf {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    }
}

fn encode_utf32(content: &str, little_endian: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(content.len() * 2);
    for character in content.chars() {
        let code_point = character as u32;
        let encoded = if little_endian {
            code_point.to_le_bytes()
        } else {
            code_point.to_be_bytes()
        };
        bytes.extend_from_slice(&encoded);
    }
    bytes
}

fn encode_utf16(content: &str, little_endian: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(content.len() * 2);
    for code_unit in content.encode_utf16() {
        let encoded = if little_endian {
            code_unit.to_le_bytes()
        } else {
            code_unit.to_be_bytes()
        };
        bytes.extend_from_slice(&encoded);
    }
    bytes
}

fn replace_file_atomically(temporary_path: &Path, path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    let temporary_path_wide = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let path_wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            temporary_path_wide.as_ptr(),
            path_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if result == 0 {
        return Err("Unable to replace the existing document.".to_string());
    }
    Ok(())
}

fn write_reader_file(
    path: &Path,
    content: &str,
    original_metadata: &fs::Metadata,
    encoding_name: &str,
) -> Result<(), String> {
    let raw_content =
        fs::read(path).map_err(|_| "Unable to read the current file before saving.".to_string())?;
    let current_text = decode_reader_bytes(&raw_content)?;
    let uses_crlf = current_text.content.contains("\r\n");
    let normalized_content = normalize_line_endings(content, uses_crlf);
    let mut output = Vec::new();
    if encoding_name.eq_ignore_ascii_case("UTF-16LE") {
        if current_text.has_bom {
            output.extend_from_slice(&[0xFF, 0xFE]);
        }
        output.extend_from_slice(&encode_utf16(&normalized_content, true));
    } else if encoding_name.eq_ignore_ascii_case("UTF-16BE") {
        if current_text.has_bom {
            output.extend_from_slice(&[0xFE, 0xFF]);
        }
        output.extend_from_slice(&encode_utf16(&normalized_content, false));
    } else if encoding_name.eq_ignore_ascii_case("UTF-32LE") {
        if current_text.has_bom {
            output.extend_from_slice(&[0xFF, 0xFE, 0x00, 0x00]);
        }
        output.extend_from_slice(&encode_utf32(&normalized_content, true));
    } else if encoding_name.eq_ignore_ascii_case("UTF-32BE") {
        if current_text.has_bom {
            output.extend_from_slice(&[0x00, 0x00, 0xFE, 0xFF]);
        }
        output.extend_from_slice(&encode_utf32(&normalized_content, false));
    } else {
        let encoding = Encoding::for_label(encoding_name.as_bytes())
            .ok_or_else(|| format!("Unsupported text encoding: {encoding_name}"))?;
        let (encoded, _, had_errors) = encoding.encode(&normalized_content);
        if had_errors {
            return Err(format!(
                "The edited content cannot be represented in {encoding_name}."
            ));
        }
        if current_text.has_bom {
            match encoding.name() {
                "UTF-8" => output.extend_from_slice(&[0xEF, 0xBB, 0xBF]),
                "UTF-16LE" => output.extend_from_slice(&[0xFF, 0xFE]),
                "UTF-16BE" => output.extend_from_slice(&[0xFE, 0xFF]),
                _ => {}
            }
        }
        output.extend_from_slice(&encoded);
    }

    if output.len() as u64 > MAX_FILE_SIZE_BYTES {
        return Err("Files larger than 25 MB are not supported.".to_string());
    }
    if original_metadata.permissions().readonly() {
        return Err("The current file is read-only and cannot be saved.".to_string());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Unable to determine the document directory.".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temporary_path = parent.join(format!(".{file_name}.{timestamp}.md-reader.tmp"));

    let write_result = (|| -> Result<(), String> {
        let mut temporary_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|_| "Unable to create a temporary file for saving.".to_string())?;
        temporary_file
            .write_all(&output)
            .map_err(|_| "Unable to write the document.".to_string())?;
        temporary_file
            .sync_all()
            .map_err(|_| "Unable to finish writing the document.".to_string())?;
        fs::set_permissions(&temporary_path, original_metadata.permissions())
            .map_err(|_| "Unable to preserve the document permissions.".to_string())?;
        replace_file_atomically(&temporary_path, path)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result
}

fn collect_reader_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let mut pending_directories = vec![directory.to_path_buf()];
    let mut is_root = true;

    while let Some(current_directory) = pending_directories.pop() {
        let entries = match fs::read_dir(&current_directory) {
            Ok(entries) => entries,
            Err(_) if is_root => {
                return Err("Unable to read the selected directory.".to_string());
            }
            Err(_) => continue,
        };
        is_root = false;

        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() && !should_skip_directory(&path) {
                pending_directories.push(path);
            } else if file_type.is_file() && is_supported_text_file(&path) {
                files.push(path);
            }
        }
    }

    Ok(())
}

fn watch_reader_directory(app: &tauri::AppHandle, directory: &Path) {
    let Ok(canonical_directory) = directory.canonicalize() else {
        return;
    };
    let watched_directories = app.state::<WatchedReaderDirectories>();
    {
        let Ok(mut directories) = watched_directories.0.lock() else {
            return;
        };
        if !directories.insert(canonical_directory.clone()) {
            return;
        }
    }

    let event_directory = directory.to_string_lossy().to_string();
    let event_app = app.clone();
    let watch_path = canonical_directory.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("reader-directory-watch".to_string())
        .spawn(move || {
            use std::os::windows::ffi::OsStrExt;

            let wide_path = watch_path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let directory_handle = unsafe {
                CreateFileW(
                    wide_path.as_ptr(),
                    FILE_LIST_DIRECTORY,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS,
                    std::ptr::null_mut(),
                )
            };

            if directory_handle == INVALID_HANDLE_VALUE {
                eprintln!("Unable to watch reader directory {}.", watch_path.display());
            } else {
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    let mut bytes_returned = 0;
                    let did_receive_change = unsafe {
                        ReadDirectoryChangesW(
                            directory_handle,
                            buffer.as_mut_ptr().cast(),
                            buffer.len() as u32,
                            1,
                            FILE_NOTIFY_CHANGE_FILE_NAME
                                | FILE_NOTIFY_CHANGE_DIR_NAME
                                | FILE_NOTIFY_CHANGE_LAST_WRITE
                                | FILE_NOTIFY_CHANGE_SIZE,
                            &mut bytes_returned,
                            std::ptr::null_mut(),
                            None,
                        )
                    };
                    if did_receive_change == 0 {
                        break;
                    }
                    if let Err(error) = event_app.emit("reader-directory-changed", &event_directory) {
                        eprintln!("Unable to notify the reader about a directory change: {error}");
                    }
                }
                unsafe { CloseHandle(directory_handle) };
            }

            if let Ok(mut directories) = event_app.state::<WatchedReaderDirectories>().0.lock() {
                directories.remove(&watch_path);
            }
        })
    {
        eprintln!("Unable to start a reader directory watcher: {error}");
        if let Ok(mut directories) = watched_directories.0.lock() {
            directories.remove(&canonical_directory);
        }
    }
}

fn startup_file_path() -> Option<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.is_file() && is_supported_text_file(path))
}

#[tauri::command]
fn open_reader_file(app: tauri::AppHandle) -> Result<Option<ReaderFile>, String> {
    let selected_path = FileDialog::new()
        .set_title("Open Markdown or text file")
        .add_filter(
            "Markdown and text",
            &[
                "md", "markdown", "mdx", "mdown", "mkdn", "txt", "text", "log", "rst",
            ],
        )
        .pick_file();

    selected_path
        .map(|path| load_reader_file(&app, path))
        .transpose()
}

#[tauri::command]
fn open_reader_path(app: tauri::AppHandle, file_path: String) -> Result<ReaderFile, String> {
    load_reader_file(&app, PathBuf::from(file_path))
}

fn read_reader_directory(
    app: &tauri::AppHandle,
    directory: PathBuf,
) -> Result<ReaderDirectory, String> {
    if !directory.is_dir() {
        return Err("The selected directory does not exist.".to_string());
    }

    watch_reader_directory(app, &directory);

    app.asset_protocol_scope()
        .allow_directory(&directory, true)
        .map_err(|_| "Unable to allow local images in this document directory.".to_string())?;

    let mut paths = Vec::new();
    collect_reader_files(&directory, &mut paths)?;
    paths.sort_by_key(|path| path.to_string_lossy().to_lowercase());
    if paths.is_empty() {
        return Err("No Markdown files were found in the selected directory.".to_string());
    }

    let mut files = Vec::with_capacity(paths.len());
    let mut skipped_files = 0;
    for path in paths {
        register_reader_file(app, &path)?;
        match read_reader_file(path) {
            Ok(file) => files.push(file),
            Err(_) => skipped_files += 1,
        }
    }

    if files.is_empty() {
        return Err(
            "No readable Markdown or text files were found in the selected directory.".to_string(),
        );
    }

    Ok(ReaderDirectory {
        directory_path: directory.to_string_lossy().to_string(),
        files,
        skipped_files,
    })
}

#[tauri::command]
fn open_reader_directory(app: tauri::AppHandle) -> Result<Option<ReaderDirectory>, String> {
    FileDialog::new()
        .set_title("Open Markdown directory")
        .pick_folder()
        .map(|directory| read_reader_directory(&app, directory))
        .transpose()
}

#[tauri::command]
fn load_reader_directory(
    app: tauri::AppHandle,
    directory_path: String,
) -> Result<ReaderDirectory, String> {
    read_reader_directory(&app, PathBuf::from(directory_path))
}

#[tauri::command]
fn save_reader_file(
    app: tauri::AppHandle,
    file_path: String,
    content: String,
    encoding: String,
    expected_modified_at: f64,
    force: bool,
) -> Result<ReaderFile, String> {
    let path = PathBuf::from(file_path);
    if !is_supported_text_file(&path) {
        return Err("Please select a supported Markdown or text file.".to_string());
    }
    if content.as_bytes().len() as u64 > MAX_FILE_SIZE_BYTES {
        return Err("Files larger than 25 MB are not supported.".to_string());
    }

    let canonical_path = path
        .canonicalize()
        .map_err(|_| "The selected file no longer exists.".to_string())?;
    let allowed_reader_files = app.state::<AllowedReaderFiles>();
    let is_allowed = allowed_reader_files
        .0
        .lock()
        .map_err(|_| "Unable to validate the selected file.".to_string())?
        .contains(&canonical_path);
    if !is_allowed {
        return Err("Saving is allowed only for documents opened by MD Reader.".to_string());
    }

    let metadata = fs::metadata(&canonical_path)
        .map_err(|_| "Unable to read the current file.".to_string())?;
    if !metadata.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    if metadata.len() > MAX_FILE_SIZE_BYTES {
        return Err("Files larger than 25 MB are not supported.".to_string());
    }

    let current_modified_at = file_modified_at(&metadata);
    if !force && (current_modified_at - expected_modified_at).abs() > 0.5 {
        return Err("FILE_CHANGED_ON_DISK".to_string());
    }

    write_reader_file(&canonical_path, &content, &metadata, &encoding)?;
    load_reader_file(&app, canonical_path)
}

#[tauri::command]
fn take_startup_reader_file(state: tauri::State<PendingReaderFile>) -> Option<ReaderFile> {
    state.0.lock().ok()?.take()
}

pub fn run() {
    let launch_file = startup_file_path();

    tauri::Builder::default()
        .manage(PendingReaderFile(Mutex::new(None)))
        .manage(AllowedReaderFiles(Mutex::new(HashSet::new())))
        .manage(WatchedReaderDirectories(Mutex::new(HashSet::new())))
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            if let Some(path) = launch_file {
                match load_reader_file(&app.handle(), path) {
                    Ok(reader_file) => {
                        if let Ok(mut pending_file) = app.state::<PendingReaderFile>().0.lock() {
                            *pending_file = Some(reader_file);
                        }
                    }
                    Err(error) => eprintln!("Unable to open startup document: {error}"),
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_reader_file,
            open_reader_path,
            open_reader_directory,
            load_reader_directory,
            save_reader_file,
            get_reader_file_modified_at,
            take_startup_reader_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running MD Reader");
}
