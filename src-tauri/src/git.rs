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

/// Resolves `file_path` relative to `root_dir` for a git.rs command,
/// returning a `GitError` naming that `operation` on the two failure modes
/// shared by every command that takes a `(root_dir, file_path)` pair. This
/// is the mechanical, non-canonicalizing check that already existed at each
/// call site (a plain `strip_prefix`) -- PR 5a commit 10 replaces it with a
/// canonicalizing containment primitive; this commit only removes the
/// duplication, not the weakness.
fn relative_to_root(root_dir: &str, file_path: &str, operation: &str) -> Result<String, GitError> {
    let not_in_root = || GitError {
        operation: operation.to_string(),
        repository: root_dir.to_string(),
        exit_code: None,
        stderr: String::new(),
        message: "File is not in the workspace root".to_string(),
    };
    let bad_encoding = || GitError {
        operation: operation.to_string(),
        repository: root_dir.to_string(),
        exit_code: None,
        stderr: String::new(),
        message: "Invalid file path encoding".to_string(),
    };
    Path::new(file_path)
        .strip_prefix(Path::new(root_dir))
        .map_err(|_| not_in_root())?
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(bad_encoding)
}

fn current_branch_name(root_dir: &str) -> Result<String, GitError> {
    let output = run_git(root_dir, "git_smart_checkout_branch", &["rev-parse", "--abbrev-ref", "HEAD"])?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn working_tree_is_dirty(root_dir: &str) -> Result<bool, GitError> {
    let output = run_git(root_dir, "git_smart_checkout_branch", &["status", "--porcelain", "-u"])?;
    Ok(!output.stdout.is_empty())
}

fn rusty_stash_marker(branch: &str) -> String {
    format!("rusty-smart-switch:{}", branch)
}

fn stash_current_branch(root_dir: &str, branch: &str) -> Result<bool, GitError> {
    if !working_tree_is_dirty(root_dir)? {
        return Ok(false);
    }
    let marker = rusty_stash_marker(branch);
    run_git(root_dir, "git_smart_checkout_branch", &["stash", "push", "--include-untracked", "-m", &marker])?;
    Ok(true)
}

fn rusty_stash_ref_for_branch(root_dir: &str, branch: &str) -> Result<Option<String>, GitError> {
    let output = run_git(root_dir, "git_smart_checkout_branch", &["stash", "list", "--format=%gd%x09%s"])?;
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

fn restore_rusty_stash_for_branch(root_dir: &str, branch: &str) -> Result<bool, GitError> {
    let Some(stash_ref) = rusty_stash_ref_for_branch(root_dir, branch)? else {
        return Ok(false);
    };
    let output = Command::new("git")
        .args(&["stash", "pop", &stash_ref])
        .current_dir(root_dir)
        .output()
        .map_err(|e| GitError {
            operation: "git_smart_checkout_branch".to_string(),
            repository: root_dir.to_string(),
            exit_code: None,
            stderr: String::new(),
            message: format!("Failed to run git: {e}"),
        })?;
    if output.status.success() {
        Ok(true)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(GitError {
            operation: "git_smart_checkout_branch".to_string(),
            repository: root_dir.to_string(),
            exit_code: output.status.code(),
            stderr: stderr.clone(),
            message: format!(
                "Switched branches, but Rusty could not restore saved changes for '{}'. Resolve the conflict, then use the preserved stash {}. {}",
                branch, stash_ref, stderr
            ),
        })
    }
}

fn checkout_branch(root_dir: &str, branch_name: &str) -> Result<(), GitError> {
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
    run_git(root_dir, "git_checkout_branch", &args)?;
    Ok(())
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
pub async fn git_status(root_dir: String) -> Result<GitStatusResult, GitError> {
    let root_path = Path::new(&root_dir);
    if !root_path.exists() {
        return Err(GitError {
            operation: "git_status".to_string(),
            repository: root_dir.clone(),
            exit_code: None,
            stderr: String::new(),
            message: "Directory does not exist".to_string(),
        });
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
        .map_err(|e| GitError {
            operation: "git_status".to_string(),
            repository: root_dir.clone(),
            exit_code: None,
            stderr: String::new(),
            message: format!("Failed to run git: {e}"),
        })?;

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
pub async fn git_stage_file(root_dir: String, file_path: String) -> Result<(), GitError> {
    let relative = relative_to_root(&root_dir, &file_path, "git_stage_file")?;
    run_git(&root_dir, "git_stage_file", &["add", &relative])?;
    Ok(())
}

/// Unstages a file from the index.
/// Uses `git reset HEAD <file>` if a HEAD ref exists, or `git rm --cached` in an empty repo.
#[tauri::command]
pub async fn git_unstage_file(root_dir: String, file_path: String) -> Result<(), GitError> {
    let relative = relative_to_root(&root_dir, &file_path, "git_unstage_file")?;

    // Determine if HEAD commit exists
    let has_head = Command::new("git")
        .args(&["rev-parse", "HEAD"])
        .current_dir(&root_dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if has_head {
        run_git(&root_dir, "git_unstage_file", &["reset", "HEAD", &relative])?;
    } else {
        run_git(&root_dir, "git_unstage_file", &["rm", "--cached", "-r", "--ignore-unmatch", &relative])?;
    }
    Ok(())
}

/// Adds a file to the repository root `.gitignore`, creating it if needed.
/// The entry is anchored to the repo root (leading `/`) so it only matches
/// this exact path rather than any same-named file elsewhere in the tree.
/// If the file is already tracked, unstages/untracks it too, since adding a
/// pattern to `.gitignore` alone has no effect on files git already tracks.
#[tauri::command]
pub async fn git_add_to_gitignore(root_dir: String, file_path: String) -> Result<(), GitError> {
    let relative = relative_to_root(&root_dir, &file_path, "git_add_to_gitignore")?;
    let root_path = Path::new(&root_dir);

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
        std::fs::write(&gitignore_path, content).map_err(|e| GitError {
            operation: "git_add_to_gitignore".to_string(),
            repository: root_dir.clone(),
            exit_code: None,
            stderr: String::new(),
            message: format!("Failed to write .gitignore: {e}"),
        })?;
    }

    // If the file is already tracked, `.gitignore` won't stop git from seeing
    // its future edits — untrack it (keeping the file on disk) so it fully
    // drops out of status.
    let is_tracked = Command::new("git")
        .args(&["ls-files", "--error-unmatch", &relative])
        .current_dir(&root_dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if is_tracked {
        run_git(&root_dir, "git_add_to_gitignore", &["rm", "--cached", "-r", "--ignore-unmatch", &relative])?;
    }

    Ok(())
}

/// Discards unstaged modifications.
/// Attempts `git checkout -- <file>`, falling back to `git restore <file>`,
/// and deletes the physical file if it is fully untracked.
#[tauri::command]
pub async fn git_discard_changes(root_dir: String, file_path: String) -> Result<(), GitError> {
    let relative = relative_to_root(&root_dir, &file_path, "git_discard_changes")?;

    // Try traditional checkout first
    let output = Command::new("git")
        .args(&["checkout", "--", &relative])
        .current_dir(&root_dir)
        .output();

    let success = match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    };

    if !success {
        // Fallback to git restore
        let restore_output = Command::new("git")
            .args(&["restore", &relative])
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
                .args(&["ls-files", "--error-unmatch", &relative])
                .current_dir(&root_dir)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                std::fs::remove_file(path_buf).map_err(|e| GitError {
                    operation: "git_discard_changes".to_string(),
                    repository: root_dir.clone(),
                    exit_code: None,
                    stderr: String::new(),
                    message: format!("Failed to delete untracked file: {e}"),
                })?;
                return Ok(());
            }
            return Err(GitError {
                operation: "git_discard_changes".to_string(),
                repository: root_dir.clone(),
                exit_code: None,
                stderr: String::new(),
                message: "Failed to discard changes".to_string(),
            });
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
pub async fn git_get_head_content(root_dir: String, file_path: String) -> Result<String, GitError> {
    let relative = relative_to_root(&root_dir, &file_path, "git_get_head_content")?;

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
pub async fn git_get_branches(root_dir: String) -> Result<Vec<String>, GitError> {
    let output = run_git(&root_dir, "git_get_branches", &["branch", "--format=%(refname:short)"])?;

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
pub async fn git_get_all_branches(root_dir: String) -> Result<BranchesResult, GitError> {
    // Local branches
    let local_output = run_git(&root_dir, "git_get_all_branches", &["branch", "--format=%(refname:short)"])?;

    let local: Vec<String> = String::from_utf8_lossy(&local_output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    // Remote-tracking branches (refs/remotes/*). Drop symbolic HEAD pointers
    // (e.g. "origin/HEAD -> origin/main") so only real branches remain.
    let remote_output = run_git(&root_dir, "git_get_all_branches", &["branch", "-r", "--format=%(refname:short)"])?;

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
pub async fn git_fetch(root_dir: String) -> Result<(), GitError> {
    // Skip silently when there is no remote configured.
    let remote_check = run_git(&root_dir, "git_fetch", &["remote"])?;
    if String::from_utf8_lossy(&remote_check.stdout).trim().is_empty() {
        return Ok(());
    }

    run_git(&root_dir, "git_fetch", &["fetch", "--prune"])?;
    Ok(())
}

/// Performs a checkout to switch the repository's active branch.
///
/// When a remote-tracking ref (e.g. "origin/foo") is passed, a local tracking
/// branch "foo" is checked out (created with `--track` if it doesn't already
/// exist) so that subsequent push/pull operations are wired to origin.
#[tauri::command]
pub async fn git_checkout_branch(root_dir: String, branch_name: String) -> Result<(), GitError> {
    checkout_branch(&root_dir, &branch_name)
}

/// IntelliJ-style branch switching for a single working directory. Dirty work
/// is saved to a Rusty-tagged stash before checkout and is restored when the
/// user later returns to that same branch. The stash preserves staged state,
/// unstaged changes, and untracked files.
#[tauri::command]
pub async fn git_smart_checkout_branch(root_dir: String, branch_name: String) -> Result<SmartBranchSwitchResult, GitError> {
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
pub async fn git_create_branch(root_dir: String, branch_name: String, checkout: bool) -> Result<(), GitError> {
    let args = if checkout {
        vec!["checkout", "-b", &branch_name]
    } else {
        vec!["branch", &branch_name]
    };
    run_git(&root_dir, "git_create_branch", &args)?;
    Ok(())
}

/// Creates a branch and, when requested, uses the same safe stash workflow as
/// smart checkout so the new branch starts clean and the source work remains
/// associated with its original branch.
#[tauri::command]
pub async fn git_smart_create_branch(root_dir: String, branch_name: String, checkout: bool) -> Result<SmartBranchSwitchResult, GitError> {
    if !checkout {
        git_create_branch(root_dir, branch_name, false).await?;
        return Ok(SmartBranchSwitchResult { stashed: false, restored: false });
    }
    let source_branch = current_branch_name(&root_dir)?;
    let stashed = stash_current_branch(&root_dir, &source_branch)?;
    run_git(&root_dir, "git_smart_create_branch", &["checkout", "-b", &branch_name])?;
    Ok(SmartBranchSwitchResult { stashed, restored: false })
}

/// Deletes a local branch. When `force` is true uses `git branch -D` (delete
/// even if not merged), otherwise `git branch -d` (safe delete, refuses if the
/// branch has unmerged commits).
#[tauri::command]
pub async fn git_delete_branch(root_dir: String, branch_name: String, force: bool) -> Result<(), GitError> {
    let flag = if force { "-D" } else { "-d" };
    run_git(&root_dir, "git_delete_branch", &["branch", flag, &branch_name])?;
    Ok(())
}

/// Deletes a branch from the remote origin via `git push origin --delete`.
/// This is the "pushed deletion" that removes the branch on the remote.
#[tauri::command]
pub async fn git_delete_remote_branch(root_dir: String, branch_name: String) -> Result<(), GitError> {
    // Accept either "origin/foo" or a bare "foo" — always delete from origin.
    let local_name = branch_name
        .strip_prefix("origin/")
        .unwrap_or(&branch_name);

    run_git(&root_dir, "git_delete_remote_branch", &["push", "origin", "--delete", local_name])?;
    Ok(())
}

/// Merges a branch into the current branch.
#[tauri::command]
pub async fn git_merge_branch(root_dir: String, branch_name: String) -> Result<String, GitError> {
    let output = run_git(&root_dir, "git_merge_branch", &["merge", &branch_name])?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Rebases the current branch onto the specified branch.
#[tauri::command]
pub async fn git_rebase_branch(root_dir: String, branch_name: String) -> Result<String, GitError> {
    let output = run_git(&root_dir, "git_rebase_branch", &["rebase", &branch_name])?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Aborts an ongoing rebase or merge.
#[tauri::command]
pub async fn git_abort_pending(root_dir: String, operation: String) -> Result<(), GitError> {
    let op = match operation.as_str() {
        "rebase" => "rebase",
        _ => "merge",
    };
    run_git(&root_dir, "git_abort_pending", &[op, "--abort"])?;
    Ok(())
}

/// Undoes a file move/rename by moving the file back to its original location.
/// `root_dir` is currently unused for any containment check -- PR 5a commit
/// 10 fixes this (today's only other callers of this pattern at least do a
/// non-canonicalizing `strip_prefix`; this command does not even do that).
#[tauri::command]
pub async fn git_undo_last_rename(root_dir: String, original_path: String, new_path: String) -> Result<(), GitError> {
    if !std::path::Path::new(&new_path).exists() {
        return Err(GitError {
            operation: "git_undo_last_rename".to_string(),
            repository: root_dir,
            exit_code: None,
            stderr: String::new(),
            message: "File at new path no longer exists".to_string(),
        });
    }
    std::fs::rename(&new_path, &original_path).map_err(|e| GitError {
        operation: "git_undo_last_rename".to_string(),
        repository: root_dir,
        exit_code: None,
        stderr: String::new(),
        message: e.to_string(),
    })?;
    Ok(())
}
/// Used to diff against HEAD (for staged files) or current VFS (for unstaged files).
/// Falls back to the HEAD version if not explicitly modified in the index.
#[tauri::command]
pub async fn git_get_index_content(root_dir: String, file_path: String) -> Result<String, GitError> {
    let relative = relative_to_root(&root_dir, &file_path, "git_get_index_content")?;

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
pub async fn git_pull(root_dir: String) -> Result<(), GitError> {
    run_git(&root_dir, "git_pull", &["pull"])?;
    Ok(())
}

/// Pushes local committed changes to the remote repository.
/// Automatically sets the upstream origin tracking branch if not already configured.
#[tauri::command]
pub async fn git_push(root_dir: String, branch_name: String) -> Result<(), GitError> {
    // 1. Try a regular push first
    match run_git(&root_dir, "git_push", &["push"]) {
        Ok(_) => Ok(()),
        Err(err) => {
            // 2. If it fails because there is no upstream configured, set one.
            if err.stderr.contains("no upstream branch") || err.stderr.contains("has no upstream branch") {
                run_git(&root_dir, "git_push", &["push", "--set-upstream", "origin", &branch_name])?;
                Ok(())
            } else {
                Err(err)
            }
        }
    }
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
pub async fn git_get_commit_history(root_dir: String) -> Result<Vec<GitCommitInfo>, GitError> {
    if !Path::new(&root_dir).exists() {
        return Err(GitError {
            operation: "git_get_commit_history".to_string(),
            repository: root_dir,
            exit_code: None,
            stderr: String::new(),
            message: "Directory does not exist".to_string(),
        });
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
    let log_output = match Command::new("git")
        .args(&[
            "log",
            "--format=%H|%P|%an|%cr|%s|%d",
            "--max-count=100",
            "--all",
        ])
        .current_dir(&root_dir)
        .output()
    {
        Ok(output) if output.status.success() => output,
        // Return an empty list if there are no commits yet (brand new repo)
        // or the process could not even be spawned.
        _ => return Ok(Vec::new()),
    };

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
pub async fn git_get_commit_files(root_dir: String, commit_hash: String) -> Result<Vec<GitCommitFileStatus>, GitError> {
    if !Path::new(&root_dir).exists() {
        return Err(GitError {
            operation: "git_get_commit_files".to_string(),
            repository: root_dir,
            exit_code: None,
            stderr: String::new(),
            message: "Directory does not exist".to_string(),
        });
    }

    // Run git diff-tree --no-commit-id --name-status -r <commit_hash>
    let output = run_git(&root_dir, "git_get_commit_files", &["diff-tree", "--no-commit-id", "--name-status", "-r", &commit_hash])?;

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
pub async fn git_get_file_content_at_rev(root_dir: String, revision: String, file_path: String) -> Result<String, GitError> {
    let relative = relative_to_root(&root_dir, &file_path, "git_get_file_content_at_rev")?;

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
pub async fn git_discard_all_changes(root_dir: String) -> Result<(), GitError> {
    // Discard changes to tracked files
    run_git(&root_dir, "git_discard_all_changes", &["checkout", "--", "."])?;
    // Discard untracked files and directories
    run_git(&root_dir, "git_discard_all_changes", &["clean", "-df"])?;
    Ok(())
}

/// Reverts a specific commit by executing `git revert --no-edit <commit_hash>`.
#[tauri::command]
pub async fn git_revert_commit(root_dir: String, commit_hash: String) -> Result<(), GitError> {
    run_git(&root_dir, "git_revert_commit", &["revert", "--no-edit", &commit_hash])?;
    Ok(())
}

/// Resets the current branch to a specific commit by executing `git reset --hard <commit_hash>`.
#[tauri::command]
pub async fn git_reset_to_commit(root_dir: String, commit_hash: String) -> Result<(), GitError> {
    run_git(&root_dir, "git_reset_to_commit", &["reset", "--hard", &commit_hash])?;
    Ok(())
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
pub async fn git_blame(root_dir: String, file_path: String) -> Result<Vec<GitBlameLine>, GitError> {
    if !Path::new(&root_dir).exists() {
        return Err(GitError {
            operation: "git_blame".to_string(),
            repository: root_dir,
            exit_code: None,
            stderr: String::new(),
            message: "Directory does not exist".to_string(),
        });
    }

    let relative_path = if file_path.starts_with(&root_dir) {
        let prefix_len = root_dir.len();
        let stripped = &file_path[prefix_len..];
        stripped.trim_start_matches('/').trim_start_matches('\\').to_string()
    } else {
        file_path
    };

    let output = run_git(&root_dir, "git_blame", &["blame", "-w", "--date=short", &relative_path])?;

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
pub async fn git_get_file_commit_history(root_dir: String, file_path: String) -> Result<Vec<GitCommitInfo>, GitError> {
    if !Path::new(&root_dir).exists() {
        return Err(GitError {
            operation: "git_get_file_commit_history".to_string(),
            repository: root_dir,
            exit_code: None,
            stderr: String::new(),
            message: "Directory does not exist".to_string(),
        });
    }

    let relative_path = if file_path.starts_with(&root_dir) {
        let prefix_len = root_dir.len();
        let stripped = &file_path[prefix_len..];
        stripped.trim_start_matches('/').trim_start_matches('\\').to_string()
    } else {
        file_path
    };

    let log_output = match run_git(&root_dir, "git_get_file_commit_history", &[
        "log",
        "--format=%H|%P|%an|%cr|%s|%d",
        "--max-count=100",
        "--follow",
        "--",
        &relative_path,
    ]) {
        Ok(output) => output,
        // Matches git_get_commit_history's own permissive fallback: treated
        // as "no history yet" rather than propagated as an error.
        Err(_) => return Ok(Vec::new()),
    };

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
pub async fn git_scan_subprojects(root_dir: String) -> Result<Vec<String>, GitError> {
    let root_path = Path::new(&root_dir);
    if !root_path.exists() {
        return Err(GitError {
            operation: "git_scan_subprojects".to_string(),
            repository: root_dir,
            exit_code: None,
            stderr: String::new(),
            message: "Directory does not exist".to_string(),
        });
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

/// The branch/detached/unborn tri-state of a repository's `HEAD`, replacing
/// the old `current_branch: String` field's collapsed representation
/// (detached returned the literal string `"HEAD"`; unborn fell back to a
/// dead `"empty-repo"` sentinel -- see `git_status_on_unborn_repo_reports_main_not_empty_repo`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct GitHeadState {
    /// `"branch"`, `"detached"`, or `"unborn"` (a repository with no commits
    /// yet -- `branch` may still be `Some` here: `git init` points HEAD at
    /// a named branch before the first commit exists).
    pub mode: String,
    pub branch: Option<String>,
    pub oid: Option<String>,
}

/// A discovered Git repository: the workspace root the user opened, or one
/// of its submodules/nested repos/linked worktrees. This commit only
/// distinguishes `"workspace"` (the common case) from `"worktree"` (a
/// linked worktree, identified by its resolved git dir containing a
/// `/worktrees/` path segment) and `"submodule"` (a `/modules/` segment,
/// present once a submodule is actually initialized) -- `"nested"` (an
/// unrelated repo that merely happens to live inside another one's tree,
/// not a registered submodule) can only be determined by cross-referencing
/// a parent's `.gitmodules`, which is PR 5a commit 5's job, not this one's.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitRepository {
    /// The canonicalized `worktree_path`, matching the same
    /// `canonicalizeFilePath` convention `src/tabs/identity.ts` already uses
    /// for tab identity -- paths are the natural, debuggable key here.
    pub id: String,
    pub worktree_path: String,
    /// The resolved git directory -- correct whether `.git` is a directory
    /// or a file (a submodule or linked worktree), with no special-casing.
    pub git_dir: String,
    pub kind: String,
    pub parent_id: Option<String>,
    pub submodule_path: Option<String>,
    pub initialized: bool,
    pub head: GitHeadState,
}

fn resolve_head_state(root_dir: &str) -> GitHeadState {
    let branch = Command::new("git")
        .args(&["symbolic-ref", "--short", "-q", "HEAD"])
        .current_dir(root_dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    let oid = Command::new("git")
        .args(&["rev-parse", "HEAD"])
        .current_dir(root_dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    let mode = match (&branch, &oid) {
        (Some(_), Some(_)) => "branch",
        (Some(_), None) => "unborn", // on a named branch, but no commits yet
        (None, Some(_)) => "detached",
        (None, None) => "unborn", // defensive: neither a symbolic ref nor a resolvable commit
    };

    GitHeadState { mode: mode.to_string(), branch, oid }
}

/// Discovers the Git repository rooted at (or containing) `root_dir`: its
/// canonical worktree path, resolved git dir, and `HEAD` tri-state.
pub fn discover_repository(root_dir: &str) -> Result<GitRepository, GitError> {
    let toplevel_output = run_git(root_dir, "git_discover_repository", &["rev-parse", "--show-toplevel"])?;
    let worktree_path_raw = String::from_utf8_lossy(&toplevel_output.stdout).trim().to_string();
    let worktree_path = std::fs::canonicalize(&worktree_path_raw)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(worktree_path_raw);

    let git_dir_output = run_git(root_dir, "git_discover_repository", &["rev-parse", "--git-dir"])?;
    let git_dir_raw = String::from_utf8_lossy(&git_dir_output.stdout).trim().to_string();
    let git_dir_path = Path::new(&git_dir_raw);
    let git_dir_abs = if git_dir_path.is_absolute() {
        git_dir_path.to_path_buf()
    } else {
        Path::new(&worktree_path).join(git_dir_path)
    };
    let git_dir = std::fs::canonicalize(&git_dir_abs)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| git_dir_abs.to_string_lossy().into_owned());

    let git_dir_normalized = git_dir.replace('\\', "/");
    let kind = if git_dir_normalized.contains("/worktrees/") {
        "worktree"
    } else if git_dir_normalized.contains("/modules/") {
        "submodule"
    } else {
        "workspace"
    };

    let head = resolve_head_state(&worktree_path);

    Ok(GitRepository {
        id: worktree_path.clone(),
        worktree_path,
        git_dir,
        kind: kind.to_string(),
        parent_id: None,
        submodule_path: None,
        initialized: true,
        head,
    })
}

/// Discovers the Git repository at `root_dir`, including its branch/
/// detached/unborn `HEAD` tri-state.
#[tauri::command]
pub async fn git_discover_repository(root_dir: String) -> Result<GitRepository, GitError> {
    discover_repository(&root_dir)
}

/// Lists every linked worktree of the repository at `root_dir` (via
/// `git worktree list --porcelain`), including the main worktree itself,
/// each fully discovered via `discover_repository`. This is the checklist's
/// "Support linked worktrees where present" -- git's own worktree metadata
/// is the direct discovery primitive for it (not named in the original
/// checklist, added here since it parses easily alongside this commit's
/// other work).
pub fn discover_linked_worktrees(root_dir: &str) -> Result<Vec<GitRepository>, GitError> {
    let output = run_git(root_dir, "git_discover_linked_worktrees", &["worktree", "list", "--porcelain"])?;
    let text = String::from_utf8_lossy(&output.stdout);

    let mut worktrees = Vec::new();
    for block in text.split("\n\n") {
        let path = block.lines().find_map(|line| line.strip_prefix("worktree "));
        if let Some(path) = path {
            if let Ok(repo) = discover_repository(path) {
                worktrees.push(repo);
            }
        }
    }
    Ok(worktrees)
}

/// Lists every linked worktree of the repository at `root_dir`, including
/// the main worktree itself.
#[tauri::command]
pub async fn git_discover_linked_worktrees(root_dir: String) -> Result<Vec<GitRepository>, GitError> {
    discover_linked_worktrees(&root_dir)
}

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;
