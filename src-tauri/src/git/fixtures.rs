//! Hermetic Git repository fixtures for `git.rs` tests.
//!
//! `git_command` (in `git.rs`) shells out with the ambient environment and
//! accepts no overrides, and `std::env::set_var` is `unsafe` and racy under
//! Rust's multi-threaded test harness. So instead of mutating process-global
//! state, `GitFixture` shells out to `git` directly with per-invocation
//! environment overrides, and bakes determinism into repo-local
//! `.git/config`, which always wins over the developer's global config -- so
//! the production code (which does inherit the ambient environment) observes
//! the same deterministic identity, branch name, and signing behavior.
//!
//! macOS gotcha: `tempfile::TempDir` yields a path under `/var/folders/...`,
//! itself a symlink to `/private/var/...`. `git_status` echoes back
//! whatever string form of the path it was given (see `root_path.join(...)`
//! in `git.rs`), so assertions must compare against paths derived from
//! `fixture.path_str()` -- never against a `canonicalize`d form of one side
//! only, or the comparison will spuriously fail on the symlink resolution.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use tempfile::TempDir;

/// A fixture either owns its temp directory (and deletes it on drop) or
/// lives nested inside a parent fixture's directory, in which case the
/// parent's TempDir is the sole owner of cleanup.
enum Root {
    Owned(TempDir),
    Nested(PathBuf),
}

impl Root {
    fn path(&self) -> &Path {
        match self {
            Root::Owned(dir) => dir.path(),
            Root::Nested(path) => path.as_path(),
        }
    }
}

pub(crate) struct GitFixture {
    root: Root,
    /// An empty file used as GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM so the
    /// developer's real global/system git config can never leak into a test.
    empty_config: PathBuf,
    /// An empty directory used as core.hooksPath so a global hooksPath
    /// setting can never fire during a fixture operation.
    empty_hooks_dir: PathBuf,
}

impl GitFixture {
    /// Creates a fresh temp directory and initializes it as a git repository
    /// with deterministic identity, no signing, and no hooks.
    pub fn init() -> Self {
        let root = TempDir::new().expect("failed to create temp dir for git fixture");
        Self::init_at(Root::Owned(root), &["init"])
    }

    /// Creates a bare repository (no working tree) -- useful as a submodule
    /// source or a "repository without a remote" fixture in later tests.
    pub fn init_bare() -> Self {
        let root = TempDir::new().expect("failed to create temp dir for bare git fixture");
        Self::init_at(Root::Owned(root), &["init", "--bare"])
    }

    fn init_at(root: Root, init_args: &[&str]) -> Self {
        let empty_config = root.path().join(".rusty-test-empty-gitconfig");
        std::fs::write(&empty_config, "").expect("failed to write empty git config");
        let empty_hooks_dir = root.path().join(".rusty-test-empty-hooks");
        std::fs::create_dir_all(&empty_hooks_dir).expect("failed to create empty hooks dir");

        let fixture = GitFixture { root, empty_config, empty_hooks_dir };

        let mut args: Vec<&str> = vec!["-c", "init.defaultBranch=main"];
        args.extend_from_slice(init_args);
        fixture.git_ok(&args);
        fixture.git_ok(&["config", "user.name", "Rusty Test"]);
        fixture.git_ok(&["config", "user.email", "test@rusty.invalid"]);
        fixture.git_ok(&["config", "commit.gpgsign", "false"]);
        fixture.git_ok(&["config", "tag.gpgsign", "false"]);
        fixture.git_ok(&["config", "gc.auto", "0"]);
        fixture.git_ok(&["config", "core.autocrlf", "false"]);
        fixture.git_ok(&["config", "core.hooksPath", &fixture.empty_hooks_dir.to_string_lossy()]);
        fixture.git_ok(&["config", "protocol.file.allow", "always"]);

        // The sentinel config file/dir above live directly under the repo
        // root (so `git init`'s own GIT_CONFIG_GLOBAL can find them before
        // any working-tree state exists), which means a plain repo
        // otherwise has no working tree contents. Exclude them locally
        // (not via a committed .gitignore, which would itself be a
        // surprising extra tracked file) so they never appear as untracked
        // noise in `git status`.
        if let Some(git_dir) = Self::git_dir_for(&fixture.root, init_args) {
            let exclude_path = git_dir.join("info").join("exclude");
            if let Some(parent) = exclude_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let sentinel_names = ".rusty-test-empty-gitconfig\n.rusty-test-empty-hooks\n";
            std::fs::write(&exclude_path, sentinel_names).expect("failed to write .git/info/exclude");
        }

        fixture
    }

    fn git_dir_for(root: &Root, init_args: &[&str]) -> Option<PathBuf> {
        if init_args.contains(&"--bare") {
            // A bare repo IS its own git dir; it has no separate working
            // tree, so there is nothing to hide sentinel files from.
            None
        } else {
            Some(root.path().join(".git"))
        }
    }

    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        self.root.path()
    }

    pub fn path_str(&self) -> String {
        self.root.path().to_string_lossy().into_owned()
    }

    fn base_command(&self) -> Command {
        let mut cmd = Command::new("git");
        cmd.current_dir(self.root.path())
            .env("GIT_CONFIG_GLOBAL", &self.empty_config)
            .env("GIT_CONFIG_SYSTEM", &self.empty_config)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", "Rusty Test")
            .env("GIT_AUTHOR_EMAIL", "test@rusty.invalid")
            .env("GIT_COMMITTER_NAME", "Rusty Test")
            .env("GIT_COMMITTER_EMAIL", "test@rusty.invalid")
            // Frozen dates keep relative-date output (%cr) and, transitively,
            // commit SHAs stable across runs and machines.
            .env("GIT_AUTHOR_DATE", "2020-01-01T00:00:00+0000")
            .env("GIT_COMMITTER_DATE", "2020-01-01T00:00:00+0000")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE");
        cmd
    }

    /// Runs a git command, returning its raw `Output` without asserting
    /// success -- the escape hatch for tests that need to inspect failure.
    pub fn git(&self, args: &[&str]) -> Output {
        self.base_command()
            .args(args)
            .output()
            .unwrap_or_else(|e| panic!("failed to spawn git {:?}: {}", args, e))
    }

    /// Runs a git command and asserts it succeeded, returning trimmed stdout.
    pub fn git_ok(&self, args: &[&str]) -> String {
        let output = self.git(args);
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    pub fn write(&self, rel: &str, contents: &str) -> &Self {
        let target = self.root.path().join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("failed to create parent dir for fixture file");
        }
        std::fs::write(&target, contents).expect("failed to write fixture file");
        self
    }

    #[allow(dead_code)]
    pub fn remove(&self, rel: &str) -> &Self {
        std::fs::remove_file(self.root.path().join(rel)).expect("failed to remove fixture file");
        self
    }

    pub fn add(&self, rel: &str) -> &Self {
        self.git_ok(&["add", "--", rel]);
        self
    }

    #[allow(dead_code)]
    pub fn add_all(&self) -> &Self {
        self.git_ok(&["add", "-A"]);
        self
    }

    /// Commits currently staged changes and returns the full commit SHA.
    pub fn commit(&self, message: &str) -> String {
        self.git_ok(&["commit", "-m", message, "--allow-empty"]);
        self.git_ok(&["rev-parse", "HEAD"])
    }

    /// Convenience: write a file, stage it, and commit in one call.
    pub fn commit_file(&self, rel: &str, contents: &str, message: &str) -> String {
        self.write(rel, contents);
        self.add(rel);
        self.commit(message)
    }

    #[allow(dead_code)]
    pub fn branch(&self, name: &str) -> &Self {
        self.git_ok(&["branch", name]);
        self
    }

    #[allow(dead_code)]
    pub fn checkout(&self, rev: &str) -> &Self {
        self.git_ok(&["checkout", rev]);
        self
    }

    pub fn detach_to(&self, rev: &str) -> &Self {
        self.git_ok(&["checkout", "--detach", rev]);
        self
    }

    /// Adds `source` (another local repository) as a submodule at `rel`.
    ///
    /// Passes `-c protocol.file.allow=always` directly on this invocation --
    /// verified against git 2.45.0 that the *local* `protocol.file.allow`
    /// config `init_at()` sets (which governs every other git operation this
    /// fixture performs) is NOT consulted for a submodule clone; only a
    /// `-c` flag on the invoking command line (or global/system config,
    /// both of which this harness deliberately blocks) satisfies the file-
    /// transport check here. The original doc comment claiming local config
    /// was sufficient was wrong and untested (this method was `#[allow(dead_code)]`
    /// until PR 5 commit 1 first exercised it).
    pub fn add_submodule(&self, source: &Path, rel: &str) -> &Self {
        self.git_ok(&["-c", "protocol.file.allow=always", "submodule", "add", &source.to_string_lossy(), rel]);
        self
    }

    /// Adds a linked worktree at `rel` (inside this fixture's own temp
    /// directory, so cleanup stays owned by this fixture), checked out onto
    /// a new branch `branch`. Returns a fixture wrapping the worktree's own
    /// path -- its `.git` is a *file* pointing back at the main repository's
    /// `.git/worktrees/<name>`, exactly the "`.git` file" case PR 5's
    /// repository discovery must handle without special-casing.
    pub fn add_linked_worktree(&self, rel: &str, branch: &str) -> GitFixture {
        let worktree_path = self.root.path().join(rel);
        self.git_ok(&[
            "worktree",
            "add",
            "-b",
            branch,
            &worktree_path.to_string_lossy(),
        ]);
        GitFixture {
            root: Root::Nested(worktree_path),
            empty_config: self.empty_config.clone(),
            empty_hooks_dir: self.empty_hooks_dir.clone(),
        }
    }
}

/// Smoke tests for the fixture builders themselves (not any git.rs
/// production behavior -- that's tests.rs's job, from PR 5 commit 4 onward).
/// PR 5 commit 1: proves init_bare/add_submodule/add_linked_worktree, which
/// were written ahead of the production code that will consume them, are
/// mechanically sound before anything depends on them.
#[cfg(test)]
mod smoke_tests {
    use super::GitFixture;

    #[test]
    fn init_bare_creates_a_bare_repository_with_no_working_tree() {
        let bare = GitFixture::init_bare();
        // A bare repo's own root IS its git dir -- HEAD lives directly under it.
        assert!(std::path::Path::new(&bare.path_str()).join("HEAD").exists());
    }

    #[test]
    fn add_submodule_registers_gitmodules_and_checks_out_the_submodule() {
        let source = GitFixture::init();
        source.commit_file("readme.md", "hi\n", "source initial commit");

        let parent = GitFixture::init();
        parent.commit_file("a.txt", "one\n", "parent initial commit");
        parent.add_submodule(std::path::Path::new(&source.path_str()), "sub");

        let gitmodules_path = std::path::Path::new(&parent.path_str()).join(".gitmodules");
        assert!(gitmodules_path.exists(), "expected .gitmodules to be created");
        let contents = std::fs::read_to_string(&gitmodules_path).unwrap();
        assert!(contents.contains("path = sub"));
        assert!(
            std::path::Path::new(&parent.path_str()).join("sub").join("readme.md").exists(),
            "expected the submodule to be checked out into the parent's working tree"
        );
    }

    #[test]
    fn add_linked_worktree_creates_a_git_file_pointing_back_at_the_main_repository() {
        let main = GitFixture::init();
        main.commit_file("a.txt", "one\n", "initial commit");
        let worktree = main.add_linked_worktree("wt", "feature");

        let dot_git = std::path::Path::new(&worktree.path_str()).join(".git");
        assert!(dot_git.is_file(), "a linked worktree's .git must be a FILE, not a directory");
        let contents = std::fs::read_to_string(&dot_git).unwrap();
        assert!(contents.starts_with("gitdir:"), "expected a `gitdir: <path>` pointer, got: {contents}");
    }

    #[test]
    fn nested_submodule_is_reachable_via_the_outer_submodules_own_working_tree() {
        // A submodule of a submodule: composed from existing helpers rather
        // than a dedicated method, since it's just add_submodule applied
        // twice at different levels.
        let innermost = GitFixture::init();
        innermost.commit_file("leaf.md", "leaf\n", "innermost initial commit");

        let middle = GitFixture::init();
        middle.commit_file("a.txt", "one\n", "middle initial commit");
        middle.add_submodule(std::path::Path::new(&innermost.path_str()), "inner");
        middle.git_ok(&["commit", "-m", "add inner submodule"]);

        let outer = GitFixture::init();
        outer.commit_file("a.txt", "one\n", "outer initial commit");
        outer.add_submodule(std::path::Path::new(&middle.path_str()), "outer-sub");
        // `submodule add` clones "middle" but does not recursively check out
        // ITS OWN submodule ("inner") -- a plain clone never follows
        // gitlinks. `--init --recursive` is what actually populates nested
        // submodule content, which is the scenario PR 5 commit 5's
        // "nested submodules" fixture test needs to exist against.
        // `-c protocol.file.allow=always` is passed explicitly (not just
        // relying on outer's own local config) because the second-level
        // clone (of "inner") runs inside "outer-sub", a fresh submodule
        // checkout with no local config of its own -- the top-level `-c`
        // flag applies to the whole recursive operation regardless.
        outer.git_ok(&["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);

        let nested_leaf = std::path::Path::new(&outer.path_str())
            .join("outer-sub")
            .join("inner")
            .join("leaf.md");
        assert!(
            nested_leaf.exists(),
            "expected the nested submodule's file to be reachable through the outer submodule's checkout"
        );
    }
}
