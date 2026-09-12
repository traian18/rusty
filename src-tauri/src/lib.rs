// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod git;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_window_state::{StateFlags, WindowExt};
use tauri::Manager;
use tauri::Emitter;
use tauri::webview::PageLoadEvent;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem, MasterPty};
use std::io::{Write, Read};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<FileEntry>>,
}

pub struct VfsState(pub Arc<Mutex<HashMap<String, HashMap<String, String>>>>);
pub struct NodeFileTracker(pub Arc<Mutex<HashMap<String, HashMap<String, Vec<String>>>>>);
pub struct CurrentExecutingNode(pub Arc<Mutex<Option<String>>>);

pub struct SidecarState(pub Arc<Mutex<Option<CommandChild>>>);

pub struct TerminalSession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct TerminalState(pub Arc<Mutex<HashMap<String, TerminalSession>>>);

/// Build the command for an interactive, login shell backed by a native PTY.
///
/// On macOS, GUI applications do not necessarily inherit the environment that
/// Terminal.app receives. Starting the user's configured shell as a login
/// shell lets zsh/bash/fish load the same profile files as a normal terminal.
fn terminal_shell_command() -> (String, Vec<&'static str>) {
    #[cfg(target_os = "windows")]
    {
        return ("powershell.exe".to_string(), vec!["-NoLogo"]);
    }

    #[cfg(target_os = "macos")]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|candidate| Path::new(candidate).is_file())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        return (shell, vec!["-l"]);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|candidate| Path::new(candidate).is_file())
            .unwrap_or_else(|| "/bin/sh".to_string());
        return (shell, vec!["-l"]);
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        ("sh".to_string(), Vec::new())
    }
}


fn get_tab_id(tab_id: Option<String>) -> String {
    let t = tab_id.unwrap_or_default();
    if t.is_empty() {
        "global".to_string()
    } else {
        t
    }
}

#[tauri::command]
async fn read_file_vfs(
    state: tauri::State<'_, VfsState>,
    path: String,
    tab_id: Option<String>,
) -> Result<String, String> {
    let tid = get_tab_id(tab_id);
    println!("Rust [read_file_vfs] called for path: {}, tab_id: {}", path, tid);
    let vfs = state.0.lock().map_err(|e| e.to_string())?;

    // Check VFS first
    if let Some(tab_map) = vfs.get(&tid) {
        if let Some(content) = tab_map.get(&path) {
            println!("Rust [read_file_vfs] cache hit in VFS memory for tab: {}", tid);
            return Ok(content.clone());
        }
    }

    // Fall back to physical disk
    println!("Rust [read_file_vfs] cache miss, reading from physical disk");
    let path_buf = PathBuf::from(&path);
    if path_buf.exists() {
        std::fs::read_to_string(&path_buf).map_err(|e| e.to_string())
    } else {
        Err("File not found".into())
    }
}

#[tauri::command]
async fn write_file_vfs(
    state: tauri::State<'_, VfsState>,
    node_file_tracker: tauri::State<'_, NodeFileTracker>,
    path: String,
    content: String,
    node_id: Option<String>,
    tab_id: Option<String>,
) -> Result<(), String> {
    let tid = get_tab_id(tab_id);
    println!(
        "Rust [write_file_vfs] writing path: {} (content size: {} chars), node_id: {:?}, tab_id: {}",
        path,
        content.len(),
        node_id,
        tid
    );
    let mut vfs = state.0.lock().map_err(|e| e.to_string())?;
    let tab_map = vfs.entry(tid.clone()).or_insert_with(HashMap::new);
    tab_map.insert(path.clone(), content);

    if let Some(nid) = node_id {
        let mut tracker = node_file_tracker.0.lock().map_err(|e| e.to_string())?;
        let tab_tracker = tracker.entry(tid.clone()).or_insert_with(HashMap::new);
        let entry = tab_tracker.entry(nid.clone()).or_insert_with(Vec::new);
        if !entry.contains(&path) {
            entry.push(path.clone());
        }
        println!("Rust [write_file_vfs] tracked file for node: {} under tab: {}", nid, tid);
    }

    Ok(())
}

#[tauri::command]
async fn apply_vfs_to_disk(
    state: tauri::State<'_, VfsState>,
    paths: Vec<String>,
    tab_id: Option<String>,
) -> Result<(), String> {
    let tid = get_tab_id(tab_id);
    if paths.is_empty() {
        return Err("No reconciled VFS files were provided to Apply Rusty.".to_string());
    }
    println!("Rust [apply_vfs_to_disk] applying {} reconciled VFS files for tab: {} without clearing them...", paths.len(), tid);
    let files = {
        let vfs = state.0.lock().map_err(|e| e.to_string())?;
        let tab_map = vfs
            .get(&tid)
            .ok_or_else(|| "The canvas VFS has no pending contents.".to_string())?;
        let mut files = Vec::with_capacity(paths.len());
        for path in paths {
            let content = tab_map
                .get(&path)
                .ok_or_else(|| format!("Reconciled VFS file is missing: {}", path))?;
            files.push((path, content.clone()));
        }
        files
    };
    for (path_str, content) in files {
        println!("Rust [apply_vfs_to_disk] applying file: {}", path_str);
        let path = PathBuf::from(&path_str);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
    }
    println!("Rust [apply_vfs_to_disk] apply complete; VFS contents remain available.");
    Ok(())
}

#[tauri::command]
async fn set_current_executing_node(
    state: tauri::State<'_, CurrentExecutingNode>,
    node_id: Option<String>,
) -> Result<(), String> {
    println!("Rust [set_current_executing_node] node_id: {:?}", node_id);
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    *current = node_id;
    Ok(())
}

#[tauri::command]
async fn remove_file_vfs(
    state: tauri::State<'_, VfsState>,
    path: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let tid = get_tab_id(tab_id);
    println!("Rust [remove_file_vfs] removing path: {} from VFS for tab: {}", path, tid);
    let mut vfs = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(tab_map) = vfs.get_mut(&tid) {
        tab_map.remove(&path);
        println!("Rust [remove_file_vfs] removed from VFS: {}", path);
    }
    Ok(())
}

#[tauri::command]
async fn delete_node_vfs_file(
    vfs_state: tauri::State<'_, VfsState>,
    tracker_state: tauri::State<'_, NodeFileTracker>,
    node_id: String,
    path: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let tid = get_tab_id(tab_id);
    println!(
        "Rust [delete_node_vfs_file] deleting path: {} for node: {} under tab: {}",
        path, node_id, tid
    );

    let mut tracker = tracker_state.0.lock().map_err(|e| e.to_string())?;
    let Some(tab_tracker) = tracker.get_mut(&tid) else {
        return Ok(());
    };

    if let Some(files) = tab_tracker.get_mut(&node_id) {
        files.retain(|file_path| file_path != &path);
        if files.is_empty() {
            tab_tracker.remove(&node_id);
        }
    }

    // Contents are shared by path within a tab, so only remove the final reference.
    let is_still_tracked = tab_tracker
        .values()
        .any(|files| files.iter().any(|file_path| file_path == &path));
    drop(tracker);

    if !is_still_tracked {
        let mut vfs = vfs_state.0.lock().map_err(|e| e.to_string())?;
        if let Some(tab_map) = vfs.get_mut(&tid) {
            tab_map.remove(&path);
        }
    }

    Ok(())
}

#[tauri::command]
async fn delete_node_vfs_files(
    vfs_state: tauri::State<'_, VfsState>,
    tracker_state: tauri::State<'_, NodeFileTracker>,
    node_id: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let tid = get_tab_id(tab_id);
    println!("Rust [delete_node_vfs_files] deleting all VFS files for node: {} under tab: {}", node_id, tid);
    let mut tracker = tracker_state.0.lock().map_err(|e| e.to_string())?;
    let unreferenced_files = if let Some(tab_tracker) = tracker.get_mut(&tid) {
        if let Some(files) = tab_tracker.remove(&node_id) {
            println!("Rust [delete_node_vfs_files] found {} files to delete: {:?}", files.len(), files);
            files
                .into_iter()
                .filter(|file_path| !tab_tracker.values().any(|tracked| tracked.contains(file_path)))
                .collect()
        } else {
            println!("Rust [delete_node_vfs_files] no files tracked for node: {} under tab: {}", node_id, tid);
            Vec::new()
        }
    } else {
        println!("Rust [delete_node_vfs_files] no files tracked for tab: {}", tid);
        Vec::new()
    };
    drop(tracker);

    if !unreferenced_files.is_empty() {
        let mut vfs = vfs_state.0.lock().map_err(|e| e.to_string())?;
        if let Some(tab_map) = vfs.get_mut(&tid) {
            for file_path in unreferenced_files {
                tab_map.remove(&file_path);
                println!("Rust [delete_node_vfs_files] removed final VFS reference: {}", file_path);
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct NodeFilesResponse {
    node_id: String,
    files: Vec<String>,
}

#[tauri::command]
async fn get_all_node_vfs_files(
    tracker_state: tauri::State<'_, NodeFileTracker>,
    tab_id: Option<String>,
) -> Result<Vec<NodeFilesResponse>, String> {
    let tid = get_tab_id(tab_id);
    println!("Rust [get_all_node_vfs_files] fetching tracked files for tab: {}", tid);
    let tracker = tracker_state.0.lock().map_err(|e| e.to_string())?;
    let result: Vec<NodeFilesResponse> = if let Some(tab_tracker) = tracker.get(&tid) {
        tab_tracker
            .iter()
            .map(|(node_id, files)| NodeFilesResponse {
                node_id: node_id.clone(),
                files: files.clone(),
            })
            .collect()
    } else {
        Vec::new()
    };
    println!("Rust [get_all_node_vfs_files] found {} nodes with tracked files for tab: {}", result.len(), tid);
    Ok(result)
}

#[tauri::command]
async fn export_vfs_contents(
    state: tauri::State<'_, VfsState>,
    tab_id: Option<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let tid = get_tab_id(tab_id);
    println!("Rust [export_vfs_contents] exporting VFS files for tab: {}", tid);
    let vfs = state.0.lock().map_err(|e| e.to_string())?;
    let mut result = std::collections::HashMap::new();
    if let Some(tab_map) = vfs.get(&tid) {
        for (k, v) in tab_map {
            result.insert(k.clone(), v.clone());
        }
    }
    println!("Rust [export_vfs_contents] exported {} files for tab: {}", result.len(), tid);
    Ok(result)
}

#[tauri::command]
async fn import_vfs_contents(
    state: tauri::State<'_, VfsState>,
    tab_id: Option<String>,
    files: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let tid = get_tab_id(tab_id);
    println!("Rust [import_vfs_contents] importing {} files into VFS for tab: {}", files.len(), tid);
    let mut vfs = state.0.lock().map_err(|e| e.to_string())?;
    let tab_map = vfs.entry(tid.clone()).or_insert_with(HashMap::new);
    for (path, content) in files {
        tab_map.insert(path, content);
    }
    println!("Rust [import_vfs_contents] import complete for tab: {}", tid);
    Ok(())
}

#[tauri::command]
async fn export_vfs_tracker(
    tracker_state: tauri::State<'_, NodeFileTracker>,
    tab_id: Option<String>,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let tid = get_tab_id(tab_id);
    println!("Rust [export_vfs_tracker] exporting node file tracking for tab: {}", tid);
    let tracker = tracker_state.0.lock().map_err(|e| e.to_string())?;
    let mut result = std::collections::HashMap::new();
    if let Some(tab_tracker) = tracker.get(&tid) {
        for (node_id, files) in tab_tracker {
            result.insert(node_id.clone(), files.clone());
        }
    }
    println!("Rust [export_vfs_tracker] exported tracking for {} nodes in tab: {}", result.len(), tid);
    Ok(result)
}

#[tauri::command]
async fn import_vfs_tracker(
    tracker_state: tauri::State<'_, NodeFileTracker>,
    tracker: std::collections::HashMap<String, Vec<String>>,
    tab_id: Option<String>,
) -> Result<(), String> {
    let tid = get_tab_id(tab_id);
    println!("Rust [import_vfs_tracker] importing tracking for {} nodes in tab: {}", tracker.len(), tid);
    let mut state = tracker_state.0.lock().map_err(|e| e.to_string())?;
    let tab_tracker = state.entry(tid.clone()).or_insert_with(HashMap::new);
    for (node_id, files) in tracker {
        tab_tracker.insert(node_id, files);
    }
    println!("Rust [import_vfs_tracker] import complete for tab: {}", tid);
    Ok(())
}

#[tauri::command]
async fn get_directory_structure(root_dir: String) -> Result<Vec<FileEntry>, String> {
    println!(
        "Rust [get_directory_structure] reading structure for: {}",
        root_dir
    );
    let root_path = Path::new(&root_dir);
    if !root_path.exists() {
        println!("Rust [get_directory_structure] error: path does not exist");
        return Err("Directory does not exist".into());
    }
    read_dir_recursive(root_path)
}

#[tauri::command]
async fn read_file_disk(path: String) -> Result<String, String> {
    println!(
        "Rust [read_file_disk] reading directly from physical disk: {}",
        path
    );
    let path_buf = PathBuf::from(&path);
    if path_buf.exists() {
        std::fs::read_to_string(&path_buf).map_err(|e| e.to_string())
    } else {
        Err(format!("File not found on physical disk: {}", path))
    }
}

#[tauri::command]
async fn write_file_disk(
    state: tauri::State<'_, VfsState>,
    path: String,
    content: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    println!("Rust [write_file_disk] writing path directly to disk: {}", path);
    let path_buf = PathBuf::from(&path);
    if let Some(parent) = path_buf.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path_buf, content).map_err(|e| e.to_string())?;

    // Evict this path from VFS memory cache
    let mut vfs = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(tid) = tab_id {
        if let Some(tab_map) = vfs.get_mut(&tid) {
            tab_map.remove(&path);
        }
    } else {
        for tab_map in vfs.values_mut() {
            tab_map.remove(&path);
        }
    }
    Ok(())
}

fn read_dir_recursive(path: &Path) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(path).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        if entry_path.is_dir() {
            if name == "node_modules"
                || name == ".git"
                || name == "target"
                || name == "dist"
                || name == ".vscode"
                || name == ".gemini"
            {
                continue;
            }
            let children = read_dir_recursive(&entry_path)?;
            entries.push(FileEntry {
                name,
                path: entry_path.to_string_lossy().into_owned(),
                is_dir: true,
                children: Some(children),
            });
        } else {
            entries.push(FileEntry {
                name,
                path: entry_path.to_string_lossy().into_owned(),
                is_dir: false,
                children: None,
            });
        }
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(entries)
}

#[tauri::command]
async fn create_file(path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if path_buf.exists() {
        return Err("File already exists".into());
    }
    if let Some(parent) = path_buf.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path_buf, "").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn create_directory(path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if path_buf.exists() {
        return Err("Directory already exists".into());
    }
    std::fs::create_dir_all(&path_buf).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn save_chat_history(
    root_dir: String,
    chat_id: String,
    content: String,
) -> Result<String, String> {
    println!(
        "Rust [save_chat_history] saving chat {} to {}",
        chat_id, root_dir
    );
    let chats_dir = PathBuf::from(&root_dir).join(".rusty").join("chats");
    std::fs::create_dir_all(&chats_dir).map_err(|e| e.to_string())?;

    // One file per chat, identified by chat_id. Overwrites so all requests/replies
    // in a conversation accumulate in the same file.
    let file_name = format!("{}.json", chat_id);
    let file_path = chats_dir.join(&file_name);

    std::fs::write(&file_path, &content).map_err(|e| e.to_string())?;
    println!("Rust [save_chat_history] saved to {:?}", file_path);

    Ok(file_path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn delete_file_or_dir(path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err("Path does not exist".into());
    }
    if path_buf.is_dir() {
        std::fs::remove_dir_all(&path_buf).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&path_buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn log_to_terminal(level: String, message: String) {
    println!("JS [{}] {}", level, message);
}

#[tauri::command]
async fn create_terminal_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<(), String> {
    println!("Rust [create_terminal_session] session_id: {}, cols: {}, rows: {}, cwd: {:?}", session_id, cols, rows, cwd);

    {
        let map = state.0.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&session_id) {
            return Ok(());
        }
    }
    
    let (shell, shell_args) = terminal_shell_command();

    let pty_system = NativePtySystem::default();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;
    
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(shell_args);
    // portable-pty assigns this PTY as the controlling TTY by default, so the
    // login shell is also interactive (the same model used by native terminals).
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Rusty");
    cmd.env("SHELL", &shell);
    if let Some(ref cwd_dir) = cwd {
        if !cwd_dir.is_empty() {
            cmd.cwd(cwd_dir);
        }
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let master = pair.master;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        map.insert(session_id.clone(), TerminalSession {
            master,
            writer,
            child,
        });
    }

    let output_event = format!("terminal-output-{}", session_id);
    let exit_event = format!("terminal-exit-{}", session_id);
    let (tx, rx) = mpsc::channel::<Vec<u8>>();

    let app_clone = app.clone();
    let output_event_clone = output_event.clone();
    let exit_event_clone = exit_event.clone();
    std::thread::spawn(move || {
        while let Ok(mut chunk) = rx.recv() {
            while let Ok(next) = rx.recv_timeout(Duration::from_millis(8)) {
                chunk.extend_from_slice(&next);
                if chunk.len() >= 64 * 1024 {
                    break;
                }
            }

            // Keep PTY output byte-for-byte intact. xterm accepts Uint8Array,
            // while converting with from_utf8_lossy corrupts binary/invalid UTF-8
            // sequences emitted by real terminal programs.
            let _ = app_clone.emit(&output_event_clone, chunk);
        }

        let _ = app_clone.emit(&exit_event_clone, ());
    });

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn write_to_terminal(
    state: tauri::State<'_, TerminalState>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let session = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("Terminal session '{session_id}' does not exist"))?;
    session.writer.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn resize_terminal(
    state: tauri::State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let session = map
        .get(&session_id)
        .ok_or_else(|| format!("Terminal session '{session_id}' does not exist"))?;
    session.master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn close_terminal_session(
    state: tauri::State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = map.remove(&session_id) {
        let _ = session.child.kill();
    }
    Ok(())
}


#[tauri::command]
async fn move_file_or_dir(src: String, dest: String) -> Result<(), String> {
    let src_path = PathBuf::from(&src);
    let dest_path = PathBuf::from(&dest);
    if !src_path.exists() {
        return Err("Source path does not exist".into());
    }
    if dest_path.exists() {
        return Err("Destination path already exists".into());
    }
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchMatch {
    path: String,
    name: String,
    line: usize,
    content: String,
    is_content_match: bool,
}

struct ScoredSearchMatch {
    match_val: SearchMatch,
    score: i64,
}

fn read_and_check_text_file(path: &Path) -> Option<String> {
    if let Ok(metadata) = std::fs::metadata(path) {
        // Skip files larger than 2MB
        if metadata.len() > 2 * 1024 * 1024 {
            return None;
        }
    }

    let mut file = std::fs::File::open(path).ok()?;
    use std::io::{Read, Seek};
    let mut buffer = [0; 1024];
    let bytes_read = file.read(&mut buffer).ok()?;
    if buffer[..bytes_read].contains(&0) {
        return None; // Binary file detection
    }

    file.seek(std::io::SeekFrom::Start(0)).ok()?;
    let mut content = String::new();
    file.read_to_string(&mut content).ok()?;
    Some(content)
}

#[tauri::command]
async fn search_project(
    root_dir: String,
    query: String,
    match_case: bool,
    whole_word: bool,
    is_regex: bool,
) -> Result<Vec<SearchMatch>, String> {
    println!(
        "Rust [search_project] querying: '{}' (case: {}, word: {}, regex: {}) under: {}",
        query, match_case, whole_word, is_regex, root_dir
    );

    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let root_path = Path::new(&root_dir);
    if !root_path.exists() {
        return Err("Directory does not exist".into());
    }

    let results = Arc::new(Mutex::new(Vec::new()));
    let query_lower = query.to_lowercase();
    let query_arc = Arc::new(query);
    let query_lower_arc = Arc::new(query_lower);
    let root_path_buf = root_path.to_path_buf();
    let root_path_arc = Arc::new(root_path_buf);

    let regex_matcher = if is_regex {
        let re = regex::RegexBuilder::new(&query_arc)
            .case_insensitive(!match_case)
            .build()
            .map_err(|e| format!("Invalid regex: {}", e))?;
        Some(Arc::new(re))
    } else {
        None
    };

    use fuzzy_matcher::FuzzyMatcher;
    use ignore::WalkBuilder;

    let walker = WalkBuilder::new(&*root_path_arc)
        .hidden(true) // Skip hidden files and directories (like .git) by default
        .build_parallel();

    walker.run(|| {
        let results = results.clone();
        let query = query_arc.clone();
        let query_lower = query_lower_arc.clone();
        let root_path = root_path_arc.clone();
        let regex_matcher = regex_matcher.clone();
        let matcher = fuzzy_matcher::skim::SkimMatcherV2::default();

        Box::new(move |entry_result| {
            let entry = match entry_result {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };

            let path = entry.path();

            // Guard against massive build/dependency directories if not gitignored
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                if let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) {
                    if dir_name == "node_modules"
                        || dir_name == ".git"
                        || dir_name == "target"
                        || dir_name == "dist"
                        || dir_name == ".vscode"
                        || dir_name == ".gemini"
                    {
                        return ignore::WalkState::Skip;
                    }
                }
            }

            if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                let rel_path = path.strip_prefix(&*root_path)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .into_owned();

                // 1. Fuzzy match filename
                let filename_score = matcher.fuzzy_match(&rel_path, &*query).unwrap_or(0);
                if filename_score > 0 {
                    let mut lock = results.lock().unwrap();
                    lock.push(ScoredSearchMatch {
                        match_val: SearchMatch {
                            path: path.to_string_lossy().into_owned(),
                            name: name.clone(),
                            line: 0,
                            content: String::new(),
                            is_content_match: false,
                        },
                        score: filename_score,
                    });
                }

                // 2. Scan file content
                if let Some(content) = read_and_check_text_file(path) {
                    let mut line_num = 1;
                    for raw_line in content.lines() {
                        let is_match = if let Some(ref re) = regex_matcher {
                            re.is_match(raw_line)
                        } else if match_case {
                            if whole_word {
                                raw_line.split(|c: char| !c.is_alphanumeric() && c != '_')
                                    .any(|w| w == query.as_str())
                            } else {
                                raw_line.contains(query.as_str())
                            }
                        } else {
                            if whole_word {
                                raw_line.split(|c: char| !c.is_alphanumeric() && c != '_')
                                    .any(|w| w.to_lowercase() == query_lower.as_str())
                            } else {
                                raw_line.to_lowercase().contains(query_lower.as_str())
                            }
                        };

                        if is_match {
                            let mut lock = results.lock().unwrap();
                            lock.push(ScoredSearchMatch {
                                match_val: SearchMatch {
                                    path: path.to_string_lossy().into_owned(),
                                    name: name.clone(),
                                    line: line_num,
                                    content: raw_line.trim().to_string(),
                                    is_content_match: true,
                                },
                                score: 0,
                            });
                        }
                        line_num += 1;
                    }
                }
            }

            ignore::WalkState::Continue
        })
    });

    // Unwrap results and sort them
    let mut scored_results = Arc::try_unwrap(results)
        .map_err(|_| "Failed to resolve search results threads".to_string())?
        .into_inner()
        .map_err(|e| e.to_string())?;

    scored_results.sort_by(|a, b| {
        match (a.match_val.is_content_match, b.match_val.is_content_match) {
            (false, false) => b.score.cmp(&a.score), // Sort filename matches by fuzzy score desc
            (false, true) => std::cmp::Ordering::Less, // Filenames always first
            (true, false) => std::cmp::Ordering::Greater,
            (true, true) => {
                // Sort content matches alphabetically by path, then line number
                a.match_val.path.cmp(&b.match_val.path)
                    .then_with(|| a.match_val.line.cmp(&b.match_val.line))
            }
        }
    });

    let mut final_results: Vec<SearchMatch> = scored_results
        .into_iter()
        .map(|r| r.match_val)
        .collect();

    final_results.truncate(150);
    Ok(final_results)
}

/// Minimal UTC "YYYY-MM-DDTHH:MM:SSZ" formatter with no external crate dependency,
/// good enough for correlating sidecar log lines against other timestamps.
fn chrono_now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, secs_of_day) = (secs / 86_400, secs % 86_400);
    let (hour, minute, second) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);

    // Howard Hinnant's civil_from_days algorithm.
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

/// Mirrors src/config/sidecar.ts's `SIDECAR_PORT = import.meta.env.DEV ? 4001
/// : 4000` -- deliberately different between dev and release, so a `tauri
/// dev` instance doesn't fight an already-installed release copy for the
/// same port. Previously this was an unconditional 4000 with no `PORT` env
/// passed to the spawned process below, so in dev this auto-spawned sidecar
/// bound 4000 while the dev frontend was only ever listening on 4001 -- the
/// two could never reach each other, and `npm run tauri dev` alone (without
/// also following BUILD.md's separate manual-sidecar-for-hot-reload
/// instructions) had no working sidecar at all (REFACTOR_PLAN.md PR 3a).
///
/// A stale process left over from a prior launch on either port (a crashed
/// debug build, an orphaned copy from before a rebrand, another checkout of
/// this repo) can still squat on it forever; `reclaim_sidecar_port` below
/// guards against that for whichever port this build mode actually uses.
const SIDECAR_PORT: u16 = if cfg!(debug_assertions) { 4001 } else { 4000 };

#[cfg(test)]
mod sidecar_port_tests {
    use super::SIDECAR_PORT;

    #[test]
    fn dev_build_uses_the_port_the_dev_frontend_expects() {
        // `cargo test` always builds in the debug profile, so this pins the
        // dev-mode branch of the cfg!(debug_assertions) ternary above --
        // matching src/config/sidecar.ts's `import.meta.env.DEV ? 4001 :
        // 4000` (REFACTOR_PLAN.md PR 3a). The release branch (4000) needs no
        // new test: it is exactly what this constant always was before the
        // dev/release split existed.
        assert_eq!(SIDECAR_PORT, 4001);
    }
}

/// Best-effort reclaim of `SIDECAR_PORT` before spawning. Only kills processes
/// whose command line matches our own sidecar's resource layout - never an
/// unrelated process that happens to be using the same port.
fn reclaim_sidecar_port(port: u16) {
    if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
        return;
    }

    #[cfg(unix)]
    {
        let find_pids = || -> Vec<i32> {
            std::process::Command::new("lsof")
                .args(["-nP", "-ti", &format!("tcp:{port}")])
                .output()
                .map(|output| {
                    String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .filter_map(|line| line.trim().parse().ok())
                        .collect()
                })
                .unwrap_or_default()
        };

        for pid in find_pids() {
            let cmdline = std::process::Command::new("ps")
                .args(["-o", "command=", "-p", &pid.to_string()])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();

            if !cmdline.contains("resources/sidecar/server.js") {
                eprintln!(
                    "[sidecar] port {} is held by pid {} ({}), which doesn't look like a sidecar process; leaving it alone",
                    port, pid, cmdline
                );
                continue;
            }

            eprintln!("[sidecar] reclaiming port {} from stale sidecar pid {} ({})", port, pid, cmdline);
            let _ = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).status();
        }

        std::thread::sleep(std::time::Duration::from_millis(500));
        for pid in find_pids() {
            eprintln!("[sidecar] pid {} ignored SIGTERM; sending SIGKILL", pid);
            let _ = std::process::Command::new("kill").args(["-KILL", &pid.to_string()]).status();
        }
    }

    #[cfg(not(unix))]
    {
        eprintln!(
            "[sidecar] port {} is already in use and automatic reclaim is only implemented on Unix; \
             stop whatever is using it and relaunch.",
            port
        );
    }
}

fn spawn_sidecar(app: &tauri::App) {
    reclaim_sidecar_port(SIDECAR_PORT);

    // Resolve the bundled server.js from the app resources.
    // In dev, resources are copied to target/debug/resources/; in release they're
    // bundled into the app bundle. resource_dir() handles both cases.
    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[sidecar] failed to resolve resource dir: {}", e);
            return;
        }
    };
    let server_js = resource_dir.join("resources").join("sidecar").join("server.js");

    if !server_js.exists() {
        eprintln!(
            "[sidecar] server.js not found at {}. \
             Run `npm run build:sidecar` to generate it.",
            server_js.display()
        );
        return;
    }

    // Resolve the bundled Node binary declared via `externalBin` in tauri.conf.json.
    let sidecar_cmd = match app.shell().sidecar("node") {
        Ok(cmd) => cmd,
        Err(e) => {
            eprintln!("[sidecar] failed to resolve bundled node binary: {}", e);
            return;
        }
    };

    // Persist sidecar stdout/stderr to a log file. println!/eprintln! only reach
    // a visible console when the app is launched from a terminal - for a normal
    // Finder/Dock launch they vanish, leaving no way to diagnose a sidecar crash.
    let log_file = app.path().app_log_dir().ok().and_then(|dir| {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("[sidecar] failed to create log dir {}: {}", dir.display(), e);
            return None;
        }
        let log_path = dir.join("sidecar.log");
        match std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            Ok(f) => {
                println!("[sidecar] logging to {}", log_path.display());
                Some(Arc::new(Mutex::new(f)))
            }
            Err(e) => {
                eprintln!("[sidecar] failed to open log file {}: {}", log_path.display(), e);
                None
            }
        }
    });

    match sidecar_cmd
        // agent-sidecar/src/server.ts reads `PORT` (default 4000) -- pass the
        // dev/release-aware SIDECAR_PORT explicitly so the spawned process
        // binds the port this build's frontend actually expects instead of
        // always defaulting to 4000.
        .env("PORT", SIDECAR_PORT.to_string())
        .args([server_js.to_string_lossy().to_string()])
        .spawn()
    {
        Ok((mut rx, child)) => {
            println!(
                "[sidecar] spawned node sidecar (server.js at {})",
                server_js.display()
            );

            // Store the child handle so we can kill it on app exit.
            if let Some(state) = app.try_state::<SidecarState>() {
                *state.0.lock().unwrap() = Some(child);
            }

            // Forward sidecar stdout/stderr to the host console and to disk.
            tauri::async_runtime::spawn(async move {
                let write_log = |line: &str| {
                    if let Some(f) = &log_file {
                        let timestamp = chrono_now_iso8601();
                        if let Ok(mut f) = f.lock() {
                            let _ = writeln!(f, "[{}] {}", timestamp, line);
                        }
                    }
                };
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            let line = line.trim();
                            println!("[sidecar] {}", line);
                            write_log(line);
                        }
                        CommandEvent::Stderr(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            let line = line.trim();
                            eprintln!("[sidecar] {}", line);
                            write_log(line);
                        }
                        CommandEvent::Terminated(status) => {
                            let line = format!("process exited: {:?}", status);
                            println!("[sidecar] {}", line);
                            write_log(&line);
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => {
            eprintln!(
                "[sidecar] failed to spawn: {}. \
                 If port 4000 is already in use, stop any manually started sidecar first.",
                e
            );
        }
    }
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Keep visibility outside the persisted state. The main window starts
    // hidden, restores its geometry exactly once in setup, and is shown only
    // after restoration. This avoids the default-size window flashing before
    // the restored window and prevents a closed/hidden state from persisting.
    let window_state_flags = StateFlags::SIZE
        | StateFlags::POSITION
        | StateFlags::MAXIMIZED
        | StateFlags::FULLSCREEN;

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .skip_initial_state("main")
                .build(),
        )
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Finished {
                let window = webview.window();
                if !window.is_visible().unwrap_or_default() {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .manage(VfsState(Arc::new(Mutex::new(HashMap::new()))))
        .manage(NodeFileTracker(Arc::new(Mutex::new(HashMap::new()))))
        .manage(CurrentExecutingNode(Arc::new(Mutex::new(None))))
        .manage(SidecarState(Arc::new(Mutex::new(None))))
        .manage(TerminalState(Arc::new(Mutex::new(HashMap::new()))))
        .setup(move |app| {
            let main_window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window was not created".to_string())?;

            main_window.restore_state(window_state_flags)?;

            // Spawn the bundled Node sidecar on startup (both dev and release).
            // The Node binary is bundled via `externalBin` and server.js via `resources`,
            // so the user never needs to install Node or run the sidecar manually.
            spawn_sidecar(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log_to_terminal,
            create_terminal_session,
            write_to_terminal,
            resize_terminal,
            close_terminal_session,
            read_file_vfs,
            write_file_vfs,
            remove_file_vfs,
            delete_node_vfs_file,
            apply_vfs_to_disk,
            set_current_executing_node,
            delete_node_vfs_files,
            get_all_node_vfs_files,
            export_vfs_contents,
            import_vfs_contents,
            export_vfs_tracker,
            import_vfs_tracker,
            get_directory_structure,
            read_file_disk,
            write_file_disk,
            create_file,
            create_directory,
            save_chat_history,
            delete_file_or_dir,
            move_file_or_dir,
            search_project,
            git::git_status,
            git::git_init,
            git::git_stage_file,
            git::git_unstage_file,
            git::git_add_to_gitignore,
            git::git_discard_changes,
            git::git_commit,
            git::git_get_head_content,
            git::git_get_branches,
            git::git_get_all_branches,
            git::git_fetch,
            git::git_checkout_branch,
            git::git_smart_checkout_branch,
            git::git_create_branch,
            git::git_smart_create_branch,
            git::git_delete_branch,
            git::git_delete_remote_branch,
            git::git_merge_branch,
            git::git_rebase_branch,
            git::git_abort_pending,
            git::git_undo_last_rename,
            git::git_get_index_content,
            git::git_pull,
            git::git_push,
            git::git_get_commit_history,
            git::git_get_commit_files,
            git::git_get_file_content_at_rev,
            git::git_discard_all_changes,
            git::git_revert_commit,
            git::git_reset_to_commit,
            git::git_blame,
            git::git_get_file_commit_history,
            git::git_scan_subprojects
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Kill the sidecar process on app exit.
            if let Some(state) = app_handle.try_state::<SidecarState>() {
                if let Some(child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
