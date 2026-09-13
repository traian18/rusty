import { describe, expect, it } from "vitest";
import {
  fallbackTab,
  initialTabs,
  tabsAfterBranchChange,
  tabsAfterWorkspaceChange,
} from "./transitions";
import type { TabInstance } from "./types";

function canvasTab(id: string): TabInstance {
  return { id, type: "canvas", title: id, status: "idle", dirty: false, canvasId: id };
}

function fileTab(path: string): TabInstance {
  return { id: `file:${path}`, type: "file", title: path, status: "idle", dirty: false, path };
}

describe("initialTabs", () => {
  it("opens onboarding and workspace, with onboarding active", () => {
    const { tabs, activeTabId } = initialTabs();
    expect(tabs.map((t) => t.type)).toEqual(["onboarding", "workspace"]);
    expect(activeTabId).toBe("onboarding");
  });

  it("gives every tab an id matching its identity", () => {
    for (const tab of initialTabs().tabs) expect(tab.id).toBe(tab.type);
  });
});

describe("fallbackTab", () => {
  it("is the onboarding tab", () => {
    expect(fallbackTab()).toMatchObject({ id: "onboarding", type: "onboarding" });
  });
});

describe("tabsAfterWorkspaceChange", () => {
  it("replaces the strip with a single active canvas", () => {
    const { tabs, activeTabId } = tabsAfterWorkspaceChange();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].type).toBe("canvas");
    expect(activeTabId).toBe(tabs[0].id);
  });
});

describe("tabsAfterBranchChange", () => {
  it("keeps the first canvas tab and drops the rest", () => {
    const state = { tabs: [fileTab("/a.ts"), canvasTab("c1"), canvasTab("c2")] };
    const { tabs, activeTabId, dropped } = tabsAfterBranchChange(state);

    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe("c1");
    expect(activeTabId).toBe("c1");
    expect(dropped.map((t) => t.id)).toEqual(["file:/a.ts", "c2"]);
  });

  it("reports dropped tabs so the caller can prune and dispose them", () => {
    // The previous implementation dropped tabs while pruning nothing, leaking
    // a canvas context, chat history and VFS instance on every branch switch.
    const state = { tabs: [canvasTab("c1"), fileTab("/a.ts")] };
    expect(tabsAfterBranchChange(state).dropped).toHaveLength(1);
  });

  it("seeds a canvas when none is open, dropping everything else", () => {
    const state = { tabs: [fileTab("/a.ts")] };
    const { tabs, activeTabId, dropped } = tabsAfterBranchChange(state);

    expect(tabs).toHaveLength(1);
    expect(tabs[0].type).toBe("canvas");
    expect(activeTabId).toBe(tabs[0].id);
    expect(dropped.map((t) => t.id)).toEqual(["file:/a.ts"]);
  });

  it("leaves activeTabId pointing at a tab that exists", () => {
    for (const state of [
      { tabs: [] as TabInstance[] },
      { tabs: [fileTab("/a.ts")] },
      { tabs: [canvasTab("c1"), canvasTab("c2")] },
    ]) {
      const result = tabsAfterBranchChange(state);
      expect(result.tabs.some((t) => t.id === result.activeTabId)).toBe(true);
    }
  });
});
