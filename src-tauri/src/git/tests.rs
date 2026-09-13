//! Proof-of-concept characterization tests for `git.rs`, exercised through
//! hermetic fixtures (see `fixtures.rs`).
//!
//! Every `#[tauri::command]` in `git.rs` takes only `String`/primitive
//! params -- no `AppHandle`, `State`, or `Window` -- so all of them are
//! directly callable here with zero production refactor. `mod git;` in
//! `lib.rs` is private, so these tests must live in-crate (an integration
//! test crate under `src-tauri/tests/` could not reach `git::*` at all).
//!
//! These tests pin ACTUAL current behavior, including two known defects
//! (marked `KNOWN-WRONG`) that PR 5 fixes. They are a small proof-of-concept
//! set; the full fixture matrix (submodules, worktrees, renames, etc.) is
//! PR 5's job.

use super::fixtures::GitFixture;
use super::*;

#[tokio::test]
async fn git_status_on_nonexistent_path_errors() {
    // PR 5a commit 3: git_status now rejects with a structured GitError
    // (operation/repository/exit_code/stderr/message) instead of a bare
    // string.
    let result = git_status("/no/such/path/rusty-test-fixture".to_string()).await;
    let err = result.unwrap_err();
    assert_eq!(err.operation, "git_status");
    assert_eq!(err.repository, "/no/such/path/rusty-test-fixture");
    assert_eq!(err.exit_code, None);
    assert_eq!(err.message, "Directory does not exist");
}

#[tokio::test]
async fn git_status_on_non_repo_directory() {
    let dir = tempfile::TempDir::new().unwrap();
    let result = git_status(dir.path().to_string_lossy().into_owned()).await.unwrap();

    assert!(!result.is_repo);
    assert_eq!(result.current_branch, "");
    assert!(result.staged.is_empty());
    assert!(result.unstaged.is_empty());
}

#[tokio::test]
async fn git_status_reports_modified_tracked_file() {
    let fx = GitFixture::init();
    fx.commit_file("a.txt", "one\n", "initial commit");
    fx.write("a.txt", "two\n");

    let result = git_status(fx.path_str()).await.unwrap();

    assert!(result.is_repo);
    assert_eq!(result.current_branch, "main");
    assert!(result.staged.is_empty());
    assert_eq!(result.unstaged.len(), 1);
    assert_eq!(result.unstaged[0].status_type, "modified");
    assert!(result.unstaged[0].path.ends_with("a.txt"));
}

#[tokio::test]
async fn git_status_reports_untracked_file() {
    let fx = GitFixture::init();
    fx.commit_file("a.txt", "one\n", "initial commit");
    fx.write("b.txt", "new\n");

    let result = git_status(fx.path_str()).await.unwrap();

    assert_eq!(result.unstaged.len(), 1);
    assert_eq!(result.unstaged[0].status_type, "untracked");
    assert_eq!(result.unstaged[0].name, "b.txt");
}

#[tokio::test]
async fn git_status_reports_a_staged_then_further_modified_file_in_both_lists() {
    let fx = GitFixture::init();
    fx.commit_file("a.txt", "one\n", "initial commit");
    fx.write("a.txt", "two\n");
    fx.add("a.txt");
    // Modify again after staging -- porcelain reports this as "MM".
    fx.write("a.txt", "three\n");

    let result = git_status(fx.path_str()).await.unwrap();

    assert_eq!(result.staged.len(), 1);
    assert_eq!(result.staged[0].status_type, "modified");
    assert_eq!(result.unstaged.len(), 1);
    assert_eq!(result.unstaged[0].status_type, "modified");
}

#[tokio::test]
async fn git_status_on_unborn_repo_reports_main_not_empty_repo() {
    // `git branch --show-current` reports the pending branch name even
    // before the first commit on modern git, so the "empty-repo" fallback
    // string in git.rs is dead in practice. Pin the value actually observed;
    // PR 5 must distinguish "unborn" from "failed" explicitly rather than
    // relying on this string.
    let fx = GitFixture::init();

    let result = git_status(fx.path_str()).await.unwrap();

    assert!(result.is_repo);
    assert_eq!(result.current_branch, "main");
}

#[tokio::test]
async fn git_get_commit_history_orders_newest_first() {
    let fx = GitFixture::init();
    let first = fx.commit_file("a.txt", "one\n", "first commit");
    let second = fx.commit_file("a.txt", "two\n", "second commit");

    let history = git_get_commit_history(fx.path_str()).await.unwrap();

    assert_eq!(history.len(), 2);
    assert_eq!(history[0].hash, second);
    assert_eq!(history[0].subject, "second commit");
    assert_eq!(history[0].parents, vec![first.clone()]);
    assert_eq!(history[0].short_hash, second[0..7].to_string());
    assert_eq!(history[1].hash, first);
    assert!(history[1].parents.is_empty());
}

#[tokio::test]
async fn git_get_commit_history_includes_the_checked_out_detached_commit() {
    // Verified directly against git 2.45.0: `git log --all` documents that
    // it treats HEAD as an implicit extra starting point ("Pretend as if
    // all the refs in refs/, along with HEAD, are listed"), so a commit
    // that is checked out detached survives even after the branch that
    // created it is deleted. This is NOT the defect REFACTOR_PLAN.md's PR 5
    // checklist describes ("Include HEAD explicitly in history traversal
    // alongside refs") -- on this git version that inclusion already
    // happens. Pinned here so a future git version regressing this
    // (or PR 5 changing the underlying command) is caught either way.
    let fx = GitFixture::init();
    fx.commit_file("a.txt", "one\n", "on main");
    fx.git_ok(&["checkout", "-b", "throwaway"]);
    let orphan_commit = fx.commit_file("a.txt", "two\n", "on throwaway, about to be orphaned");
    fx.detach_to(&orphan_commit);
    fx.git_ok(&["branch", "-D", "throwaway"]);

    let history = git_get_commit_history(fx.path_str()).await.unwrap();

    assert!(
        history.iter().any(|c| c.hash == orphan_commit),
        "expected the detached HEAD commit to still be present via git log --all's implicit HEAD inclusion"
    );
}

#[tokio::test]
async fn git_get_commit_files_known_wrong_returns_empty_for_root_commit() {
    // KNOWN-WRONG (PR 5): `diff-tree --no-commit-id -r` without `--root`
    // emits nothing for a parentless (root) commit, so the file list for the
    // very first commit of any repository comes back empty. PR 5's
    // checklist item "Correctly list files for root commits" fixes this.
    let fx = GitFixture::init();
    let root_commit = fx.commit_file("a.txt", "one\n", "root commit");

    let files = git_get_commit_files(fx.path_str(), root_commit).await.unwrap();

    assert!(files.is_empty(), "expected the root-commit file list to be empty (current defect)");
}

#[tokio::test]
async fn git_scan_subprojects_finds_shallow_nested_repo() {
    let fx = GitFixture::init();
    let nested = fx.nested_repo("packages/nested");
    nested.commit_file("readme.md", "hi\n", "init nested");

    let results = git_scan_subprojects(fx.path_str()).await.unwrap();

    assert!(
        results.iter().any(|p| p.ends_with("packages/nested") || p.ends_with("packages\\nested")),
        "expected to find the nested repo, got: {:?}",
        results
    );
}

#[tokio::test]
async fn git_scan_subprojects_skips_ignored_directory_names() {
    let fx = GitFixture::init();
    fx.commit_file("a.txt", "one\n", "initial commit");
    let ignored = fx.nested_repo("node_modules/some-pkg");
    ignored.commit_file("readme.md", "hi\n", "init ignored");

    let results = git_scan_subprojects(fx.path_str()).await.unwrap();

    assert!(
        !results.iter().any(|p| p.contains("node_modules")),
        "expected node_modules to be skipped entirely, got: {:?}",
        results
    );
}

#[test]
fn git_error_serializes_to_the_documented_json_shape() {
    // PR 5a commit 2: confirms GitError's wire shape end-to-end before the
    // mechanical sweep (commit 3) converts every other command to it --
    // this is what the frontend's new TS-facing type (PR 5b commit 14)
    // must match field-for-field.
    let error = GitError {
        operation: "git_commit".to_string(),
        repository: "/tmp/repo".to_string(),
        exit_code: Some(1),
        stderr: "nothing to commit".to_string(),
        message: "nothing to commit".to_string(),
    };
    let json = serde_json::to_value(&error).unwrap();
    assert_eq!(json["operation"], "git_commit");
    assert_eq!(json["repository"], "/tmp/repo");
    assert_eq!(json["exit_code"], 1);
    assert_eq!(json["stderr"], "nothing to commit");
    assert_eq!(json["message"], "nothing to commit");
}

#[tokio::test]
async fn git_commit_with_nothing_staged_returns_a_structured_git_error() {
    let fx = GitFixture::init();
    fx.commit_file("a.txt", "one\n", "initial commit");
    // Nothing staged -- `git commit -m ...` exits non-zero with a message
    // on stdout, not stderr (this is the exact case run_git's
    // stderr-or-stdout-fallback message construction exists for).

    let result = git_commit(fx.path_str(), "empty commit attempt".to_string()).await;

    let err = result.unwrap_err();
    assert_eq!(err.operation, "git_commit");
    assert_eq!(err.repository, fx.path_str());
    assert_eq!(err.exit_code, Some(1));
    assert!(err.message.contains("nothing to commit") || err.message.contains("nothing added"), "unexpected message: {}", err.message);
}

#[tokio::test]
async fn git_init_on_an_unwritable_path_returns_a_structured_git_error() {
    let result = git_init("/no/such/path/rusty-test-fixture".to_string()).await;

    let err = result.unwrap_err();
    assert_eq!(err.operation, "git_init");
    assert_eq!(err.exit_code, None, "expected a spawn/cwd failure, not a git exit code");
}

#[tokio::test]
async fn check_is_git_repo_true_and_false() {
    let fx = GitFixture::init();
    assert!(check_is_git_repo(&fx.path_str()));

    let non_repo = tempfile::TempDir::new().unwrap();
    assert!(!check_is_git_repo(&non_repo.path().to_string_lossy()));
}
