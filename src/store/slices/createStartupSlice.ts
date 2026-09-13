import type { WorkspaceSliceCreator } from "../sliceTypes";

/**
 * Holds the startup coordinator's live lifecycle state. No consumers yet
 * (REFACTOR_PLAN.md PR 3a commit 9) -- AppBootstrapBoundary is wired to call
 * setStartupState from runStartup's onStepSettled callback and its final
 * StartupResult (via startupStateFromResult) in a later commit, replacing
 * its current local useState-based status machine entirely.
 *
 * A single setter rather than one action per transition
 * (startupRunning/startupReady/...): the wiring logic that decides WHEN to
 * transition lives in the boundary, not in this slice: the slice only needs
 * to hold whatever state that caller hands it.
 */
export const createStartupSlice: WorkspaceSliceCreator = (set) => ({
  startupState: { status: "idle" },
  setStartupState: (startupState) => set({ startupState }),
});
