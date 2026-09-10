import { withActiveCanvas } from "../canvasHelpers";
import { disposeTab } from "../../tabs/effects";
import { getTabPolicy, pruneForClosedTab, seedForNewTab } from "../../tabs/policy";
import { nextInstanceId } from "../../tabs/identity";
import { fallbackTab, initialTabs } from "../../tabs/transitions";
import type { OpenTabRequest, TabInstance, TabResolveContext } from "../../tabs/types";
import type { WorkspaceSliceCreator } from "../sliceTypes";
import type { WorkspaceState } from "../types";

/**
 * The single open-tab collection. Replaces the previous `editorGroups` /
 * `activeGroupId` / `groupSizes` split-editor model: one tab per resource, one
 * outlet, and every behavioral decision delegated to `src/tabs/policy.ts`
 * rather than re-derived at each call site.
 */

function resolveContext(state: WorkspaceState): TabResolveContext {
  return {
    rootPath: state.rootPath,
    existingIds: state.tabs.map((tab) => tab.id),
    existingCanvasIds: Object.keys(state.canvasContexts ?? {}),
  };
}

export const createTabsSlice: WorkspaceSliceCreator = (set, get) => ({
  ...initialTabs(),

  openTab: (request: OpenTabRequest) => {
    // Assigned inside the updater below. Zustand's `set` runs the updater
    // synchronously, so this is populated before the return statement -- it
    // reads like a race but is not one.
    let resultId = "";

    set((state) => {
      const policy = getTabPolicy(request.type);
      const ctx = resolveContext(state);

      const identity =
        policy.uniqueness === "multiple"
          ? nextInstanceId(request.type, ctx.existingIds)
          : policy.getIdentity(request as never, ctx);
      resultId = identity;

      // For `global` uniqueness `getIdentity` returns a constant, so this
      // lookup doubles as the singleton check with no special-casing.
      const existing = state.tabs.find((tab) => tab.id === identity);

      if (existing) {
        const merged = policy.merge
          ? (policy.merge(existing as never, request as never) as TabInstance)
          : existing;
        const tabs =
          merged === existing
            ? state.tabs
            : state.tabs.map((tab) => (tab.id === identity ? merged : tab));
        return withActiveCanvas(state, { tabs, activeTabId: identity });
      }

      const created = policy.create(request as never, identity, ctx) as TabInstance;
      // Only runs on create, never on re-open: re-opening an agent tab must
      // not wipe the conversation the first open accumulated.
      const seeded = seedForNewTab(created, state);

      return withActiveCanvas(state, {
        tabs: [...state.tabs, created],
        activeTabId: identity,
        ...seeded,
      });
    });

    return resultId;
  },

  activateTab: (id: string) =>
    set((state) => {
      if (!state.tabs.some((tab) => tab.id === id)) return {};
      return withActiveCanvas(state, { activeTabId: id });
    }),

  closeTab: (id: string) => {
    const tab = get().tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    if (!getTabPolicy(tab.type).closable) return;

    set((state) => {
      const index = state.tabs.findIndex((candidate) => candidate.id === id);
      let tabs = state.tabs.filter((candidate) => candidate.id !== id);
      const pruned = pruneForClosedTab(tab, state);

      let activeTabId = state.activeTabId;
      if (activeTabId === id) {
        // Neighbour to the right, then to the left. The previous behavior
        // jumped to the last tab in the strip, which threw focus across the
        // window when closing anything but the rightmost tab.
        activeTabId = (tabs[index] ?? tabs[index - 1])?.id ?? null;
      }

      if (tabs.length === 0) {
        const fallback = fallbackTab();
        tabs = [fallback];
        activeTabId = fallback.id;
      }

      return withActiveCanvas(state, { tabs, activeTabId, ...pruned });
    });

    // Non-store cleanup runs after the state write, never inside the updater.
    disposeTab(tab);
  },

  updateTab: (id: string, updates: Partial<Omit<TabInstance, "id" | "type">>) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return {};
      const tabs = [...state.tabs];
      tabs[index] = { ...tabs[index], ...updates } as TabInstance;
      return { tabs };
    }),
});
