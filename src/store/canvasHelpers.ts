import type { TabInstance } from "../tabs/types";
import type { CanvasContext, CanvasHistory, CanvasHistorySnapshot, WorkspaceState } from "./types";

/**
 * The minimum shape these helpers need. Deliberately structural rather than
 * `WorkspaceState`: several callers pass a synthetic `{ ...state, canvasContexts }`
 * while computing an update, and widening the parameter is what keeps those
 * call sites working unchanged.
 */
export interface CanvasTabLookupState {
  tabs: TabInstance[];
  activeTabId: string | null;
  canvasContexts: Record<string, CanvasContext>;
  canvasHistories?: Record<string, CanvasHistory>;
}

const RECONCILIATION_STREAM_PREFIX = "__reconciliation__:";
export const MAX_CANVAS_HISTORY = 50;

export const createEmptyCanvasContext = (): CanvasContext => ({
  nodes: [],
  edges: [],
  nodeLogs: {},
  nodeStatus: {},
  globalChatHistory: {},
  edgeReconciliationStatus: {},
  isPipelineApplied: false,
  contextNodesHidden: false,
  contextRevealedTasks: [],
});

export function getActiveCanvasTabId(state: CanvasTabLookupState): string {
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (activeTab?.type === "canvas") return activeTab.id;
  const firstCanvas = state.tabs.find((tab) => tab.type === "canvas");
  if (firstCanvas) return firstCanvas.id;
  // `setRootPath` seeds `canvasContexts.canvas`, so this keeps canvas actions
  // addressable even with no canvas tab open.
  return "canvas";
}

export function getOrCreateContext(state: CanvasTabLookupState, tabId: string): CanvasContext {
  if (!state.canvasContexts) state.canvasContexts = {};
  if (!state.canvasContexts[tabId]) {
    state.canvasContexts[tabId] = createEmptyCanvasContext();
  }
  return state.canvasContexts[tabId];
}

export const canvasHasGlobalChatNode = (state: CanvasTabLookupState, tabId: string): boolean =>
  state.canvasContexts[tabId]?.nodes.some((node) => node.type === "globalChatNode") ?? false;

export function findTabIdByNodeId(state: CanvasTabLookupState, nodeId: string): string {
  if (nodeId.startsWith(RECONCILIATION_STREAM_PREFIX)) {
    const tabId = nodeId.slice(RECONCILIATION_STREAM_PREFIX.length);
    if (state.canvasContexts?.[tabId]) return tabId;
  }
  for (const [tabId, context] of Object.entries(state.canvasContexts || {})) {
    if (context.nodes?.some((node) => node.id === nodeId)) return tabId;
  }
  return getActiveCanvasTabId(state);
}

export function findTabIdByEdgeId(state: CanvasTabLookupState, edgeId: string): string {
  for (const [tabId, context] of Object.entries(state.canvasContexts || {})) {
    if (context.edges?.some((edge) => edge.id === edgeId)) return tabId;
  }
  return getActiveCanvasTabId(state);
}

function pushHistoryToState(
  state: CanvasTabLookupState,
  tabId: string,
  snapshot: CanvasHistorySnapshot,
): Record<string, CanvasHistory> {
  const existing = state.canvasHistories?.[tabId] || { past: [], future: [] };
  const past = [...existing.past, snapshot];
  if (past.length > MAX_CANVAS_HISTORY) past.shift();
  return { ...state.canvasHistories, [tabId]: { past, future: [] } };
}

export function updateContextAndSync(
  state: CanvasTabLookupState,
  tabId: string,
  updater: (context: CanvasContext) => Partial<CanvasContext>,
  trackHistory = false,
): Partial<WorkspaceState> {
  const context = getOrCreateContext(state, tabId);
  const updates = updater(context);
  const shouldResetApplied = ("nodes" in updates || "edges" in updates)
    && !("isPipelineApplied" in updates);
  const canvasContexts = {
    ...state.canvasContexts,
    [tabId]: {
      ...context,
      ...updates,
      ...(shouldResetApplied ? { isPipelineApplied: false } : {}),
    },
  };
  const activeContext = canvasContexts[getActiveCanvasTabId({ ...state, canvasContexts })]
    || createEmptyCanvasContext();

  return {
    canvasContexts,
    canvasHistories: trackHistory
      ? pushHistoryToState(state, tabId, { nodes: context.nodes, edges: context.edges })
      : state.canvasHistories,
    nodes: activeContext.nodes,
    edges: activeContext.edges,
    nodeLogs: activeContext.nodeLogs,
    nodeStatus: activeContext.nodeStatus,
    globalChatHistory: activeContext.globalChatHistory,
    edgeReconciliationStatus: activeContext.edgeReconciliationStatus,
  };
}

/**
 * Republishes the active canvas's data to the top-level alias fields.
 *
 * Reads without creating: this used to call `getOrCreateContext`, which
 * MUTATES `state.canvasContexts` in place, so merely opening a file tab
 * silently materialized an empty `canvasContexts.canvas` entry. The canvas
 * actions that genuinely need creation still call `getOrCreateContext`
 * directly.
 */
export function syncActiveCanvasAliases(state: CanvasTabLookupState): Partial<WorkspaceState> {
  const context =
    state.canvasContexts[getActiveCanvasTabId(state)] ?? createEmptyCanvasContext();
  return {
    nodes: context.nodes,
    edges: context.edges,
    nodeLogs: context.nodeLogs,
    nodeStatus: context.nodeStatus,
    globalChatHistory: context.globalChatHistory,
    edgeReconciliationStatus: context.edgeReconciliationStatus,
  };
}

/**
 * Applies a tab-state update and re-syncs the canvas aliases, so activating or
 * closing a canvas tab swaps the visible graph. Lives here rather than in the
 * tabs slice because the aliasing is a canvas concern.
 */
export function withActiveCanvas(
  state: WorkspaceState,
  updates: Partial<WorkspaceState>,
): Partial<WorkspaceState> {
  const nextState = { ...state, ...updates } as WorkspaceState;
  return { ...updates, ...syncActiveCanvasAliases(nextState) };
}
