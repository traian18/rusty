import React from "react";
import { Check, ArrowDown, ArrowUp } from "lucide-react";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface SourceControlCommitBoxProps {
  commitMsg: string;
  isCommitting: boolean;
  isPushing: boolean;
  isPulling: boolean;
  totalChanges: number;
  /** True when HEAD isn't on a branch (detached, or no commits yet) --
      push/pull the "current branch" has no meaning then (REFACTOR_PLAN.md
      PR 5b commit 22). */
  disablePushPull?: boolean;
  disablePushPullReason?: string;
  onCommitMsgChange: (msg: string) => void;
  onCommit: (e?: React.FormEvent) => Promise<void>;
  onPull: () => Promise<void>;
  onPush: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

/**
 * Commit message textarea and submit button, plus pull / push
 * action buttons.
 *
 * Supports Cmd+Enter / Ctrl+Enter keyboard shortcut to commit.
 */
const SourceControlCommitBox: React.FC<SourceControlCommitBoxProps> = ({
  commitMsg,
  isCommitting,
  isPushing,
  isPulling,
  totalChanges,
  disablePushPull = false,
  disablePushPullReason,
  onCommitMsgChange,
  onCommit,
  onPull,
  onPush,
}) => {
  /** Handles the Cmd+Enter keyboard shortcut to trigger a commit. */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onCommit();
    }
  };

  return (
    <div className="p-3 border-b border-[var(--border-color)] flex-shrink-0 bg-[var(--color-surface-sunken)]">
      <form onSubmit={onCommit} className="space-y-2">
        <textarea
          placeholder="Commit message (Cmd+Enter to commit)"
          value={commitMsg}
          onChange={(e) => onCommitMsgChange(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-lg p-2 text-xs font-sans text-[var(--text-light)] focus:outline-none focus:border-[var(--border-active)] resize-none h-16 leading-relaxed select-text placeholder:text-[var(--text-muted)]"
          disabled={isCommitting || totalChanges === 0}
        />
        <button
          type="submit"
          disabled={isCommitting || !commitMsg.trim() || totalChanges === 0}
          className="w-full bg-[var(--accent-color)] hover:bg-[var(--accent-color)]/85 disabled:bg-[var(--border-color)] disabled:opacity-50 text-[var(--color-primary-foreground)] text-[11px] font-mono font-bold py-1.5 rounded-lg transition-all shadow-md flex items-center justify-center space-x-1.5 cursor-pointer glow-btn"
        >
          <Check size={12} />
          <span>{isCommitting ? "Committing..." : "Commit"}</span>
        </button>

        <div className="flex space-x-2">
          <button
            type="button"
            onClick={onPull}
            disabled={isCommitting || isPushing || isPulling || disablePushPull}
            className="flex-1 bg-[var(--bg-app)] border border-[var(--border-color)] hover:border-[var(--border-active)] hover:bg-[var(--bg-sidebar)] text-[var(--text-light)] text-[10px] font-mono font-bold py-1.5 rounded-lg transition-all flex items-center justify-center space-x-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            title={disablePushPull ? disablePushPullReason : "Pull changes from remote"}
          >
            <ArrowDown size={11} className={isPulling ? "animate-bounce" : ""} />
            <span>{isPulling ? "Pulling..." : "Pull"}</span>
          </button>
          <button
            type="button"
            onClick={onPush}
            disabled={isCommitting || isPushing || isPulling || disablePushPull}
            className="flex-1 bg-[var(--bg-app)] border border-[var(--border-color)] hover:border-[var(--border-active)] hover:bg-[var(--bg-sidebar)] text-[var(--text-light)] text-[10px] font-mono font-bold py-1.5 rounded-lg transition-all flex items-center justify-center space-x-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            title={disablePushPull ? disablePushPullReason : "Push changes to remote"}
          >
            <ArrowUp size={11} className={isPushing ? "animate-bounce" : ""} />
            <span>{isPushing ? "Pushing..." : "Push"}</span>
          </button>
        </div>
      </form>
    </div>
  );
};

export default SourceControlCommitBox;
