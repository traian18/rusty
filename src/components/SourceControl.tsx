import React, { useState, useEffect, useRef, useCallback } from "react";
import { useWorkspaceStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { gitPresenter } from "./git/GitPresenter";
import { gitErrorMessage } from "./git/gitErrors";
import { notify } from "../notificationStore";
import { useConfirm } from "./useConfirm";
import { buildUnstagedList } from "./sourceControl/sourceControlHelpers";
import SourceControlHeader from "./sourceControl/SourceControlHeader";
import SourceControlCommitBox from "./sourceControl/SourceControlCommitBox";
import SourceControlChangeList from "./sourceControl/SourceControlChangeList";
import SourceControlHistory from "./sourceControl/SourceControlHistory";
import { GitFileContextMenu } from "./sourceControl/SourceControlContextMenu";
import {
  NoFolderEmptyState,
  NoGitRepoEmptyState,
} from "./sourceControl/SourceControlEmptyState";

// ─────────────────────────────────────────────────────────────
// SourceControl — Main Orchestrator
// ─────────────────────────────────────────────────────────────

/**
 * Sidebar panel that provides full Git source-control
 * functionality: staging, committing, branching, pulling,
 * pushing, diff viewing, and commit history.
 *
 * This component acts as the **smart container** — it owns all
 * state and side-effect logic, and delegates rendering to
 * presentational sub-components.
 */
const SourceControl: React.FC = () => {
  // ── Store ──────────────────────────────────────────────────
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const gitStatusSingleSlot = useWorkspaceStore((state) => state.gitStatus);
  const statusByRepositoryId = useWorkspaceStore((state) => state.statusByRepositoryId);
  const loadGitStatus = useWorkspaceStore((state) => state.loadGitStatus);
  const openTab = useWorkspaceStore((state) => state.openTab);
  const lastRename = useWorkspaceStore((state) => state.lastRename);
  const setLastRename = useWorkspaceStore((state) => state.setLastRename);
  const repositories = useWorkspaceStore((state) => state.repositories);
  const activeRepositoryId = useWorkspaceStore((state) => state.activeRepositoryId);
  const setActiveRepositoryId = useWorkspaceStore((state) => state.setActiveRepositoryId);
  const discoverRepositories = useWorkspaceStore((state) => state.discoverRepositories);

  // `activeRepo`/`subprojects` used to be local component state, populated
  // by the naive `scanSubprojects()` filesystem walk (REFACTOR_PLAN.md PR
  // 5b commit 16) -- both now derive from the store's Git-native
  // `repositories`/`activeRepositoryId`, which `discoverRepositories()`
  // populates below. `activeRepo` still resolves to a plain worktree path
  // string, since every call site below (gitPresenter, invoke, openTab)
  // takes a rootDir string, not a repository id.
  const activeRepository = repositories.find((repo) => repo.id === activeRepositoryId) ?? null;
  const activeRepo = activeRepository?.worktreePath ?? rootPath;
  const subprojects = repositories.map((repo) => repo.worktreePath);

  // Prefers the per-repository status (REFACTOR_PLAN.md PR 5b commit 21)
  // over the deprecated single-slot gitStatus -- the single slot gets
  // overwritten by *any* loadGitStatus() call anywhere in the app,
  // including ones scoped to a different repository (e.g. GitPresenter's
  // own post-action refresh, or another tab's unrelated workspace-wide
  // reload), so it could show another repository's status for whatever
  // moment such a call landed. Falls back to it only when this repository's
  // own entry hasn't been loaded into statusByRepositoryId yet.
  const gitStatus =
    (activeRepositoryId && statusByRepositoryId[activeRepositoryId]) || gitStatusSingleSlot;

  // ── Local State ────────────────────────────────────────────
  const [commitMsg, setCommitMsg] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [initLoading, setInitLoading] = useState(false);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(true);
  const [historyCommits, setHistoryCommits] = useState<any[]>([]);
  const [showBranchPopover, setShowBranchPopover] = useState(false);
  const [fileContextMenu, setFileContextMenu] = useState<{
    x: number;
    y: number;
    file: any;
  } | null>(null);

  /** Used to ignore stale fetch responses after a fast branch mutation. */
  const branchLoadIdRef = useRef(0);

  const { confirm, ConfirmModalComponent } = useConfirm();

  // ── Derived Data ───────────────────────────────────────────
  const unstagedList = buildUnstagedList(gitStatus, lastRename);
  const modifiedList = unstagedList.filter(
    (file) => file.status_type !== "untracked",
  );
  const untrackedList = unstagedList.filter(
    (file) => file.status_type === "untracked",
  );
  const totalChanges =
    (gitStatus?.staged.length || 0) + unstagedList.length;

  // ── Effects ────────────────────────────────────────────────

  /** Discover Git repositories (workspace root, linked worktrees,
      submodules) when rootPath changes. */
  useEffect(() => {
    if (!rootPath) return;
    discoverRepositories();
  }, [rootPath, discoverRepositories]);

  /** Fetch local and remote branches from the Tauri backend. */
  const loadBranches = useCallback(
    async (rootDir: string, fetchRemote = true): Promise<void> => {
      if (!rootDir) return;

      const loadId = ++branchLoadIdRef.current;

      try {
        if (fetchRemote) {
          try {
            await invoke("git_fetch", { rootDir });
          } catch (e) {
            console.warn(
              "Failed to refresh remote branches; using local refs:",
              e,
            );
          }
        }

        const res: { local: string[]; remote: string[] } = await invoke(
          "git_get_all_branches",
          { rootDir },
        );
        if (loadId !== branchLoadIdRef.current) return;
        setLocalBranches(res.local || []);
        setRemoteBranches(res.remote || []);
      } catch (e) {
        console.warn("Failed to load branches for current repo:", e);
      }
    },
    [],
  );

  /** Reload Git status, branches, and commit history when switching repos. */
  const loadRepoData = useCallback(async (): Promise<void> => {
    if (!activeRepo) return;

    try {
      await loadGitStatus(activeRepo);

      try {
        const history: any[] = await invoke("git_get_commit_history", {
          rootDir: activeRepo,
        });
        setHistoryCommits(history.slice(0, 15));
      } catch (e) {
        console.warn("Failed to load history commits for current repo:", e);
      }

      await loadBranches(activeRepo);
    } catch (err) {
      console.error("Failed to load repo data:", err);
    }
  }, [activeRepo, loadGitStatus, loadBranches]);

  /** React to activeRepo changes. */
  useEffect(() => {
    branchLoadIdRef.current += 1;
    setLocalBranches([]);
    setRemoteBranches([]);
    loadRepoData();
  }, [activeRepo, loadRepoData]);

  /** Close file context menu when clicking outside. */
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-context-menu]")) return;
      setFileContextMenu(null);
    };

    if (fileContextMenu) {
      document.addEventListener("mousedown", handleOutsideClick);
      return () => document.removeEventListener("mousedown", handleOutsideClick);
    }
  }, [fileContextMenu]);

  // ── Event Handlers ────────────────────────────────────────

  /** Open the full commit graph tab. */
  const handleOpenGraph = useCallback((): void => {
    openTab({
      type: "git-history",
      repoPath: activeRepo,
    });
  }, [openTab, activeRepo]);

  /** Initialise a Git repository in the current folder. */
  const handleInitializeRepo = useCallback(async (): Promise<void> => {
    setInitLoading(true);
    try {
      console.log(`Git: Initializing repository at ${activeRepo}`);
      await invoke("git_init", { rootDir: activeRepo });
      await loadRepoData();
    } catch (err: any) {
      console.error("Failed to initialize git repository:", err);
      notify("Error", `Error initializing Git: ${gitErrorMessage(err)}`, "error");
    } finally {
      setInitLoading(false);
    }
  }, [activeRepo, loadRepoData]);

  /** Commit all staged changes. */
  const handleCommit = useCallback(
    async (e?: React.FormEvent): Promise<void> => {
      if (e) e.preventDefault();
      if (!commitMsg.trim() || isCommitting || !gitStatus) return;

      if (gitStatus.staged.length === 0) {
        notify(
          "Nothing to commit",
          "Please stage your changes before committing.",
          "info",
        );
        return;
      }

      setIsCommitting(true);
      try {
        await gitPresenter.commit(activeRepo, commitMsg);
        setCommitMsg("");
        await loadRepoData();
      } catch (err) {
        console.error(err);
      } finally {
        setIsCommitting(false);
      }
    },
    [activeRepo, commitMsg, gitStatus, isCommitting, loadRepoData],
  );

  /** Pull latest changes from the remote. */
  const handlePull = useCallback(async (): Promise<void> => {
    if (!activeRepo || isPulling) return;
    setIsPulling(true);
    try {
      await gitPresenter.pull(activeRepo);
      await loadRepoData();
    } catch (err) {
      console.error(err);
    } finally {
      setIsPulling(false);
    }
  }, [activeRepo, isPulling, loadRepoData]);

  /** Push local commits to the remote. */
  const handlePush = useCallback(async (): Promise<void> => {
    if (!activeRepo || !gitStatus || isPushing) return;
    setIsPushing(true);
    try {
      await gitPresenter.push(activeRepo, gitStatus.currentBranch);
      await loadRepoData();
    } catch (err) {
      console.error(err);
    } finally {
      setIsPushing(false);
    }
  }, [activeRepo, gitStatus, isPushing, loadRepoData]);

  /** Stage a single file. */
  const handleStageFile = useCallback(
    async (e: React.MouseEvent, filePath: string): Promise<void> => {
      e.stopPropagation();
      try {
        await gitPresenter.stageFile(activeRepo, filePath);
        await loadRepoData();
      } catch (err) {
        console.error(err);
      }
    },
    [activeRepo, loadRepoData],
  );

  /** Unstage a single file. */
  const handleUnstageFile = useCallback(
    async (e: React.MouseEvent, filePath: string): Promise<void> => {
      e.stopPropagation();
      try {
        await gitPresenter.unstageFile(activeRepo, filePath);
        await loadRepoData();
      } catch (err) {
        console.error(err);
      }
    },
    [activeRepo, loadRepoData],
  );

  /** Add a file to .gitignore. */
  const handleAddToGitignore = useCallback(
    async (filePath: string): Promise<void> => {
      try {
        await gitPresenter.addToGitignore(activeRepo, filePath);
        await loadRepoData();
      } catch (err) {
        console.error(err);
      }
    },
    [activeRepo, loadRepoData],
  );

  /** Show the right-click context menu for a file. */
  const handleFileContextMenu = useCallback(
    (e: React.MouseEvent, file: any): void => {
      e.preventDefault();
      e.stopPropagation();
      setFileContextMenu({ x: e.clientX, y: e.clientY, file });
    },
    [],
  );

  /** Discard all unstaged changes in a single file. */
  const handleDiscardChanges = useCallback(
    async (
      e: React.MouseEvent,
      filePath: string,
      fileName: string,
    ): Promise<void> => {
      e.stopPropagation();
      try {
        await gitPresenter.discardChanges(
          activeRepo,
          filePath,
          fileName,
          async (title, msg) => {
            return await confirm({
              title,
              message: msg,
              kind: "warning",
            });
          },
        );
        await loadRepoData();
      } catch (err) {
        console.error(err);
      }
    },
    [activeRepo, confirm, loadRepoData],
  );

  /** Discard all unstaged changes across the whole repo. */
  const handleDiscardAllChanges = useCallback(async (): Promise<void> => {
    try {
      await gitPresenter.discardAllChanges(
        activeRepo,
        async (title, msg) => {
          return await confirm({
            title,
            message: msg,
            kind: "danger",
          });
        },
      );
      await loadRepoData();
    } catch (err) {
      console.error(err);
    }
  }, [activeRepo, confirm, loadRepoData]);

  /** Checkout (switch to) a branch. */
  const handleCheckoutBranch = useCallback(
    async (branchName: string): Promise<void> => {
      try {
        await gitPresenter.switchBranch(activeRepo, branchName);
        await loadRepoData();
        setShowBranchPopover(false);
      } catch (err) {
        console.error(err);
      }
    },
    [activeRepo, loadRepoData],
  );

  /** Create a new branch and optionally check it out. */
  const handleCreateBranch = useCallback(
    async (branchName: string): Promise<void> => {
      try {
        await gitPresenter.createBranch(activeRepo, branchName, true);
        await loadRepoData();
        setShowBranchPopover(false);
      } catch (err) {
        console.error(err);
      }
    },
    [activeRepo, loadRepoData],
  );

  /** Delete a local or remote branch. */
  const handleDeleteBranch = useCallback(
    async (branchName: string, force: boolean): Promise<void> => {
      try {
        await gitPresenter.deleteBranch(activeRepo, branchName, force);

        // Reflect the successful mutation synchronously so an older
        // in-flight request cannot put the deleted row back.
        branchLoadIdRef.current += 1;
        if (branchName.startsWith("origin/")) {
          setRemoteBranches((branches) =>
            branches.filter((b) => b !== branchName),
          );
        } else {
          setLocalBranches((branches) =>
            branches.filter((b) => b !== branchName),
          );
        }
        await loadBranches(activeRepo, false);
      } catch (err) {
        console.error(err);
        throw err;
      }
    },
    [activeRepo, loadBranches],
  );

  /** Toggle the branch manager popover. */
  const handleBranchPopoverToggle = useCallback((): void => {
    const opening = !showBranchPopover;
    setShowBranchPopover(opening);
    if (opening) {
      void loadBranches(activeRepo);
    }
  }, [showBranchPopover, activeRepo, loadBranches]);

  /** Close the branch manager popover. */
  const handleCloseBranchPopover = useCallback((): void => {
    setShowBranchPopover(false);
  }, []);

  /** Merge a branch into the current branch. */
  const handleMergeBranch = useCallback(
    async (branchName: string): Promise<void> => {
      try {
        await gitPresenter.mergeBranch(activeRepo, branchName);
        await loadRepoData();
        setShowBranchPopover(false);
      } catch (err) {
        console.error(err);
      }
    },
    [activeRepo, loadRepoData],
  );

  /** Rebase the current branch onto another branch. */
  const handleRebaseBranch = useCallback(
    async (branchName: string): Promise<void> => {
      try {
        await gitPresenter.rebaseBranch(activeRepo, branchName);
        await loadRepoData();
        setShowBranchPopover(false);
      } catch (err) {
        console.error(err);
      }
    },
    [activeRepo, loadRepoData],
  );

  /** Abort a pending merge or rebase. */
  const handleAbortPending = useCallback(async (): Promise<void> => {
    try {
      await gitPresenter.abortPending(activeRepo);
      await loadRepoData();
    } catch (err) {
      console.error(err);
    }
  }, [activeRepo, loadRepoData]);

  /** Undo the last file rename / move. */
  const handleUndoRename = useCallback(async (): Promise<void> => {
    if (!lastRename) return;
    try {
      await gitPresenter.undoLastRename(
        activeRepo,
        lastRename.originalPath,
        lastRename.newPath,
      );
      setLastRename(null);
      await loadRepoData();
    } catch (err) {
      console.error(err);
    }
  }, [activeRepo, lastRename, setLastRename, loadRepoData]);

  /** Open the diff tab for a file. */
  const handleOpenFileDiff = useCallback(
    (
      filePath: string,
      _fileName: string,
      diffType: "staged" | "unstaged",
    ): void => {
      openTab({
        type: "git-diff",
        repoPath: activeRepo,
        path: filePath,
        diffType,
      });
    },
    [openTab, activeRepo],
  );

  /** Switch the active repository. */
  const handleRepoChange = useCallback(
    (repo: string): void => {
      const match = repositories.find((candidate) => candidate.worktreePath === repo);
      setActiveRepositoryId(match ? match.id : null);
    },
    [repositories, setActiveRepositoryId],
  );

  // ── Early Returns (Empty / Non-Repo States) ───────────────

  if (!rootPath) {
    return <NoFolderEmptyState />;
  }

  if (gitStatus && !gitStatus.isRepo) {
    return (
      <NoGitRepoEmptyState
        initLoading={initLoading}
        onInitialize={handleInitializeRepo}
      />
    );
  }

  // ── Main Render ───────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-[var(--bg-sidebar)] font-sans text-xs select-none relative">
      <SourceControlHeader
        subprojects={subprojects}
        activeRepo={activeRepo}
        rootPath={rootPath}
        gitStatus={gitStatus}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        showBranchPopover={showBranchPopover}
        onRepoChange={handleRepoChange}
        onOpenGraph={handleOpenGraph}
        onAbortPending={handleAbortPending}
        onToggleBranchPopover={handleBranchPopoverToggle}
        onCheckoutBranch={handleCheckoutBranch}
        onCreateBranch={handleCreateBranch}
        onDeleteBranch={handleDeleteBranch}
        onMergeBranch={handleMergeBranch}
        onRebaseBranch={handleRebaseBranch}
        onCloseBranchPopover={handleCloseBranchPopover}
      />

      {gitStatus && (
        <SourceControlCommitBox
          commitMsg={commitMsg}
          isCommitting={isCommitting}
          isPushing={isPushing}
          isPulling={isPulling}
          totalChanges={totalChanges}
          onCommitMsgChange={setCommitMsg}
          onCommit={handleCommit}
          onPull={handlePull}
          onPush={handlePush}
        />
      )}

      {gitStatus && (
        <SourceControlChangeList
          gitStatus={gitStatus}
          activeRepo={activeRepo}
          modifiedList={modifiedList}
          untrackedList={untrackedList}
          totalChanges={totalChanges}
          onStageFile={handleStageFile}
          onUnstageFile={handleUnstageFile}
          onDiscardChanges={handleDiscardChanges}
          onDiscardAllChanges={handleDiscardAllChanges}
          onAddToGitignore={handleAddToGitignore}
          onUndoRename={handleUndoRename}
          onOpenFileDiff={handleOpenFileDiff}
          onFileContextMenu={handleFileContextMenu}
        />
      )}

      {gitStatus && (
        <SourceControlHistory
          historyCommits={historyCommits}
          isExpanded={isHistoryExpanded}
          onToggleExpand={() => setIsHistoryExpanded((v) => !v)}
          onOpenGraph={handleOpenGraph}
        />
      )}

      {ConfirmModalComponent}

      {fileContextMenu && (
        <GitFileContextMenu
          x={fileContextMenu.x}
          y={fileContextMenu.y}
          file={fileContextMenu.file}
          onAddToGit={async () => {
            setFileContextMenu(null);
            try {
              await gitPresenter.stageFile(
                activeRepo,
                fileContextMenu.file.path,
              );
              await loadRepoData();
            } catch (err) {
              console.error(err);
            }
          }}
          onAddToGitignore={() => {
            setFileContextMenu(null);
            handleAddToGitignore(fileContextMenu.file.path);
          }}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────

export { SourceControl };
