import { create } from "zustand";
import type { WorkspaceSliceCreator } from "../store/sliceTypes";
import type { WorkspaceState } from "../store/types";

/**
 * Unlike the other *TestStore.ts factories, this one takes the slice
 * creator as a parameter rather than importing createMetricsSlice
 * statically. createMetricsSlice.ts guards its usage-update subscription
 * with module-level state -- a deliberate, true process-wide singleton
 * (agentHarnessClient itself is one too) -- so a test that needs to see an
 * unsubscribed slice re-imports the module fresh via vi.resetModules() +
 * a dynamic import, and hands the resulting creator to this factory.
 */
export function createMetricsTestStore(
  createMetricsSlice: WorkspaceSliceCreator,
  overrides: Partial<WorkspaceState> = {},
) {
  return create<WorkspaceState>()((...args) => ({
    // loadMetricsSummary reads rootPath via get().
    rootPath: "",
    ...createMetricsSlice(...args),
    ...overrides,
  }) as unknown as WorkspaceState);
}
