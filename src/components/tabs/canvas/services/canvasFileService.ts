import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../../../store";
import { selectTabById } from "../../../../store/tabSelectors";
import { persistenceOrchestrator } from "../../../../services/vfs";
import { reconciliationService } from "../../../../services/reconciliationService";

const AUTOSAVE_DEBOUNCE_MS = 1_500;
const AUTOSAVE_MIN_INTERVAL_MS = 5_000;
const saveQueues = new Map<string, Promise<void>>();
type AutoSaveState = {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  dirty: boolean;
  lastSavedAt: number;
  pendingPromise: Promise<string | null> | null;
  pendingResolve: ((value: string | null) => void) | null;
};
const autoSaveStates = new Map<string, AutoSaveState>();

const sanitizedCanvasName = (title: string) =>
  title.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase() || "untitled_pipeline";

const canvasDirectory = (rootPath: string) => `${rootPath}/.rusty/canvas`;

const canvasPath = (rootPath: string, fileName: string) =>
  `${canvasDirectory(rootPath)}/${fileName}.json`;

const enqueueSave = async <T,>(key: string, operation: () => Promise<T>): Promise<T> => {
  const previous = saveQueues.get(key) || Promise.resolve();
  let releaseQueue: () => void = () => {};
  const queueTail = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const currentQueue = previous.catch(() => {}).then(() => queueTail);
  saveQueues.set(key, currentQueue);

  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    releaseQueue();
    if (saveQueues.get(key) === currentQueue) saveQueues.delete(key);
  }
};

/** Find this canvas's existing file, or a free suffixed filename for a same-title canvas. */
const resolveCanvasFilePath = async (rootPath: string, title: string, tabId: string): Promise<string> => {
  const baseName = sanitizedCanvasName(title);
  for (let index = 1; index <= 10_000; index += 1) {
    const candidateName = index === 1 ? baseName : `${baseName}_${index}`;
    const candidatePath = canvasPath(rootPath, candidateName);
    try {
      const rawContent: string = await invoke("read_file_disk", { path: candidatePath });
      try {
        const existing = JSON.parse(rawContent);
        if (existing?.id === tabId) return candidatePath;
      } catch {
        // A malformed file is still occupied and must never be overwritten.
      }
    } catch (err: any) {
      if (String(err).toLowerCase().includes("file not found")) return candidatePath;
      throw err;
    }
  }
  throw new Error(`Could not allocate a unique canvas filename for "${title}"`);
};

const saveCanvasNow = async (
  tabId: string,
  title: string,
  rootPath: string,
  refreshFileTree: boolean
): Promise<string> => {
  const state = useWorkspaceStore.getState();
  const context = state.canvasContexts[tabId] || {
    nodes: [],
    edges: [],
    nodeLogs: {},
    nodeStatus: {},
    globalChatHistory: {},
    edgeReconciliationStatus: {},
    isPipelineApplied: false
  };

  const nodeIds = new Set(context.nodes.map((node: any) => node.id));
  nodeIds.add(reconciliationService.getNodeId(tabId));
  let vfsSnapshot = { contents: {}, tracker: {} };
  try {
    vfsSnapshot = await persistenceOrchestrator.captureVfsForSave(tabId, nodeIds);
  } catch (err) {
    console.warn("[canvasFileService] Could not export VFS state for save:", err);
  }

  const payload = {
    id: tabId,
    title,
    nodes: context.nodes,
    edges: context.edges,
    nodeLogs: context.nodeLogs,
    nodeStatus: context.nodeStatus,
    globalChatHistory: context.globalChatHistory,
    edgeReconciliationStatus: context.edgeReconciliationStatus,
    reconciliationSnapshot: context.reconciliationSnapshot,
    isPipelineApplied: context.isPipelineApplied || false,
    contextNodesHidden: context.contextNodesHidden ?? false,
    contextRevealedTasks: context.contextRevealedTasks ?? [],
    vfsContents: vfsSnapshot.contents,
    vfsTracker: vfsSnapshot.tracker
  };

  const filePath = await resolveCanvasFilePath(rootPath, title, tabId);
  await invoke("write_file_disk", {
    path: filePath,
    content: JSON.stringify(payload, null, 2)
  });

  if (refreshFileTree) {
    const tree: any[] = await invoke("get_directory_structure", { rootDir: rootPath });
    useWorkspaceStore.getState().setFileTree(tree);
  }

  return filePath;
};

function getAutoSaveState(tabId: string): AutoSaveState {
  let state = autoSaveStates.get(tabId);
  if (!state) {
    state = {
      timer: null,
      inFlight: false,
      dirty: false,
      lastSavedAt: 0,
      pendingPromise: null,
      pendingResolve: null,
    };
    autoSaveStates.set(tabId, state);
  }
  return state;
}

function scheduleAutoSave(tabId: string, delayMs = AUTOSAVE_DEBOUNCE_MS): void {
  const autoSave = getAutoSaveState(tabId);
  if (autoSave.inFlight) return;
  if (autoSave.timer) clearTimeout(autoSave.timer);
  const intervalDelay = Math.max(0, autoSave.lastSavedAt + AUTOSAVE_MIN_INTERVAL_MS - Date.now());
  autoSave.timer = setTimeout(() => {
    autoSave.timer = null;
    void runAutoSave(tabId);
  }, Math.max(delayMs, intervalDelay));
}

async function runAutoSave(tabId: string): Promise<void> {
  const autoSave = getAutoSaveState(tabId);
  if (autoSave.inFlight || !autoSave.dirty) return;
  autoSave.inFlight = true;
  autoSave.dirty = false;
  const resolvePending = autoSave.pendingResolve;
  autoSave.pendingPromise = null;
  autoSave.pendingResolve = null;

  const state = useWorkspaceStore.getState();
  const rootPath = state.rootPath;
  if (!rootPath) {
    resolvePending?.(null);
    autoSave.inFlight = false;
    return;
  }

  const title = selectTabById(state, tabId)?.title ?? null;
  if (!title || !state.canvasContexts[tabId]) {
    // The tab may have closed or the workspace may have changed while the
    // debounce timer was pending. Never create an empty/stale canvas file.
    resolvePending?.(null);
    autoSave.inFlight = false;
    autoSaveStates.delete(tabId);
    return;
  }

  try {
    const queueKey = `${rootPath}::${sanitizedCanvasName(title)}`;
    const filePath = await enqueueSave(queueKey, () => saveCanvasNow(tabId, title, rootPath, false));
    autoSave.lastSavedAt = Date.now();
    resolvePending?.(filePath);
  } catch (err) {
    console.error("[canvasFileService] Auto-save failed:", err);
    resolvePending?.(null);
  } finally {
    autoSave.inFlight = false;
    if (autoSave.dirty) scheduleAutoSave(tabId);
  }
}

export const canvasFileService = {
  getCanvasDir: (rootPath: string) => {
    return canvasDirectory(rootPath);
  },

  getCanvasFilePath: (rootPath: string, sanitizedTitle: string) => {
    return canvasPath(rootPath, sanitizedTitle);
  },

  sanitizeFileName: (title: string) => {
    return sanitizedCanvasName(title);
  },

  saveCanvas: async (tabId: string, title: string): Promise<string> => {
    const state = useWorkspaceStore.getState();
    const rootPath = state.rootPath;
    if (!rootPath) throw new Error("No active workspace directory loaded");
    const queueKey = `${rootPath}::${sanitizedCanvasName(title)}`;
    return enqueueSave(queueKey, () => saveCanvasNow(tabId, title, rootPath, true));
  },

  autoSaveCanvas: (tabId: string): Promise<string | null> => {
    const autoSave = getAutoSaveState(tabId);
    autoSave.dirty = true;
    if (!autoSave.pendingPromise) {
      autoSave.pendingPromise = new Promise<string | null>((resolve) => {
        autoSave.pendingResolve = resolve;
      });
    }
    scheduleAutoSave(tabId);
    return autoSave.pendingPromise;
  },
 
  loadCanvasFromFile: async (filePath: string): Promise<any> => {
    const rawContent: string = await invoke("read_file_disk", { path: filePath });
    const parsed = JSON.parse(rawContent);
    return parsed;
  },
 
  restoreCanvasVfs: async (
    vfsContents: Record<string, string>,
    vfsTracker: Record<string, string[]>,
    tabId: string
  ): Promise<void> => {
    try {
      await persistenceOrchestrator.restoreVfsFromSave(tabId, {
        contents: vfsContents || {},
        tracker: vfsTracker || {},
      });
    } catch (err) {
      console.error("[canvasFileService] Failed to restore VFS state:", err);
      throw err;
    }
  }
};
