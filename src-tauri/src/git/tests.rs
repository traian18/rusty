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
async fn git_get_commit_files_lists_files_for_a_root_commit() {
    // Fixed in PR 5a commit 8: `diff-tree --no-commit-id -r` without
    // `--root` emitted nothing for a parentless (root) commit, so the file
    // list for the very first commit of any repository always came back
    // empty. Verified directly that `--root` diffs a root commit against
    // the empty tree (fixing this) and changes nothing for a non-root
    // commit (so it's always safe to pass).
    let fx = GitFixture::init();
    let root_commit = fx.commit_file("a.txt", "one\n", "root commit");

    let files = git_get_commit_files(fx.path_str(), root_commit).await.unwrap();

    assert_eq!(files.len(), 1, "expected the root commit's added file to be listed, got: {:?}", files);
    assert_eq!(files[0].name, "a.txt");
    assert_eq!(files[0].status_type, "added");
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

// ── PR 5a commit 4: repository discovery ─────────────────────────────────

#[test]
fn git_repository_serializes_with_the_documented_field_names() {
    // Confirms the wire shape end-to-end before PR 5b's types commit
    // (which must match it field-for-field) is written.
    let repo = GitRepository {
        id: "/tmp/repo".to_string(),
        worktree_path: "/tmp/repo".to_string(),
        git_dir: "/tmp/repo/.git".to_string(),
        kind: "workspace".to_string(),
        parent_id: None,
        submodule_path: None,
        initialized: true,
        head: GitHeadState {
            mode: "branch".to_string(),
            branch: Some("main".to_string()),
            oid: Some("abc123".to_string()),
        },
    };
    let json = serde_json::to_value(&repo).unwrap();
    assert_eq!(json["id"], "/tmp/repo");
    assert_eq!(json["worktree_path"], "/tmp/repo");
    assert_eq!(json["git_dir"], "/tmp/repo/.git");
    assert_eq!(json["kind"], "workspace");
    assert_eq!(json["parent_id"], serde_json::Value::Null);
    assert_eq!(json["submodule_path"], serde_json::Value::Null);
    assert_eq!(json["initialized"], true);
    assert_eq!(json["head"]["mode"], "branch");
    assert_eq!(json["head"]["branch"], "main");
    assert_eq!(json["head"]["oid"], "abc123");
}

#[tokio::test]
async fn discover_repository_reports_branch_mode_for_a_normal_repo() {
    let fx = GitFixture::init();
    fx.commit_file("a.txt", "one\n", "initial commit");

    let repo = discover_repository(&fx.path_str()).unwrap();

    assert_eq!(repo.kind, "workspace");
    assert_eq!(repo.head.mode, "branch");
    assert_eq!(repo.head.branch.as_deref(), Some("main"));
    assert!(repo.head.oid.is_some());
    assert_eq!(repo.id, repo.worktree_path);
    assert!(repo.initialized);
    assert_eq!(repo.parent_id, None);
}

#[tokio::test]
async fn discover_repository_reports_detached_mode_with_no_branch() {
    let fx = GitFixture::init();
    let first = fx.commit_file("a.txt", "one\n", "first");
    fx.detach_to(&first);

    let repo = discover_repository(&fx.path_str()).unwrap();

    assert_eq!(repo.head.mode, "detached");
    assert_eq!(repo.head.branch, None);
    assert_eq!(repo.head.oid.as_deref(), Some(first.as_str()));
}

#[tokio::test]
async fn discover_repository_reports_unborn_mode_with_the_pending_branch_name() {
    // git init already points HEAD at a named branch before the first
    // commit exists -- unborn and "on a named branch" are not mutually
    // exclusive, which is exactly why this is a tri-state, not a bool.
    let fx = GitFixture::init();

    let repo = discover_repository(&fx.path_str()).unwrap();

    assert_eq!(repo.head.mode, "unborn");
    assert_eq!(repo.head.branch.as_deref(), Some("main"));
    assert_eq!(repo.head.oid, None);
}

#[tokio::test]
async fn discover_repository_resolves_a_linked_worktrees_git_file_correctly() {
    let main = GitFixture::init();
    main.commit_file("a.txt", "one\n", "initial commit");
    let worktree = main.add_linked_worktree("wt", "feature");

    let repo = discover_repository(&worktree.path_str()).unwrap();

    assert_eq!(repo.kind, "worktree");
    assert_eq!(repo.head.mode, "branch");
    assert_eq!(repo.head.branch.as_deref(), Some("feature"));
    // git_dir must resolve to the REAL git dir under the main repo's
    // .git/worktrees/<name> -- not a literal ".git" path inside the
    // worktree itself, whose .git is a FILE, not a directory.
    assert!(repo.git_dir.contains("worktrees"), "expected a worktrees-scoped git dir, got: {}", repo.git_dir);
    assert!(!std::path::Path::new(&worktree.path_str()).join(".git").is_dir());
}

#[tokio::test]
async fn discover_linked_worktrees_lists_the_main_worktree_and_its_linked_ones() {
    let main = GitFixture::init();
    main.commit_file("a.txt", "one\n", "initial commit");
    main.add_linked_worktree("wt", "feature");

    let worktrees = discover_linked_worktrees(&main.path_str()).unwrap();

    assert_eq!(worktrees.len(), 2);
    assert!(worktrees.iter().any(|w| w.kind == "workspace" && w.head.branch.as_deref() == Some("main")));
    assert!(worktrees.iter().any(|w| w.kind == "worktree" && w.head.branch.as_deref() == Some("feature")));
}

#[tokio::test]
async fn discover_repository_identifies_an_initialized_submodule_by_its_modules_git_dir() {
    // Cross-referencing .gitmodules/submodule status is PR 5a commit 5's
    // job -- but a single-repo discover_repository call can already tell
    // "this IS some parent's initialized submodule" just from its own
    // resolved git dir containing a /modules/ segment, with no parent
    // context needed at all.
    let source = GitFixture::init();
    source.commit_file("readme.md", "hi\n", "source initial commit");

    let parent = GitFixture::init();
    parent.commit_file("a.txt", "one\n", "parent initial commit");
    parent.add_submodule(std::path::Path::new(&source.path_str()), "sub");

    let submodule_path = std::path::Path::new(&parent.path_str()).join("sub");
    let repo = discover_repository(&submodule_path.to_string_lossy()).unwrap();

    assert_eq!(repo.kind, "submodule");
}

// ── PR 5a commit 5: recursive submodule discovery ────────────────────────

#[tokio::test]
async fn discover_submodules_finds_an_initialized_submodule() {
    let source = GitFixture::init();
    source.commit_file("readme.md", "hi\n", "source initial commit");

    let parent = GitFixture::init();
    parent.commit_file("a.txt", "one\n", "parent initial commit");
    parent.add_submodule(std::path::Path::new(&source.path_str()), "sub");
    parent.git_ok(&["commit", "-m", "add sub"]);

    let submodules = discover_submodules(&parent.path_str()).unwrap();

    assert_eq!(submodules.len(), 1);
    let sub = &submodules[0];
    assert_eq!(sub.kind, "submodule");
    assert!(sub.initialized);
    assert_eq!(sub.submodule_path.as_deref(), Some("sub"));
    let parent_repo = discover_repository(&parent.path_str()).unwrap();
    assert_eq!(sub.parent_id, Some(parent_repo.id));
    // Fully discoverable since it's checked out: has its own real HEAD.
    assert_eq!(sub.head.mode, "branch");
}

#[tokio::test]
async fn discover_submodules_reports_an_uninitialized_submodule_without_a_working_tree() {
    let source = GitFixture::init();
    source.commit_file("readme.md", "hi\n", "source initial commit");

    let parent = GitFixture::init();
    parent.commit_file("a.txt", "one\n", "parent initial commit");
    parent.add_submodule(std::path::Path::new(&source.path_str()), "sub");
    parent.git_ok(&["commit", "-m", "add sub"]);
    parent.git_ok(&["submodule", "deinit", "-f", "sub"]);

    let submodules = discover_submodules(&parent.path_str()).unwrap();

    assert_eq!(submodules.len(), 1);
    let sub = &submodules[0];
    assert_eq!(sub.kind, "submodule");
    assert!(!sub.initialized);
    assert_eq!(sub.submodule_path.as_deref(), Some("sub"));
    // The gitlink commit is still known even though nothing is checked out.
    assert!(sub.head.oid.is_some());
}

#[tokio::test]
async fn discover_submodules_finds_a_submodule_nested_inside_another_submodule() {
    let innermost = GitFixture::init();
    innermost.commit_file("leaf.md", "leaf\n", "innermost initial commit");

    let middle = GitFixture::init();
    middle.commit_file("a.txt", "one\n", "middle initial commit");
    middle.add_submodule(std::path::Path::new(&innermost.path_str()), "inner");
    middle.git_ok(&["commit", "-m", "add inner submodule"]);

    let outer = GitFixture::init();
    outer.commit_file("a.txt", "one\n", "outer initial commit");
    outer.add_submodule(std::path::Path::new(&middle.path_str()), "outer-sub");
    outer.git_ok(&["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
    outer.git_ok(&["commit", "-m", "add outer-sub"]);

    let submodules = discover_submodules(&outer.path_str()).unwrap();

    assert_eq!(submodules.len(), 2, "expected both outer-sub and outer-sub/inner: {:?}", submodules.iter().map(|s| &s.submodule_path).collect::<Vec<_>>());
    let outer_sub = submodules.iter().find(|s| s.submodule_path.as_deref() == Some("outer-sub")).expect("outer-sub not found");
    let inner_sub = submodules.iter().find(|s| s.submodule_path.as_deref() == Some("outer-sub/inner")).expect("nested inner submodule not found");

    let outer_repo = discover_repository(&outer.path_str()).unwrap();
    assert_eq!(outer_sub.parent_id, Some(outer_repo.id));
    // The nested submodule's parent is the OUTER SUBMODULE itself, not the
    // top-level outer repository.
    assert_eq!(inner_sub.parent_id, Some(outer_sub.id.clone()));
    assert!(inner_sub.initialized);
}

#[tokio::test]
async fn discover_submodules_cannot_see_a_nested_submodule_of_an_uninitialized_one() {
    // Documents a real, accepted limitation: git submodule status --recursive
    // itself cannot descend into an uninitialized submodule, so its own
    // nested submodules are invisible until it is initialized.
    let innermost = GitFixture::init();
    innermost.commit_file("leaf.md", "leaf\n", "innermost initial commit");

    let middle = GitFixture::init();
    middle.commit_file("a.txt", "one\n", "middle initial commit");
    middle.add_submodule(std::path::Path::new(&innermost.path_str()), "inner");
    middle.git_ok(&["commit", "-m", "add inner submodule"]);

    let outer = GitFixture::init();
    outer.commit_file("a.txt", "one\n", "outer initial commit");
    outer.add_submodule(std::path::Path::new(&middle.path_str()), "outer-sub");
    outer.git_ok(&["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
    outer.git_ok(&["commit", "-m", "add outer-sub"]);
    outer.git_ok(&["submodule", "deinit", "-f", "outer-sub"]);

    let submodules = discover_submodules(&outer.path_str()).unwrap();

    assert_eq!(submodules.len(), 1, "expected only outer-sub itself, not its nested inner: {:?}", submodules.iter().map(|s| &s.submodule_path).collect::<Vec<_>>());
    assert_eq!(submodules[0].submodule_path.as_deref(), Some("outer-sub"));
    assert!(!submodules[0].initialized);
}

// ── PR 5a commit 7: -z status parsing rewrite ────────────────────────────

#[tokio::test]
async fn git_status_reports_a_filename_with_spaces_and_unicode() {
    let fx = GitFixture::init();
    fx.commit_file("a.txt", "one\n", "initial commit");
    // Both a space and a non-ASCII byte in one name -- the exact
    // combination that old plain --porcelain (no -z) would have partly
    // mishandled (unicode bytes come back octal-escaped and wrapped in
    // quotes without -z; verified directly this does NOT happen with -z).
    fx.write("héllo world.txt", "hi\n");

    let result = git_status(fx.path_str()).await.unwrap();

    assert_eq!(result.unstaged.len(), 1);
    assert_eq!(result.unstaged[0].status_type, "untracked");
    assert_eq!(result.unstaged[0].name, "héllo world.txt");
    assert!(result.unstaged[0].path.ends_with("héllo world.txt"));
}

#[tokio::test]
async fn git_status_reports_a_staged_rename_with_the_new_path_not_the_arrow_string() {
    let fx = GitFixture::init();
    fx.commit_file("old.txt", "one\n", "initial commit");
    fx.git_ok(&["mv", "old.txt", "new.txt"]);

    let result = git_status(fx.path_str()).await.unwrap();

    assert_eq!(result.staged.len(), 1);
    assert_eq!(result.staged[0].status_type, "renamed");
    // Before this commit, plain --porcelain (no -z) would have stored the
    // literal string "old.txt -> new.txt" (arrow included) as the path.
    assert_eq!(result.staged[0].name, "new.txt");
    assert!(result.staged[0].path.ends_with("new.txt"));
    assert!(!result.staged[0].path.contains("->"));
}

#[test]
fn parse_status_z_reads_a_copy_records_new_path_not_its_extra_old_path_field() {
    // git's own copy detection is config/heuristic-gated and did not
    // reproduce through a real fixture even with status.renames=copies set
    // (verified directly) -- exercised here as a pure parser unit test
    // against the exact byte format the porcelain=v1 -z spec documents for
    // an R/C record (NEW path first, then one extra NUL-terminated field
    // for the OLD path) instead.
    let root = std::path::Path::new("/repo");
    let raw = "C  new-copy.txt\0source.txt\0";

    let (staged, unstaged) = parse_status_z(raw, root);

    assert_eq!(unstaged.len(), 0);
    assert_eq!(staged.len(), 1);
    assert_eq!(staged[0].status_type, "copied");
    assert_eq!(staged[0].name, "new-copy.txt");
    assert_eq!(staged[0].path, "/repo/new-copy.txt");
}

#[test]
fn parse_status_z_does_not_let_a_renames_extra_field_bleed_into_the_next_record() {
    let root = std::path::Path::new("/repo");
    let raw = "R  new.txt\0old.txt\0?? untracked.txt\0";

    let (staged, unstaged) = parse_status_z(raw, root);

    assert_eq!(staged.len(), 1);
    assert_eq!(staged[0].name, "new.txt");
    assert_eq!(unstaged.len(), 1);
    assert_eq!(unstaged[0].name, "untracked.txt");
    assert_eq!(unstaged[0].status_type, "untracked");
}
