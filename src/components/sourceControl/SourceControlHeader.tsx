import React from "react";
import { GitBranch, GitCommit, RotateCcw, ChevronDown, Boxes, Download, RefreshCw } from "lucide-react";
import type { GitRepository, GitStatusResult } from "../../store/types";
import { GitBranchManager } from "../git/GitBranchManager";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface RepoSelectorProps {
  subprojects: string[];
  activeRepo: string;
  rootPath: string;
  /** Looked up per-option purely to show its `kind` (REFACTOR_PLAN.md PR
      5b commit 23) -- the dropdown's own value/selection logic still keys
      off the plain worktree path strings in `subprojects`. */
  repositories: GitRepository[];
  onRepoChange: (repo: string) => void;
}

type SubmoduleActionKind = "init" | "update" | "sync";

interface SubmoduleActionsProps {
  repository: GitRepository;
  actionLoading: SubmoduleActionKind | null;
  onInit: () => void;
  onUpdate: () => void;
  onSync: () => void;
}

interface BranchWidgetProps {
  gitStatus: GitStatusResult;
  headLabel: string;
  disableBranchOnlyActions: boolean;
  branchOnlyActionsReason?: string;
  localBranches: string[];
  remoteBranches: string[];
  showBranchPopover: boolean;
  onTogglePopover: () => void;
  onCheckout: (branch: string) => Promise<void>;
  onCreateBranch: (branch: string) => Promise<void>;
  onDeleteBranch: (branch: string, force: boolean) => Promise<void>;
  onMergeBranch: (branch: string) => Promise<void>;
  onRebaseBranch: (branch: string) => Promise<void>;
  onClosePopover: () => void;
}

interface SourceControlHeaderProps {
  subprojects: string[];
  activeRepo: string;
  /** Every discovered repository -- RepoSelector looks up each option's
      `kind` from this (REFACTOR_PLAN.md PR 5b commit 23). */
  repositories: GitRepository[];
  /** Full record for the active repository, when discovered -- drives the
      kind display and submodule actions (REFACTOR_PLAN.md PR 5b commit
      23). Null before repositories has resolved. */
  activeRepository: GitRepository | null;
  rootPath: string;
  gitStatus: GitStatusResult | null;
  /** The active repository's real HEAD label (REFACTOR_PLAN.md PR 5b
      commit 22) -- replaces the branch pill's old
      `gitStatus.currentBranch` read, which couldn't represent a detached
      or unborn HEAD correctly. */
  headLabel: string;
  disableBranchOnlyActions: boolean;
  branchOnlyActionsReason?: string;
  submoduleActionLoading: SubmoduleActionKind | null;
  onInitSubmodule: () => void;
  onUpdateSubmodule: () => void;
  onSyncSubmodule: () => void;
  localBranches: string[];
  remoteBranches: string[];
  showBranchPopover: boolean;
  onRepoChange: (repo: string) => void;
  onOpenGraph: () => void;
  onAbortPending: () => Promise<void>;
  onToggleBranchPopover: () => void;
  onCheckoutBranch: (branch: string) => Promise<void>;
  onCreateBranch: (branch: string) => Promise<void>;
  onDeleteBranch: (branch: string, force: boolean) => Promise<void>;
  onMergeBranch: (branch: string) => Promise<void>;
  onRebaseBranch: (branch: string) => Promise<void>;
  onCloseBranchPopover: () => void;
}

// ─────────────────────────────────────────────────────────────
// Sub-Components
// ─────────────────────────────────────────────────────────────

/**
 * Dropdown that lets the user switch between the workspace root
 * and any discovered subproject repositories.
 */
const RepoSelector: React.FC<RepoSelectorProps> = ({
  subprojects,
  activeRepo,
  rootPath,
  repositories,
  onRepoChange,
}) => {
  return (
    <div className="px-4 py-2 border-b border-[var(--border-color)]/60 bg-[var(--color-surface-sunken)] flex items-center justify-between flex-shrink-0">
      <span className="text-[9px] font-mono text-[var(--text-muted)] uppercase font-semibold">
        Repository:
      </span>
      <select
        value={activeRepo}
        onChange={(e) => onRepoChange(e.target.value)}
        className="bg-[var(--bg-app)] border border-[var(--border-color)] text-[var(--text-normal)] rounded px-2 py-0.5 max-w-[170px] truncate text-[10px] font-mono focus:outline-none focus:border-[var(--accent-color)]"
      >
        {subprojects.map((repo) => {
          const name =
            repo === rootPath
              ? "[Workspace Root]"
              : repo.replace(`${rootPath}/`, "");
          // Kind display (REFACTOR_PLAN.md PR 5b commit 23) -- "workspace"
          // is the common case and stays unlabeled to match the previous
          // plain dropdown.
          const kind = repositories.find((candidate) => candidate.worktreePath === repo)?.kind;
          const suffix = kind && kind !== "workspace" ? ` (${kind})` : "";
          return (
            <option key={repo} value={repo}>
              {name}{suffix}
            </option>
          );
        })}
      </select>
    </div>
  );
};

/**
 * Init/update/sync actions for the active repository, shown only when it's
 * a discovered `kind: "submodule"` entry (REFACTOR_PLAN.md PR 5b commit
 * 23). Gitlink staging needs no button here -- a submodule's changed
 * checked-out commit already shows up as a modified path in the *parent*
 * repository's own change list, staged with the existing stage-file action
 * there (PR 5a #13's design decision).
 */
const SubmoduleActions: React.FC<SubmoduleActionsProps> = ({ repository, actionLoading, onInit, onUpdate, onSync }) => {
  const state = repository.submoduleState;
  const dirtyLabel = state
    ? [
        state.changedGitlink && "gitlink changed",
        state.modifiedWorktree && "modified",
        state.untrackedContent && "untracked",
      ].filter(Boolean).join(", ") || "clean"
    : null;

  return (
    <div className="px-4 py-2 border-b border-[var(--border-color)]/60 bg-[var(--color-surface-sunken)] flex items-center justify-between flex-shrink-0 flex-wrap gap-y-1">
      <span className="flex items-center space-x-1.5 text-[9px] font-mono text-[var(--text-muted)] uppercase font-semibold">
        <Boxes size={11} className="text-[var(--accent-color)]" />
        <span>Submodule{repository.initialized ? "" : " (uninitialized)"}{dirtyLabel ? `: ${dirtyLabel}` : ""}</span>
      </span>
      <div className="flex items-center space-x-1.5">
        {!repository.initialized && (
          <button
            type="button"
            onClick={onInit}
            disabled={actionLoading !== null}
            className="px-2 py-0.5 rounded border border-[var(--border-color)] hover:border-[var(--border-active)] text-[10px] font-mono text-[var(--text-normal)] disabled:opacity-50 cursor-pointer"
            title="Register the submodule locally without cloning it"
          >
            {actionLoading === "init" ? "Initializing…" : "Initialize"}
          </button>
        )}
        <button
          type="button"
          onClick={onUpdate}
          disabled={actionLoading !== null}
          className="flex items-center space-x-1 px-2 py-0.5 rounded border border-[var(--border-color)] hover:border-[var(--border-active)] text-[10px] font-mono text-[var(--text-normal)] disabled:opacity-50 cursor-pointer"
          title={repository.initialized ? "Clone/checkout the commit recorded by the parent" : "Clone and checkout this submodule"}
        >
          <Download size={10} />
          <span>{actionLoading === "update" ? "Updating…" : repository.initialized ? "Update" : "Clone"}</span>
        </button>
        {repository.initialized && (
          <button
            type="button"
            onClick={onSync}
            disabled={actionLoading !== null}
            className="flex items-center space-x-1 px-2 py-0.5 rounded border border-[var(--border-color)] hover:border-[var(--border-active)] text-[10px] font-mono text-[var(--text-normal)] disabled:opacity-50 cursor-pointer"
            title="Sync the submodule's local URL from .gitmodules"
          >
            <RefreshCw size={10} />
            <span>{actionLoading === "sync" ? "Syncing…" : "Sync"}</span>
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * The branch name pill that opens the Git branch manager popover,
 * plus the abort-merge/rebase button.
 */
const BranchWidget: React.FC<BranchWidgetProps> = ({
  gitStatus,
  headLabel,
  disableBranchOnlyActions,
  branchOnlyActionsReason,
  localBranches,
  remoteBranches,
  showBranchPopover,
  onTogglePopover,
  onCheckout,
  onCreateBranch,
  onDeleteBranch,
  onMergeBranch,
  onRebaseBranch,
  onClosePopover,
}) => {
  return (
    <div className="flex items-center space-x-1.5 relative">
      <button
        type="button"
        onClick={onTogglePopover}
        className="flex items-center space-x-1 bg-[var(--accent-bg)]/35 text-[var(--accent-color)] px-2 py-1 rounded font-mono text-[10px] border border-[var(--accent-color)]/25 hover:border-[var(--accent-color)]/50 transition-all cursor-pointer font-bold"
        title={disableBranchOnlyActions ? branchOnlyActionsReason : undefined}
      >
        <GitBranch size={10} className="flex-shrink-0 mr-1" />
        <span className="truncate max-w-[80px]">{headLabel}</span>
        <ChevronDown size={10} className="flex-shrink-0 opacity-60 ml-0.5" />
      </button>

      {showBranchPopover && (
        <GitBranchManager
          currentBranch={gitStatus.currentBranch}
          disableBranchOnlyActions={disableBranchOnlyActions}
          branchOnlyActionsReason={branchOnlyActionsReason}
          localBranches={localBranches}
          remoteBranches={remoteBranches}
          onCheckout={onCheckout}
          onCreateBranch={onCreateBranch}
          onDeleteBranch={onDeleteBranch}
          onMergeBranch={onMergeBranch}
          onRebaseBranch={onRebaseBranch}
          onClose={onClosePopover}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────

/**
 * Header bar for the Source Control panel.
 *
 * Renders the repository selector (when subprojects exist), the
 * panel title with graph button, the abort button, and the
 * branch widget with its popover manager.
 */
const SourceControlHeader: React.FC<SourceControlHeaderProps> = ({
  subprojects,
  activeRepo,
  repositories,
  activeRepository,
  rootPath,
  gitStatus,
  headLabel,
  disableBranchOnlyActions,
  branchOnlyActionsReason,
  submoduleActionLoading,
  onInitSubmodule,
  onUpdateSubmodule,
  onSyncSubmodule,
  localBranches,
  remoteBranches,
  showBranchPopover,
  onRepoChange,
  onOpenGraph,
  onAbortPending,
  onToggleBranchPopover,
  onCheckoutBranch,
  onCreateBranch,
  onDeleteBranch,
  onMergeBranch,
  onRebaseBranch,
  onCloseBranchPopover,
}) => {
  return (
    <>
      {subprojects.length > 1 && (
        <RepoSelector
          subprojects={subprojects}
          activeRepo={activeRepo}
          rootPath={rootPath}
          repositories={repositories}
          onRepoChange={onRepoChange}
        />
      )}

      {activeRepository?.kind === "submodule" && (
        <SubmoduleActions
          repository={activeRepository}
          actionLoading={submoduleActionLoading}
          onInit={onInitSubmodule}
          onUpdate={onUpdateSubmodule}
          onSync={onSyncSubmodule}
        />
      )}

      <div className="px-4 py-3 border-b border-[var(--border-color)] flex items-center justify-between flex-shrink-0 bg-[var(--color-surface-sunken)]">
        <div className="flex items-center space-x-2">
          <span className="font-bold text-[var(--text-light)] uppercase tracking-wider text-[10px] font-mono">
            Source Control
          </span>
          <button
            type="button"
            onClick={onOpenGraph}
            className="p-1 rounded hover:bg-[var(--border-color)]/60 text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors cursor-pointer"
            title="Open Commit Graph"
          >
            <GitCommit size={13} className="text-[var(--accent-color)]" />
          </button>
        </div>

        {gitStatus && (
          <div className="flex items-center space-x-1.5 relative">
            <button
              type="button"
              onClick={onAbortPending}
              className="p-1 rounded hover:bg-[var(--color-status-danger-bg)] text-[var(--text-muted)] hover:text-[var(--color-status-danger)] transition-colors cursor-pointer"
              title="Abort Merge/Rebase"
            >
              <RotateCcw size={12} />
            </button>

            <BranchWidget
              gitStatus={gitStatus}
              headLabel={headLabel}
              disableBranchOnlyActions={disableBranchOnlyActions}
              branchOnlyActionsReason={branchOnlyActionsReason}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              showBranchPopover={showBranchPopover}
              onTogglePopover={onToggleBranchPopover}
              onCheckout={onCheckoutBranch}
              onCreateBranch={onCreateBranch}
              onDeleteBranch={onDeleteBranch}
              onMergeBranch={onMergeBranch}
              onRebaseBranch={onRebaseBranch}
              onClosePopover={onCloseBranchPopover}
            />
          </div>
        )}
      </div>
    </>
  );
};

export default SourceControlHeader;
