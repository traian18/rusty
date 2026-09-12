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
 * Deliberately does NOT import the composed src/store.ts. As of
 * REFACTOR_PLAN.md PR 3a's slice import-time purity fixes, that graph no
 * longer THROWS at import time under a bare node environment (verified
 * directly) or opens a websocket at import time either -- but composing only
 * the slices under test is still the right call for test isolation: a
 * narrower module graph with no incidental coupling to
 * agentHarnessClient/secureStorageService/Tauri's invoke. Testing the
 * tab/editor behavior should not require standing up (or mocking) any of
 * that, whether or not it happens to be safe to import.
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
