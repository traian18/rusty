import { create } from "zustand";
import { createWorkspaceSlice } from "../store/slices/createWorkspaceSlice";
import { createUiSlice } from "../store/slices/createUiSlice";
import type { WorkspaceState } from "../store/types";

/**
 * Composes createWorkspaceSlice (owns revealFileInTree/expandedPaths) with
 * createUiSlice (owns drawerOpen/drawerView) -- the two sides of the reveal
 * handshake this pins. createWorkspaceSlice has no module-scope Tauri
 * import (verified: canvasHelpers.ts and the tabs/* modules it imports are
 * all pure/type-only at creation time), so this is safe under plain node,
 * same reasoning as tabTestStore.ts's for its two slices.
 *
 * revealFileInTree does call `get()` for nothing itself, but other
 * createWorkspaceSlice actions (setRootPath, resetForBranchChange) reach
 * into slices this store doesn't compose (loadGitStatus, loadSkills, ...).
 * Don't call those from a test built on this store.
 */
export function createRevealHandshakeTestStore(overrides: Partial<WorkspaceState> = {}) {
  return create<WorkspaceState>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createUiSlice(...args),
    ...overrides,
  }) as unknown as WorkspaceState);
}
