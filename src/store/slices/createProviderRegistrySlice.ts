import type { WorkspaceSliceCreator } from "../sliceTypes";

/**
 * The integration registry (REFACTOR_PLAN.md PR 3b): one global map of
 * provider status, so every application surface reads the same settled
 * provider/model/authentication/quota/error state instead of each owning a
 * private copy (today: three useManagedProviderStatus polls and a
 * connectionStatus map inside LlmSetupTab, a separate quotas cache inside
 * ProviderQuotaControl, neither reachable outside its own component).
 *
 * No consumers yet. The out-of-React coordinator that actually populates
 * this via sidecar checks lands in a later commit; this slice only holds
 * what it's given, exactly like createStartupSlice's own precedent (PR
 * 3a) -- the slice never decides WHEN to transition, only stores the
 * caller's decision.
 *
 * `patchProviderStatus` merges into one provider's existing entry rather
 * than replacing it outright, so (for example) a quota update doesn't have
 * to carry forward that provider's unrelated auth fields, and a coordinator
 * write that arrives after a more recent one can be merged without the
 * caller reconstructing the whole entry.
 */
export const createProviderRegistrySlice: WorkspaceSliceCreator = (set) => ({
  providerStatus: {},

  setProviderStatus: (id, entry) => set((state) => ({
    providerStatus: { ...state.providerStatus, [id]: entry },
  })),

  patchProviderStatus: (id, patch) => set((state) => ({
    providerStatus: {
      ...state.providerStatus,
      [id]: { ...(state.providerStatus[id] ?? { kind: "unknown" }), ...patch },
    },
  })),
});
