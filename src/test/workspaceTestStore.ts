import { create } from "zustand";
import { createWorkspaceSlice } from "../store/slices/createWorkspaceSlice";
import type { WorkspaceState } from "../store/types";

/**
 * Composes only createWorkspaceSlice, which has no module-scope Tauri
 * import (its imports -- canvasHelpers.ts and the tabs/* modules -- are
 * pure/type-only at creation time, same reasoning as tabTestStore.ts's for
 * its two slices). loadWorkspaceData/setRootPath call loadGitStatus/
 * loadSkills/loadMetricsSummary/saveSecureConfig via get(), which live in
 * OTHER slices (createGitSlice/createIntegrationSlice/createMetricsSlice) --
 * pass fakes for those via `overrides` rather than composing the real
 * slices, which would pull in Tauri invoke, secureStorageService, and
 * agentHarnessClient for no benefit to what this store's own tests check.
 */
export function createWorkspaceTestStore(overrides: Partial<WorkspaceState> = {}) {
  return create<WorkspaceState>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...overrides,
  }) as unknown as WorkspaceState);
}
