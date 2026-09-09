import { create } from "zustand";
import { createAgentSlice } from "../store/slices/createAgentSlice";
import { createEditorSlice } from "../store/slices/createEditorSlice";
import type { WorkspaceState } from "../store/types";

/**
 * Composes only the tab-related slices that are dependency-free at creation
 * time: createEditorSlice imports nothing but ../canvasHelpers and types, and
 * createAgentSlice imports nothing at all. Neither touches Tauri's `invoke`,
 * localStorage, or agentHarnessClient.
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
 * structurally. Nothing in createEditorSlice/createAgentSlice reads a field
 * outside the seed set below; that is itself an invariant these tests pin.
 *
 * No store-reset helper is provided on purpose: each test builds a fresh
 * store via this factory, which sidesteps the fact that zustand's
 * `setState(x, true)` would wipe the action functions along with the data.
 * This state shape (editorGroups/activeGroupId/groupSizes) is replaced
 * wholesale in PR 1, so a reset facility here would be short-lived.
 */
export function createTabTestStore(overrides: Partial<WorkspaceState> = {}) {
  return create<WorkspaceState>()((...args) => ({
    // Seed the canvas alias fields every editor-slice action can touch via
    // withActiveCanvas -> syncActiveCanvasAliases -> getOrCreateContext.
    // getOrCreateContext mutates canvasContexts in place when a tab id is
    // missing, so seeding it here keeps that mutation observable in tests
    // rather than accidentally masked by `undefined`.
    canvasContexts: {},
    canvasHistories: {},
    nodes: [],
    edges: [],
    nodeLogs: {},
    nodeStatus: {},
    globalChatHistory: {},
    edgeReconciliationStatus: {},

    ...createEditorSlice(...args),
    ...createAgentSlice(...args),
    ...overrides,
  }) as unknown as WorkspaceState);
}
