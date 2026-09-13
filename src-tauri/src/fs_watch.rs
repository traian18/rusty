use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Emitter;

/// Directory names never worth an explorer refresh over -- the same list
/// `read_dir_recursive` (lib.rs) already skips when building the tree, so a
/// change under one of these can never change what the tree would show
/// anyway. Filtering here (rather than only in read_dir_recursive) is what
/// keeps something like a `.git` internal write or a `node_modules` install
/// from flooding the frontend with refresh events it would just throw away.
const IGNORED_DIR_NAMES: [&str; 6] = ["node_modules", ".git", "target", "dist", ".vscode", ".gemini"];

fn path_is_ignored(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| IGNORED_DIR_NAMES.contains(&name))
    })
}

struct WatchedWorkspace {
    // Never read again after being stored -- the watcher must simply
    // outlive this struct (dropping a notify::Watcher stops it), so this
    // field's only job is keeping it alive. `root` below is what
    // watch_workspace actually compares against on the next call.
    _watcher: RecommendedWatcher,
    root: PathBuf,
}

/// Tauri-managed state holding at most one live workspace watcher. Only one
/// workspace is ever open at a time (REFACTOR_PLAN.md's single-root model),
/// so replacing it on every `watch_workspace` call for a new root -- rather
/// than keeping a collection -- is deliberate, not a limitation.
#[derive(Default)]
pub struct WorkspaceWatcherState(Mutex<Option<WatchedWorkspace>>);

/// (Re)starts the workspace file-system watcher for `root_dir`, replacing
/// any previously watched root. A no-op if already watching this exact
/// root (called every time the frontend's rootPath subscription fires,
/// which includes re-renders that don't actually change the path).
///
/// Emits a bare `"workspace-fs-changed"` event (no payload -- the frontend
/// already owns a debounced, coalescing refresh in FileTreePresenter's
/// `scheduleTreeRefresh`, so there is nothing for a payload to usefully
/// carry) whenever a change lands outside every ignored directory.
#[tauri::command]
pub async fn watch_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceWatcherState>,
    root_dir: String,
) -> Result<(), String> {
    let root = PathBuf::from(&root_dir);
    if !root.exists() {
        return Err(format!("Directory does not exist: {}", root_dir));
    }

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.root == root {
            return Ok(());
        }
    }

    let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| match res {
        Ok(event) => {
            if event.paths.iter().any(|p| !path_is_ignored(p)) {
                let _ = app.emit("workspace-fs-changed", ());
            }
        }
        Err(err) => {
            eprintln!("Rust [watch_workspace] watch error: {}", err);
        }
    })
    .map_err(|e| e.to_string())?;

    let mut watcher = watcher;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *guard = Some(WatchedWorkspace {
        _watcher: watcher,
        root,
    });
    Ok(())
}

/// Stops watching, if anything is currently watched. Dropping the
/// `RecommendedWatcher` is what actually tears down the OS-level watch.
#[tauri::command]
pub async fn unwatch_workspace(state: tauri::State<'_, WorkspaceWatcherState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::path_is_ignored;
    use std::path::Path;

    #[test]
    fn a_path_under_node_modules_is_ignored() {
        assert!(path_is_ignored(Path::new("/repo/node_modules/pkg/index.js")));
    }

    #[test]
    fn a_path_under_dot_git_is_ignored() {
        assert!(path_is_ignored(Path::new("/repo/.git/index")));
    }

    #[test]
    fn a_path_under_target_is_ignored() {
        assert!(path_is_ignored(Path::new("/repo/src-tauri/target/debug/foo")));
    }

    #[test]
    fn an_ordinary_source_file_is_not_ignored() {
        assert!(!path_is_ignored(Path::new("/repo/src/components/Foo.tsx")));
    }

    #[test]
    fn a_file_merely_named_like_an_ignored_dir_is_not_ignored() {
        // "dist" the directory is ignored; "dist.ts" the file is not --
        // path_is_ignored compares whole path components, not substrings.
        assert!(!path_is_ignored(Path::new("/repo/src/dist.ts")));
    }
}
