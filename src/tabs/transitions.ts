/**
 * Pure tab-collection transitions for app-level events.
 *
 * These live outside the workspace slice so they can be tested without that
 * slice's `localStorage` and `invoke` baggage (ARCHITECTURE.md's slice
 * import-time purity rule).
 */

import { getTabPolicy } from "./policy";
import type { TabInstance } from "./types";

function makeSingletonTab(
  type: "onboarding" | "workspace",
): TabInstance {
  const policy = getTabPolicy(type);
  return policy.create({ type } as never, type, {
    rootPath: "",
    existingIds: [],
    existingCanvasIds: [],
  });
}

/** The tab shown when the strip would otherwise be empty. */
export function fallbackTab(): TabInstance {
  return makeSingletonTab("onboarding");
}

export function initialTabs(): { tabs: TabInstance[]; activeTabId: string } {
  const onboarding = makeSingletonTab("onboarding");
  const workspace = makeSingletonTab("workspace");
  return { tabs: [onboarding, workspace], activeTabId: onboarding.id };
}

/**
 * Opening a workspace replaces the whole strip with a fresh canvas, matching
 * the previous `setRootPath` behavior.
 */
export function tabsAfterWorkspaceChange(canvasId = "canvas"): {
  tabs: TabInstance[];
  activeTabId: string;
  dropped: TabInstance[];
} {
  const canvas = getTabPolicy("canvas").create({ type: "canvas", title: "Rusty" }, canvasId, {
    rootPath: "",
    existingIds: [],
    existingCanvasIds: [],
  });
  return { tabs: [canvas], activeTabId: canvas.id, dropped: [] };
}

/**
 * A branch change keeps the first canvas tab (or seeds one) and drops the
 * rest. `dropped` is returned so the caller can prune and dispose them — the
 * previous implementation dropped tabs without pruning anything, leaking a
 * canvas context, chat history and VFS instance on every branch switch.
 */
export function tabsAfterBranchChange(state: { tabs: TabInstance[] }): {
  tabs: TabInstance[];
  activeTabId: string;
  dropped: TabInstance[];
} {
  const canvas = state.tabs.find((tab) => tab.type === "canvas");
  if (!canvas) {
    const seeded = tabsAfterWorkspaceChange();
    return { ...seeded, dropped: state.tabs };
  }
  return {
    tabs: [canvas],
    activeTabId: canvas.id,
    dropped: state.tabs.filter((tab) => tab.id !== canvas.id),
  };
}
