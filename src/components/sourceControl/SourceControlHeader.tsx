import React from "react";
import { GitBranch, GitCommit, RotateCcw, ChevronDown } from "lucide-react";
import type { GitStatusResult } from "../../store/types";
import { GitBranchManager } from "../git/GitBranchManager";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface RepoSelectorProps {
  subprojects: string[];
  activeRepo: string;
  rootPath: string;
  onRepoChange: (repo: string) => void;
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
  rootPath: string;
  gitStatus: GitStatusResult | null;
  /** The active repository's real HEAD label (REFACTOR_PLAN.md PR 5b
      commit 22) -- replaces the branch pill's old
      `gitStatus.currentBranch` read, which couldn't represent a detached
      or unborn HEAD correctly. */
  headLabel: string;
  disableBranchOnlyActions: boolean;
  branchOnlyActionsReason?: string;
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
          return (
            <option key={repo} value={repo}>
              {name}
            </option>
          );
        })}
      </select>
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
  rootPath,
  gitStatus,
  headLabel,
  disableBranchOnlyActions,
  branchOnlyActionsReason,
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
          onRepoChange={onRepoChange}
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
