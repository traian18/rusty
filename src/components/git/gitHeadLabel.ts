import type { GitHeadState } from "../../store/types";

/**
 * Human-readable label for a repository's real HEAD state
 * (REFACTOR_PLAN.md PR 5b commits 18 and 22), replacing every place the UI
 * used to guess with `gitStatus.currentBranch || "detached"` -- which
 * collapsed a genuinely detached HEAD and a freshly-initialized repo with
 * no commits yet into the same guessed word.
 */
export function formatHeadLabel(head: GitHeadState): string {
  if (head.mode === "branch") return head.branch ?? "unknown";
  if (head.mode === "detached") return `detached @ ${head.oid?.slice(0, 7) ?? "?"}`;
  return "unborn";
}

/**
 * True when `head` isn't on a named branch. Actions that only make sense
 * relative to "the current branch" -- merging or rebasing it, pushing or
 * pulling it -- have no meaning in this state and should be disabled with
 * an explanation (PR 5b commit 22) rather than silently failing against
 * the backend.
 */
export function isDetachedOrUnborn(head: GitHeadState): boolean {
  return head.mode !== "branch";
}

/** A short explanation for why branch-only actions are disabled, suitable
 * for a tooltip/title attribute. */
export function branchOnlyActionsDisabledReason(head: GitHeadState): string {
  return head.mode === "unborn"
    ? "This repository has no commits yet."
    : "HEAD is detached (not on a branch).";
}
