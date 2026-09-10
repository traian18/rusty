import { create } from "zustand";
import { createAgentSlice } from "../store/slices/createAgentSlice";
import { createTabsSlice } from "../store/slices/createTabsSlice";
import type { WorkspaceState } from "../store/types";

/**
 * Composes only the tab-related slices that are dependency-free at creation
 * time: createTabsSlice imports the pure tab registry plus ../canvasHelpers,
 * and createAgentSlice imports nothing at all. Neither touches Tauri's
 * `invoke`, localStorage, or agentHarnessClient.
 *
 * Deliberately does NOT import the composed src/store.ts: that graph throws
 * at import time under a bare node environment (createIntegrationSlice.ts
 * calls loadStoredThemeId() -> localStorage.getItem with no guard) and, even
 * under jsdom, would open a websocket via createMetricsSlice's
 * agentHarnessClient.subscribeAll(). Testing the tab/editor behavior should
 * not require standing up (or mocking) any of that.
 *
 * The `as unknown as WorkspaceState` cast mirrors the one already at
 * src/store.ts:20 -- WorkspaceSliceCreator returns Partial<WorkspaceState>,
 * so a deliberate subset of slices can never satisfy the full interface
 * structurally. Nothing in createTabsSlice/createAgentSlice reads a field
 * outside the seed set below; that is itself an invariant these tests pin.
 *
 * No store-reset helper is provided on purpose: each test builds a fresh
 * store via this factory, which sidesteps the fact that zustand's
 * `setState(x, true)` would wipe the action functions along with the data.
 */
export function createTabTestStore(overrides: Partial<WorkspaceState> = {}) {
  return create<WorkspaceState>()((...args) => ({
    // Seed the canvas alias fields every tab action touches via
    // withActiveCanvas -> syncActiveCanvasAliases.
    canvasContexts: {},
    canvasHistories: {},
    nodes: [],
    edges: [],
    nodeLogs: {},
    nodeStatus: {},
    globalChatHistory: {},
    edgeReconciliationStatus: {},

    // rootPath participates in file-tab identity resolution.
    rootPath: "",

    ...createTabsSlice(...args),
    ...createAgentSlice(...args),
    ...overrides,
  }) as unknown as WorkspaceState);
}
