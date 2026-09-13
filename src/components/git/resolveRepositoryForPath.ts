import type { GitRepository } from "../../store/types";

/**
 * Finds the most specific (deepest-nested) discovered repository that owns
 * `path` -- the shared lookup FileTab's blame (REFACTOR_PLAN.md PR 5b
 * commit 19, its first consumer) and NavigationRailPresenter's badge /
 * FileTree's per-node markers (commit 20) all need instead of assuming the
 * workspace root. Prefers the repository whose `worktreePath` is the
 * longest match, so a path inside a submodule resolves to the submodule
 * itself, not the parent workspace it also happens to be nested under.
 *
 * Returns null (letting the caller fall back to the workspace rootPath,
 * the pre-PR-5 behavior) when nothing matches -- most commonly because
 * `repositories` hasn't been discovered yet for this workspace.
 */
export function resolveRepositoryForPath(
  path: string | null | undefined,
  repositories: GitRepository[],
): GitRepository | null {
  if (!path) return null;
  let best: GitRepository | null = null;
  for (const repo of repositories) {
    const worktreePath = repo.worktreePath;
    if (path === worktreePath || path.startsWith(`${worktreePath}/`)) {
      if (!best || worktreePath.length > best.worktreePath.length) {
        best = repo;
      }
    }
  }
  return best;
}
