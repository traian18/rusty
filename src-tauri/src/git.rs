use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Represents the git status of an individual file.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitFileStatus {
    /// The absolute path of the file on disk.
    pub path: String,
    /// The filename (basename).
    pub name: String,
    /// The modification category: "modified", "added", "deleted", or "untracked".
    pub status_type: String,
}

/// Represents the aggregated repository status.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitStatusResult {
    /// Indicates whether the workspace folder is a valid git repository.
    pub is_repo: bool,
    /// The name of the current active branch (or "empty-repo" if no commits yet).
    pub current_branch: String,
    /// Files that are staged for commit in the index.
    pub staged: Vec<GitFileStatus>,
    /// Files that are modified or untracked in the working tree.
    pub unstaged: Vec<GitFileStatus>,
}

/// Details from a Rusty smart branch switch. `stashed` refers to the branch
/// being left; `restored` refers to a previously saved state for the branch
/// that was entered.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SmartBranchSwitchResult {
    pub stashed: bool,
    pub restored: bool,
}

/// Structured error for every git.rs command, replacing the previous bare
/// `Result<T, String>` with enough detail (operation, repository, exit code,
/// raw stderr) for the frontend to branch on, not just display. `message`
/// is the human-readable summary (stderr, or stdout when stderr is empty --
/// generalizing what `git_merge_branch`/`git_rebase_branch` used to do
/// ad hoc only for themselves).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitError {
    pub operation: String,
    pub repository: String,
    pub exit_code: Option<i32>,
    pub stderr: String,
    pub message: String,
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for GitError {}

/// Runs `git <args>` in `repo`, returning `Ok(Output)` only on a zero exit
/// code (spawn failures and non-zero exits both become `GitError`). This is
/// the one place every command in this module routes its git invocations
/// through, replacing ~26 independently duplicated
/// `Command::new("git")...output().map_err(...)` blocks with inconsistent
/// success/failure branching.
fn run_git(repo: &str, operation: &str, args: &[&str]) -> Result<std::process::Output, GitError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| GitError {
            operation: operation.to_string(),
            repository: repo.to_string(),
            exit_code: None,
            stderr: String::new(),
            message: format!("Failed to run git: {e}"),
        })?;

    if output.status.success() {
        Ok(output)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr.clone()
        };
        Err(GitError {
            operation: operation.to_string(),
            repository: repo.to_string(),
            exit_code: output.status.code(),
            stderr,
            message,
        })
    }
}

fn git_command(root_dir: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(root_dir)
        .output()
        .map_err(|e| e.to_string())
}

fn command_error(output: &std::process::Output) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn current_branch_name(root_dir: &str) -> Result<String, String> {
    let output = git_command(root_dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    command_error(&output)?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn working_tree_is_dirty(root_dir: &str) -> Result<bool, String> {
    let output = git_command(root_dir, &["status", "--porcelain", "-u"])?;
    command_error(&output)?;
    Ok(!output.stdout.is_empty())
}

fn rusty_stash_marker(branch: &str) -> String {
    format!("rusty-smart-switch:{}", branch)
}

fn stash_current_branch(root_dir: &str, branch: &str) -> Result<bool, String> {
    if !working_tree_is_dirty(root_dir)? {
        return Ok(false);
    }
    let marker = rusty_stash_marker(branch);
    let output = git_command(root_dir, &["stash", "push", "--include-untracked", "-m", &marker])?;
    command_error(&output)?;
    Ok(true)
}

fn rusty_stash_ref_for_branch(root_dir: &str, branch: &str) -> Result<Option<String>, String> {
    let output = git_command(root_dir, &["stash", "list", "--format=%gd%x09%s"])?;
    command_error(&output)?;
    let marker = rusty_stash_marker(branch);
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some((stash_ref, subject)) = line.split_once('\t') {
            if subject.ends_with(&marker) {
                return Ok(Some(stash_ref.to_string()));
            }
        }
    }
    Ok(None)
}

fn restore_rusty_stash_for_branch(root_dir: &str, branch: &str) -> Result<bool, String> {
    let Some(stash_ref) = rusty_stash_ref_for_branch(root_dir, branch)? else {
        return Ok(false);
    };
    let output = git_command(root_dir, &["stash", "pop", &stash_ref])?;
    if output.status.success() {
        Ok(true)
    } else {
        Err(format!(
            "Switched branches, but Rusty could not restore saved changes for '{}'. Resolve the conflict, then use the preserved stash {}. {}",
            branch,
            stash_ref,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn checkout_branch(root_dir: &str, branch_name: &str) -> Result<(), String> {
    let args: Vec<&str> = if branch_name.starts_with("origin/") {
        let local_name = branch_name.strip_prefix("origin/").unwrap_or(branch_name);
        let local_exists = Command::new("git")
            .args(&["show-ref", "--verify", "--quiet", &format!("refs/heads/{}", local_name)])
            .current_dir(root_dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if local_exists {
            vec!["checkout", local_name]
        } else {
            vec!["checkout", "--track", branch_name]
        }
    } else {
        vec!["checkout", branch_name]
    };
    let output = git_command(root_dir, &args)?;
    command_error(&output)
}

/// Helper function to check if the given directory contains a git work tree.
fn check_is_git_repo(root_dir: &str) -> bool {
    let output = Command::new("git")
        .args(&["rev-parse", "--is-inside-work-tree"])
        .current_dir(root_dir)
        .output();
    
    match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// Fetches the complete git status of the workspace, including current branch name,
/// staged changes, and unstaged/untracked changes.
#[tauri::command]
pub async fn git_status(root_dir: String) -> Result<GitStatusResult, String> {
    let root_path = Path::new(&root_dir);
    if !root_path.exists() {
        return Err("Directory does not exist".into());
    }

    // Return status early if it's not a git repository
    let is_repo = check_is_git_repo(&root_dir);
    if !is_repo {
        return Ok(GitStatusResult {
            is_repo: false,
            current_branch: "".into(),
            staged: Vec::new(),
            unstaged: Vec::new(),
        });
    }

    // 1. Get the current active branch name
    let branch_output = Command::new("git")
        .args(&["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&root_dir)
        .output();
        
    let mut current_branch = String::new();
    if let Ok(out) = branch_output {
        if out.status.success() {
            current_branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
        } else {
            // Check if it's a new repo that hasn't made its first commit yet
            let show_branch = Command::new("git")
                .args(&["branch", "--show-current"])
                .current_dir(&root_dir)
                .output();
            if let Ok(sb_out) = show_branch {
                current_branch = String::from_utf8_lossy(&sb_out.stdout).trim().to_string();
            }
            if current_branch.is_empty() {
                current_branch = "empty-repo".to_string();
            }
        }
    }

    // 2. Query porcelain output to easily parse staged, unstaged, and untracked changes
    let status_output = Command::new("git")
        .args(&["status", "--porcelain", "-u"])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    let output_str = String::from_utf8_lossy(&status_output.stdout);
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for line in output_str.lines() {
        if line.len() < 4 {
            continue;
        }
        
        // Extract status characters X and Y
        // X represents index status, Y represents working tree status
        let x = line.chars().nth(0).unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        let relative_path = &line[3..];
        
        // Clean quotes from files with spaces or non-ascii names
        let clean_path = relative_path.trim_matches('"').to_string();
        
        let file_name = Path::new(&clean_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&clean_path)
            .to_string();

        let abs_path = root_path.join(&clean_path).to_string_lossy().into_owned();

        if x == '?' && y == '?' {
            // "??" indicates an untracked file
            unstaged.push(GitFileStatus {
                path: abs_path,
                name: file_name,
                status_type: "untracked".into(),
            });
        } else {
            // Process staged changes (X represents the index state)
            if x != ' ' {
                let status_type = match x {
                    'M' => "modified",
                    'A' => "added",
                    'D' => "deleted",
                    'R' => "renamed",
                    _ => "modified",
                };
                staged.push(GitFileStatus {
                    path: abs_path.clone(),
                    name: file_name.clone(),
                    status_type: status_type.into(),
                });
            }
            
            // Process unstaged changes (Y represents the working tree state)
            if y != ' ' {
                let status_type = match y {
                    'M' => "modified",
                    'D' => "deleted",
                    'A' => "added",
                    _ => "modified",
                };
                unstaged.push(GitFileStatus {
                    path: abs_path,
                    name: file_name,
                    status_type: status_type.into(),
                });
            }
        }
    }

    Ok(GitStatusResult {
        is_repo: true,
        current_branch,
        staged,
        unstaged,
    })
}

/// Initializes a new Git repository in the specified directory path.
#[tauri::command]
pub async fn git_init(root_dir: String) -> Result<(), GitError> {
    run_git(&root_dir, "git_init", &["init"])?;
    Ok(())
}

/// Stages a file by executing `git add <file>`.
#[tauri::command]
pub async fn git_stage_file(root_dir: String, file_path: String) -> Result<(), String> {
    let root_path = Path::new(&root_dir);
    let full_path = Path::new(&file_path);
    let relative = full_path
        .strip_prefix(root_path)
        .map_err(|_| "File is not in the workspace root".to_string())?
        .to_str()
        .ok_or_else(|| "Invalid file path encoding".to_string())?;

    let output = Command::new("git")
        .args(&["add", relative])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// Unstages a file from the index.
/// Uses `git reset HEAD <file>` if a HEAD ref exists, or `git rm --cached` in an empty repo.
#[tauri::command]
pub async fn git_unstage_file(root_dir: String, file_path: String) -> Result<(), String> {
    let root_path = Path::new(&root_dir);
    let full_path = Path::new(&file_path);
    let relative = full_path
        .strip_prefix(root_path)
        .map_err(|_| "File is not in the workspace root".to_string())?
        .to_str()
        .ok_or_else(|| "Invalid file path encoding".to_string())?;

    // Determine if HEAD commit exists
    let has_head = Command::new("git")
        .args(&["rev-parse", "HEAD"])
        .current_dir(&root_dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let output = if has_head {
        Command::new("git")
            .args(&["reset", "HEAD", relative])
            .current_dir(&root_dir)
            .output()
            .map_err(|e| e.to_string())?
    } else {
        Command::new("git")
            .args(&["rm", "--cached", "-r", "--ignore-unmatch", relative])
            .current_dir(&root_dir)
            .output()
            .map_err(|e| e.to_string())?
    };

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// Adds a file to the repository root `.gitignore`, creating it if needed.
/// The entry is anchored to the repo root (leading `/`) so it only matches
/// this exact path rather than any same-named file elsewhere in the tree.
/// If the file is already tracked, unstages/untracks it too, since adding a
/// pattern to `.gitignore` alone has no effect on files git already tracks.
#[tauri::command]
pub async fn git_add_to_gitignore(root_dir: String, file_path: String) -> Result<(), String> {
    let root_path = Path::new(&root_dir);
    let full_path = Path::new(&file_path);
    let relative = full_path
        .strip_prefix(root_path)
        .map_err(|_| "File is not in the workspace root".to_string())?
        .to_str()
        .ok_or_else(|| "Invalid file path encoding".to_string())?;

    let pattern = format!("/{relative}");
    let gitignore_path = root_path.join(".gitignore");

    let existing = std::fs::read_to_string(&gitignore_path).unwrap_or_default();
    let already_present = existing.lines().any(|line| line.trim() == pattern);

    if !already_present {
        let mut content = existing;
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&pattern);
        content.push('\n');
        std::fs::write(&gitignore_path, content).map_err(|e| e.to_string())?;
    }

    // If the file is already tracked, `.gitignore` won't stop git from seeing
    // its future edits — untrack it (keeping the file on disk) so it fully
    // drops out of status.
    let is_tracked = Command::new("git")
        .args(&["ls-files", "--error-unmatch", relative])
        .current_dir(&root_dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if is_tracked {
        let output = Command::new("git")
            .args(&["rm", "--cached", "-r", "--ignore-unmatch", relative])
            .current_dir(&root_dir)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
    }

    Ok(())
}

/// Discards unstaged modifications.
/// Attempts `git checkout -- <file>`, falling back to `git restore <file>`,
/// and deletes the physical file if it is fully untracked.
#[tauri::command]
pub async fn git_discard_changes(root_dir: String, file_path: String) -> Result<(), String> {
    let root_path = Path::new(&root_dir);
    let full_path = Path::new(&file_path);
    let relative = full_path
        .strip_prefix(root_path)
        .map_err(|_| "File is not in the workspace root".to_string())?
        .to_str()
        .ok_or_else(|| "Invalid file path encoding".to_string())?;

    // Try traditional checkout first
    let output = Command::new("git")
        .args(&["checkout", "--", relative])
        .current_dir(&root_dir)
        .output();
        
    let success = match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    };
    
    if !success {
        // Fallback to git restore
        let restore_output = Command::new("git")
            .args(&["restore", relative])
            .current_dir(&root_dir)
            .output();
            
        let restore_success = match restore_output {
            Ok(out) => out.status.success(),
            Err(_) => false,
        };
        
        if !restore_success {
            // Delete untracked files
            let path_buf = PathBuf::from(&file_path);
            if path_buf.exists() && !Command::new("git")
                .args(&["ls-files", "--error-unmatch", relative])
                .current_dir(&root_dir)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false) 
            {
                std::fs::remove_file(path_buf).map_err(|e| e.to_string())?;
                return Ok(());
            }
            return Err("Failed to discard changes".to_string());
        }
    }

    Ok(())
}

/// Commits all currently staged changes with the provided commit message.
#[tauri::command]
pub async fn git_commit(root_dir: String, message: String) -> Result<(), GitError> {
    run_git(&root_dir, "git_commit", &["commit", "-m", &message])?;
    Ok(())
}

/// Returns the content of the file at the `HEAD` commit.
/// Used to construct side-by-side diff editors against currently edited files.
/// Returns an empty string if the file is untracked or the repository has no commits yet.
#[tauri::command]
pub async fn git_get_head_content(root_dir: String, file_path: String) -> Result<String, String> {
    let root_path = Path::new(&root_dir);
    let full_path = Path::new(&file_path);
    let relative = full_path
        .strip_prefix(root_path)
        .map_err(|_| "File is not in the workspace root".to_string())?
        .to_str()
        .ok_or_else(|| "Invalid file path encoding".to_string())?;

    let output = Command::new("git")
        .args(&["show", &format!("HEAD:{}", relative)])
        .current_dir(&root_dir)
        .output();

    match output {
        Ok(out) => {
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                // Return empty if file is new or repository has no commits
                Ok("".to_string())
            }
        }
        Err(_) => Ok("".to_string()),
    }
}

/// Retrieves a list of all local branches present in the Git repository.
/// Returns their short names (e.g., "main", "feature-xyz").
#[tauri::command]
pub async fn git_get_branches(root_dir: String) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .args(&["branch", "--format=%(refname:short)"])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }

    let out_str = String::from_utf8_lossy(&output.stdout);
    let branches: Vec<String> = out_str
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    
    Ok(branches)
}

/// Grouped branch listing: local branches and remote-tracking branches separately.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BranchesResult {
    /// Local branch short names (e.g., "main", "feature-xyz").
    pub local: Vec<String>,
    /// Remote-tracking branch short names (e.g., "origin/main", "origin/feature-xyz").
    pub remote: Vec<String>,
}

/// Retrieves both local and remote-tracking branches in one call.
#[tauri::command]
pub async fn git_get_all_branches(root_dir: String) -> Result<BranchesResult, String> {
    // Local branches
    let local_output = Command::new("git")
        .args(&["branch", "--format=%(refname:short)"])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if !local_output.status.success() {
        return Err(String::from_utf8_lossy(&local_output.stderr).into_owned());
    }

    let local: Vec<String> = String::from_utf8_lossy(&local_output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    // Remote-tracking branches (refs/remotes/*). Drop symbolic HEAD pointers
    // (e.g. "origin/HEAD -> origin/main") so only real branches remain.
    let remote_output = Command::new("git")
        .args(&["branch", "-r", "--format=%(refname:short)"])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    let remote: Vec<String> = String::from_utf8_lossy(&remote_output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.ends_with("/HEAD") && !l.contains(" -> "))
        .collect();

    Ok(BranchesResult { local, remote })
}

/// Fetches from the configured remote and prunes remote-tracking refs that no
/// longer exist on the remote. Returns Ok(()) silently when no remote is set.
#[tauri::command]
pub async fn git_fetch(root_dir: String) -> Result<(), String> {
    // Skip silently when there is no remote configured.
    let remote_check = Command::new("git")
        .arg("remote")
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if String::from_utf8_lossy(&remote_check.stdout).trim().is_empty() {
        return Ok(());
    }

    let output = Command::new("git")
        .args(&["fetch", "--prune"])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// Performs a checkout to switch the repository's active branch.
///
/// When a remote-tracking ref (e.g. "origin/foo") is passed, a local tracking
/// branch "foo" is checked out (created with `--track` if it doesn't already
/// exist) so that subsequent push/pull operations are wired to origin.
#[tauri::command]
pub async fn git_checkout_branch(root_dir: String, branch_name: String) -> Result<(), String> {
    checkout_branch(&root_dir, &branch_name)
}

/// IntelliJ-style branch switching for a single working directory. Dirty work
/// is saved to a Rusty-tagged stash before checkout and is restored when the
/// user later returns to that same branch. The stash preserves staged state,
/// unstaged changes, and untracked files.
#[tauri::command]
pub async fn git_smart_checkout_branch(root_dir: String, branch_name: String) -> Result<SmartBranchSwitchResult, String> {
    let source_branch = current_branch_name(&root_dir)?;
    if source_branch == branch_name || format!("origin/{}", source_branch) == branch_name {
        return Ok(SmartBranchSwitchResult { stashed: false, restored: false });
    }
    let stashed = stash_current_branch(&root_dir, &source_branch)?;
    checkout_branch(&root_dir, &branch_name)?;
    let destination_branch = current_branch_name(&root_dir)?;
    let restored = restore_rusty_stash_for_branch(&root_dir, &destination_branch)?;
    Ok(SmartBranchSwitchResult { stashed, restored })
}

/// Creates a new branch and optionally checks it out.
#[tauri::command]
pub async fn git_create_branch(root_dir: String, branch_name: String, checkout: bool) -> Result<(), String> {
    let args = if checkout {
        vec!["checkout", "-b", &branch_name]
    } else {
        vec!["branch", &branch_name]
    };
    let output = Command::new("git")
        .args(&args)
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// Creates a branch and, when requested, uses the same safe stash workflow as
/// smart checkout so the new branch starts clean and the source work remains
/// associated with its original branch.
#[tauri::command]
pub async fn git_smart_create_branch(root_dir: String, branch_name: String, checkout: bool) -> Result<SmartBranchSwitchResult, String> {
    if !checkout {
        git_create_branch(root_dir, branch_name, false).await?;
        return Ok(SmartBranchSwitchResult { stashed: false, restored: false });
    }
    let source_branch = current_branch_name(&root_dir)?;
    let stashed = stash_current_branch(&root_dir, &source_branch)?;
    let output = git_command(&root_dir, &["checkout", "-b", &branch_name])?;
    command_error(&output)?;
    Ok(SmartBranchSwitchResult { stashed, restored: false })
}

/// Deletes a local branch. When `force` is true uses `git branch -D` (delete
/// even if not merged), otherwise `git branch -d` (safe delete, refuses if the
/// branch has unmerged commits).
#[tauri::command]
pub async fn git_delete_branch(root_dir: String, branch_name: String, force: bool) -> Result<(), String> {
    let flag = if force { "-D" } else { "-d" };
    let output = Command::new("git")
        .args(&["branch", flag, &branch_name])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// Deletes a branch from the remote origin via `git push origin --delete`.
/// This is the "pushed deletion" that removes the branch on the remote.
#[tauri::command]
pub async fn git_delete_remote_branch(root_dir: String, branch_name: String) -> Result<(), String> {
    // Accept either "origin/foo" or a bare "foo" — always delete from origin.
    let local_name = branch_name
        .strip_prefix("origin/")
        .unwrap_or(&branch_name);

    let output = Command::new("git")
        .args(&["push", "origin", "--delete", local_name])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// Merges a branch into the current branch.
#[tauri::command]
pub async fn git_merge_branch(root_dir: String, branch_name: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(&["merge", &branch_name])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

/// Rebases the current branch onto the specified branch.
#[tauri::command]
pub async fn git_rebase_branch(root_dir: String, branch_name: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(&["rebase", &branch_name])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

/// Aborts an ongoing rebase or merge.
#[tauri::command]
pub async fn git_abort_pending(root_dir: String, operation: String) -> Result<(), String> {
    let op = match operation.as_str() {
        "rebase" => "rebase",
        _ => "merge",
    };
    let output = Command::new("git")
        .args(&[op, "--abort"])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// Undoes a file move/rename by moving the file back to its original location.
#[tauri::command]
pub async fn git_undo_last_rename(_root_dir: String, original_path: String, new_path: String) -> Result<(), String> {
    if !std::path::Path::new(&new_path).exists() {
        return Err("File at new path no longer exists".into());
    }
    std::fs::rename(&new_path, &original_path).map_err(|e| e.to_string())?;
    Ok(())
}
/// Used to diff against HEAD (for staged files) or current VFS (for unstaged files).
/// Falls back to the HEAD version if not explicitly modified in the index.
#[tauri::command]
pub async fn git_get_index_content(root_dir: String, file_path: String) -> Result<String, String> {
    let root_path = Path::new(&root_dir);
    let full_path = Path::new(&file_path);
    let relative = full_path
        .strip_prefix(root_path)
        .map_err(|_| "File is not in the workspace root".to_string())?
        .to_str()
        .ok_or_else(|| "Invalid file path encoding".to_string())?;

    let output = Command::new("git")
        .args(&["show", &format!(":{}", relative)])
        .current_dir(&root_dir)
        .output();

    match output {
        Ok(out) => {
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                // Fall back to HEAD content if index fetch fails
                git_get_head_content(root_dir, file_path).await
            }
        }
        Err(_) => git_get_head_content(root_dir, file_path).await,
    }
}

/// Pulls remote commits from the upstream repository into the active branch.
#[tauri::command]
pub async fn git_pull(root_dir: String) -> Result<(), String> {
    let output = Command::new("git")
        .arg("pull")
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// Pushes local committed changes to the remote repository.
/// Automatically sets the upstream origin tracking branch if not already configured.
#[tauri::command]
pub async fn git_push(root_dir: String, branch_name: String) -> Result<(), String> {
    // 1. Try a regular push first
    let output = Command::new("git")
        .arg("push")
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        return Ok(());
    }

    // 2. If it fails, check if it's due to no upstream configuration
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("no upstream branch") || stderr.contains("has no upstream branch") {
        // Run git push --set-upstream origin <branch_name>
        let upstream_output = Command::new("git")
            .args(&["push", "--set-upstream", "origin", &branch_name])
            .current_dir(&root_dir)
            .output()
            .map_err(|e| e.to_string())?;
        
        if upstream_output.status.success() {
            return Ok(());
        } else {
            return Err(String::from_utf8_lossy(&upstream_output.stderr).into_owned());
        }
    }

    Err(stderr.into_owned())
}

/// Represents details of an individual Git commit.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitCommitInfo {
    /// Full SHA-1 commit hash.
    pub hash: String,
    /// 7-character abbreviated commit hash.
    pub short_hash: String,
    /// Parent commit hashes.
    pub parents: Vec<String>,
    /// Commit author name.
    pub author: String,
    /// Relative or absolute commit date.
    pub date: String,
    /// Commit message subject line.
    pub subject: String,
    /// Ref decorations (e.g., tags, branches).
    pub decorations: String,
    /// Flag indicating whether the commit is unpushed to remotes.
    pub is_unpushed: bool,
}

/// Retrieves the last 100 commits from all branches and flags commits that are unpushed.
#[tauri::command]
pub async fn git_get_commit_history(root_dir: String) -> Result<Vec<GitCommitInfo>, String> {
    if !Path::new(&root_dir).exists() {
        return Err("Directory does not exist".into());
    }

    // 1. Find all local commits that are not present in any remote tracking branches (unpushed)
    let unpushed_output = Command::new("git")
        .args(&["log", "--branches", "--not", "--remotes", "--format=%H"])
        .current_dir(&root_dir)
        .output();
    
    let mut unpushed_hashes = std::collections::HashSet::new();
    if let Ok(out) = unpushed_output {
        if out.status.success() {
            let out_str = String::from_utf8_lossy(&out.stdout);
            for line in out_str.lines() {
                let h = line.trim().to_string();
                if !h.is_empty() {
                    unpushed_hashes.insert(h);
                }
            }
        }
    }

    // 2. Fetch the commit logs using a structured format split by '|'
    let log_output = Command::new("git")
        .args(&[
            "log",
            "--format=%H|%P|%an|%cr|%s|%d",
            "--max-count=100",
            "--all",
        ])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if !log_output.status.success() {
        // Return an empty list if there are no commits yet (brand new repo)
        return Ok(Vec::new());
    }

    let log_str = String::from_utf8_lossy(&log_output.stdout);
    let mut history = Vec::new();

    for line in log_str.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 5 {
            continue;
        }

        let hash = parts[0].trim().to_string();
        let short_hash = if hash.len() >= 7 { hash[0..7].to_string() } else { hash.clone() };
        let parents: Vec<String> = parts[1].split_whitespace().map(|s| s.to_string()).collect();
        let author = parts[2].trim().to_string();
        let date = parts[3].trim().to_string();
        let subject = parts[4].trim().to_string();
        let decorations = parts.get(5).cloned().unwrap_or(&"").trim().to_string();

        let is_unpushed = unpushed_hashes.contains(&hash);

        history.push(GitCommitInfo {
            hash,
            short_hash,
            parents,
            author,
            date,
            subject,
            decorations,
            is_unpushed,
        });
    }

    Ok(history)
}

/// Represents status details of a file changed in a commit.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitCommitFileStatus {
    pub path: String,
    pub name: String,
    pub status_type: String, // "added", "modified", "deleted"
}

/// Retrieves the list of files modified, added, or deleted in a specific commit.
#[tauri::command]
pub async fn git_get_commit_files(root_dir: String, commit_hash: String) -> Result<Vec<GitCommitFileStatus>, String> {
    if !Path::new(&root_dir).exists() {
        return Err("Directory does not exist".into());
    }

    // Run git diff-tree --no-commit-id --name-status -r <commit_hash>
    let output = Command::new("git")
        .args(&["diff-tree", "--no-commit-id", "--name-status", "-r", &commit_hash])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }

    let out_str = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();

    for line in out_str.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }

        let status_code = parts[0];
        let relative_path = parts[1];

        let status_type = match status_code.chars().next().unwrap_or('M') {
            'A' => "added",
            'D' => "deleted",
            _ => "modified",
        };

        let abs_path = Path::new(&root_dir).join(relative_path).to_string_lossy().into_owned();
        let file_name = Path::new(relative_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| relative_path.to_string());

        files.push(GitCommitFileStatus {
            path: abs_path,
            name: file_name,
            status_type: status_type.to_string(),
        });
    }

    Ok(files)
}

/// Returns the content of a file at a specific Git revision reference (e.g. "HEAD", a branch name, or a commit hash).
/// Returns an empty string if the file was not tracked/did not exist at that revision, or if the revision is invalid.
#[tauri::command]
pub async fn git_get_file_content_at_rev(root_dir: String, revision: String, file_path: String) -> Result<String, String> {
    let root_path = Path::new(&root_dir);
    let full_path = Path::new(&file_path);
    let relative = full_path
        .strip_prefix(root_path)
        .map_err(|_| "File is not in the workspace root".to_string())?
        .to_str()
        .ok_or_else(|| "Invalid file path encoding".to_string())?;

    let output = Command::new("git")
        .args(&["show", &format!("{}:{}", revision, relative)])
        .current_dir(&root_dir)
        .output();

    match output {
        Ok(out) => {
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                Ok("".to_string())
            }
        }
        Err(_) => Ok("".to_string()),
    }
}

/// Discards all unstaged changes in the repository.
/// Executes `git checkout -- .` and `git clean -df` to remove untracked files.
#[tauri::command]
pub async fn git_discard_all_changes(root_dir: String) -> Result<(), String> {
    // Discard changes to tracked files
    Command::new("git")
        .args(&["checkout", "--", "."])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    // Discard untracked files and directories
    Command::new("git")
        .args(&["clean", "-df"])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Reverts a specific commit by executing `git revert --no-edit <commit_hash>`.
#[tauri::command]
pub async fn git_revert_commit(root_dir: String, commit_hash: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(&["revert", "--no-edit", &commit_hash])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// Resets the current branch to a specific commit by executing `git reset --hard <commit_hash>`.
#[tauri::command]
pub async fn git_reset_to_commit(root_dir: String, commit_hash: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(&["reset", "--hard", &commit_hash])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitBlameLine {
    pub line_number: usize,
    pub commit_hash: String,
    pub author: String,
    pub date: String,
}

/// Runs git blame on a file to fetch the author and date of the last commit for each line.
#[tauri::command]
pub async fn git_blame(root_dir: String, file_path: String) -> Result<Vec<GitBlameLine>, String> {
    if !Path::new(&root_dir).exists() {
        return Err("Directory does not exist".into());
    }

    let relative_path = if file_path.starts_with(&root_dir) {
        let prefix_len = root_dir.len();
        let stripped = &file_path[prefix_len..];
        stripped.trim_start_matches('/').trim_start_matches('\\').to_string()
    } else {
        file_path
    };

    let output = Command::new("git")
        .args(&["blame", "-w", "--date=short", &relative_path])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }

    let out_str = String::from_utf8_lossy(&output.stdout);
    let mut blame_lines = Vec::new();

    for line in out_str.lines() {
        if let Some(open_paren_idx) = line.find('(') {
            let hash = line[..open_paren_idx].trim().to_string();
            if let Some(close_paren_idx) = line[open_paren_idx..].find(')') {
                let actual_close_idx = open_paren_idx + close_paren_idx;
                let inside = &line[open_paren_idx + 1..actual_close_idx];
                
                let tokens: Vec<&str> = inside.split_whitespace().collect();
                if tokens.len() >= 2 {
                    let line_number_str = tokens.last().cloned().unwrap_or("0");
                    let line_number = line_number_str.parse::<usize>().unwrap_or(0);
                    
                    let date = tokens[tokens.len() - 2].to_string();
                    let author = tokens[..tokens.len() - 2].join(" ");
                    
                    blame_lines.push(GitBlameLine {
                        line_number,
                        commit_hash: hash,
                        author,
                        date,
                    });
                }
            }
        }
    }

    Ok(blame_lines)
}

/// Retrieves the last 100 commits affecting a specific file.
#[tauri::command]
pub async fn git_get_file_commit_history(root_dir: String, file_path: String) -> Result<Vec<GitCommitInfo>, String> {
    if !Path::new(&root_dir).exists() {
        return Err("Directory does not exist".into());
    }

    let relative_path = if file_path.starts_with(&root_dir) {
        let prefix_len = root_dir.len();
        let stripped = &file_path[prefix_len..];
        stripped.trim_start_matches('/').trim_start_matches('\\').to_string()
    } else {
        file_path
    };

    let log_output = Command::new("git")
        .args(&[
            "log",
            "--format=%H|%P|%an|%cr|%s|%d",
            "--max-count=100",
            "--follow",
            "--",
            &relative_path,
        ])
        .current_dir(&root_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if !log_output.status.success() {
        return Ok(Vec::new());
    }

    let log_str = String::from_utf8_lossy(&log_output.stdout);
    let mut history = Vec::new();

    for line in log_str.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 5 {
            continue;
        }

        let hash = parts[0].trim().to_string();
        let short_hash = if hash.len() >= 7 { hash[0..7].to_string() } else { hash.clone() };
        let parents: Vec<String> = parts[1].split_whitespace().map(|s| s.to_string()).collect();
        let author = parts[2].trim().to_string();
        let date = parts[3].trim().to_string();
        let subject = parts[4].trim().to_string();
        let decorations = parts.get(5).cloned().unwrap_or(&"").trim().to_string();

        history.push(GitCommitInfo {
            hash,
            short_hash,
            parents,
            author,
            date,
            subject,
            decorations,
            is_unpushed: false,
        });
    }

    Ok(history)
}

/// Scans the workspace directory recursively to find subprojects (directories containing a `.git` sub-folder).
#[tauri::command]
pub async fn git_scan_subprojects(root_dir: String) -> Result<Vec<String>, String> {
    let root_path = Path::new(&root_dir);
    if !root_path.exists() {
        return Err("Directory does not exist".into());
    }
    let mut results = Vec::new();
    // Recursively scan up to depth 3
    scan_git_subdirs(root_path, &mut results, 0);
    Ok(results)
}

fn scan_git_subdirs(dir: &Path, results: &mut Vec<String>, depth: usize) {
    if depth > 3 {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_dir() {
                    let name = entry.file_name();
                    if name == "node_modules"
                        || name == "target"
                        || name == "dist"
                        || name == ".vscode"
                        || name == ".gemini"
                        || name == ".git"
                    {
                        continue;
                    }
                    if path.join(".git").exists() {
                        results.push(path.to_string_lossy().into_owned());
                    }
                    scan_git_subdirs(&path, results, depth + 1);
                }
            }
        }
    }
}

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;
