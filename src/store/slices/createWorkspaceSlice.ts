import { createEmptyCanvasContext } from "../canvasHelpers";
import { tabsAfterBranchChange, tabsAfterWorkspaceChange } from "../../tabs/transitions";
import { pruneForClosedTab } from "../../tabs/policy";
import { disposeTab } from "../../tabs/effects";
import type { WorkspaceSliceCreator } from "../sliceTypes";
import type { WorkspaceState } from "../types";

export const createWorkspaceSlice: WorkspaceSliceCreator = (set, get) => ({
  rootPath: "",
  fileTree: [],
  expandedPaths: {},
  revealPath: null,

  setRootPath: (path) => {
    if (path) {
      try {
        const stored = localStorage.getItem("previous_workspaces");
        const list: string[] = stored ? JSON.parse(stored) : [];
        const filtered = list.filter((previousPath) => previousPath !== path);
        filtered.unshift(path);
        if (filtered.length > 10) filtered.pop();
        localStorage.setItem("previous_workspaces", JSON.stringify(filtered));
      } catch (error) {
        console.error("Failed to update previous workspaces history:", error);
      }
    }

    const opened = tabsAfterWorkspaceChange();
    set({
      rootPath: path,
      tabs: opened.tabs,
      activeTabId: opened.activeTabId,
      canvasContexts: { canvas: createEmptyCanvasContext() },
      canvasHistories: { canvas: { past: [], future: [] } },
      expandedPaths: {},
      revealPath: null,
      nodes: [],
      edges: [],
      selectedNodeId: null,
      nodeLogs: {},
      nodeStatus: {},
    });
    void get().loadGitStatus();
    void get().loadSkills();
    void get().loadMetricsSummary();
    setTimeout(() => void get().saveSecureConfig(), 0);
  },

  setFileTree: (tree) => set({ fileTree: tree }),

  resetForBranchChange: () => {
    // Dropped tabs are pruned and disposed here. The previous implementation
    // discarded them without cleanup, leaking a canvas context, chat history
    // and VFS instance on every branch switch.
    const { tabs, activeTabId, dropped } = tabsAfterBranchChange(get());

    set((state) => {
      let pruned: Partial<WorkspaceState> = {};
      for (const tab of dropped) {
        pruned = { ...pruned, ...pruneForClosedTab(tab, { ...state, ...pruned } as WorkspaceState) };
      }
      return {
        fileTree: [],
        expandedPaths: {},
        revealPath: null,
        selectedNodeId: null,
        tabs,
        activeTabId,
        ...pruned,
      };
    });

    for (const tab of dropped) disposeTab(tab);
  },

  setPathExpanded: (path, expanded) => set((state) => ({
    expandedPaths: { ...state.expandedPaths, [path]: expanded },
  })),

  togglePathExpanded: (path) => set((state) => ({
    expandedPaths: { ...state.expandedPaths, [path]: !state.expandedPaths[path] },
  })),

  collapseAllFolders: () => set({
    expandedPaths: {},
    collapseAllTrigger: Date.now(),
  }),

  revealFileInTree: (filePath) => set((state) => {
    const parts = filePath.split("/");
    const expandedPaths = { ...state.expandedPaths };
    let currentPath = "";
    for (let index = 0; index < parts.length - 1; index++) {
      currentPath += (index > 0 ? "/" : "") + parts[index];
      expandedPaths[currentPath] = true;
    }
    return {
      expandedPaths,
      revealPath: filePath,
      // Opening the drawer here -- in the SAME set() as revealPath --
      // rather than via a setTimeout + CustomEvent that a separate
      // AppShell listener picked up (the old handshake) is what fixes a
      // real bug: a Source Control user pressing "Reveal in Explorer"
      // used to have the event fire before ContextDrawer (mounted only
      // once drawerOpen flips) existed to hear it, stranding revealPath.
      // A same-tick synchronous update means FileTree is guaranteed to
      // mount already reading the drawerOpen===true state that carries
      // this revealPath.
      drawerOpen: true,
      drawerView: "explorer",
    };
  }),

  clearRevealPath: () => set({ revealPath: null }),
});
