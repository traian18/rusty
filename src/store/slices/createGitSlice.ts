import { invoke } from "@tauri-apps/api/core";
import type { GitHeadState, GitRepository, GitStatusResult, SubmoduleState } from "../types";
import type { WorkspaceSliceCreator } from "../sliceTypes";

/** Shared by both the deprecated single-slot loader and the per-repository
    one below -- git_status's wire shape hasn't changed, only who calls it. */
function mapGitStatusResult(result: any): GitStatusResult {
  return {
    isRepo: result.is_repo,
    currentBranch: result.current_branch,
    staged: (result.staged || []).map((file: any) => ({
      path: file.path,
      name: file.name,
      status_type: file.status_type,
    })),
    unstaged: (result.unstaged || []).map((file: any) => ({
      path: file.path,
      name: file.name,
      status_type: file.status_type,
    })),
  };
}

function mapGitHeadState(head: any): GitHeadState {
  return { mode: head.mode, branch: head.branch ?? null, oid: head.oid ?? null };
}

function mapSubmoduleState(state: any): SubmoduleState | null {
  if (!state) return null;
  return {
    changedGitlink: state.changed_gitlink,
    modifiedWorktree: state.modified_worktree,
    untrackedContent: state.untracked_content,
  };
}

function mapGitRepository(raw: any): GitRepository {
  return {
    id: raw.id,
    worktreePath: raw.worktree_path,
    gitDir: raw.git_dir,
    kind: raw.kind,
    parentId: raw.parent_id ?? null,
    submodulePath: raw.submodule_path ?? null,
    initialized: raw.initialized,
    head: mapGitHeadState(raw.head),
    submoduleState: mapSubmoduleState(raw.submodule_state),
  };
}

export const createGitSlice: WorkspaceSliceCreator = (set, get) => ({
  gitStatus: null,
  repositories: [],
  statusByRepositoryId: {},
  activeRepositoryId: null,
  lastRename: null,

  setGitStatus: (gitStatus) => set({ gitStatus }),
  setActiveRepositoryId: (activeRepositoryId) => set({ activeRepositoryId }),
  setLastRename: (lastRename) => set({ lastRename }),

  loadGitStatus: async (rootDir) => {
    const rootPath = rootDir || get().rootPath;
    if (!rootPath) {
      set({ gitStatus: null });
      return;
    }
    try {
      const result: any = await invoke("git_status", { rootDir: rootPath });
      const status = mapGitStatusResult(result);
      set((state) => {
        // Opportunistically mirrors into the new per-repository bucket too
        // (REFACTOR_PLAN.md PR 5b commit 20), so consumers that have moved
        // onto statusByRepositoryId (NavigationRailPresenter's badge,
        // FileTree's markers) see real data as soon as *anything* still
        // calls this deprecated loader -- without this, statusByRepositoryId
        // would stay empty until every caller migrates to
        // loadRepositoryGitStatus, which hasn't happened yet. Only mirrors
        // when repositories has already resolved a match; silently a no-op
        // otherwise (e.g. right at startup, before discoverRepositories has
        // run) rather than guessing which repository this status belongs to.
        const matchingRepo = state.repositories.find((repo) => repo.worktreePath === rootPath);
        return {
          gitStatus: status,
          statusByRepositoryId: matchingRepo
            ? { ...state.statusByRepositoryId, [matchingRepo.id]: status }
            : state.statusByRepositoryId,
        };
      });
    } catch (error) {
      console.error("Failed to load git status:", error);
    }
  },

  discoverRepositories: async () => {
    const rootPath = get().rootPath;
    if (!rootPath) {
      set({ repositories: [], activeRepositoryId: null });
      return;
    }
    try {
      const [worktreesRaw, submodulesRaw] = await Promise.all([
        invoke<any[]>("git_discover_linked_worktrees", { rootDir: rootPath }),
        invoke<any[]>("git_discover_submodules", { rootDir: rootPath }),
      ]);
      // git_discover_linked_worktrees already includes the main worktree
      // (i.e. rootPath itself), so it alone covers the "workspace" entry --
      // no separate git_discover_repository call is needed here.
      const repositories = [...worktreesRaw, ...submodulesRaw].map(mapGitRepository);
      set((state) => {
        const activeStillPresent =
          state.activeRepositoryId && repositories.some((repo) => repo.id === state.activeRepositoryId);
        return {
          repositories,
          activeRepositoryId: activeStillPresent
            ? state.activeRepositoryId
            : repositories.find((repo) => repo.kind === "workspace")?.id ?? repositories[0]?.id ?? null,
        };
      });
    } catch (error) {
      console.error("Failed to discover git repositories:", error);
    }
  },

  loadRepositoryGitStatus: async (repositoryId) => {
    const repo = get().repositories.find((candidate) => candidate.id === repositoryId);
    if (!repo) return;
    try {
      const result: any = await invoke("git_status", { rootDir: repo.worktreePath });
      set((state) => ({
        statusByRepositoryId: { ...state.statusByRepositoryId, [repositoryId]: mapGitStatusResult(result) },
      }));
    } catch (error) {
      console.error(`Failed to load git status for repository ${repositoryId}:`, error);
    }
  },
});
