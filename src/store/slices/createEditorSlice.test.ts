import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTabTestStore } from "../../test/tabTestStore";
import type { Tab } from "../types";

// These tests characterize createEditorSlice's ACTUAL current behavior,
// including known defects. Each assertion was written by running it and
// reading the resulting state, not by reading the source and predicting an
// outcome -- that discipline is what makes a characterization test useful:
// it pins what the code does today so PR 1 can deliberately change it.
//
// Defects intentionally pinned here (see REFACTOR_PLAN.md PR 1) are marked
// `// KNOWN-WRONG (PR 1): ...`.

function tab(overrides: Partial<Tab> & Pick<Tab, "id" | "type">): Tab {
  return { title: overrides.id, key: overrides.id, ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createEditorSlice initial state", () => {
  it("starts with one group holding the welcome and workspace_select tabs", () => {
    const store = createTabTestStore();
    const state = store.getState();

    expect(state.editorGroups).toEqual([
      {
        id: "group_0",
        openTabs: [
          { id: "welcome", type: "onboarding", title: "Welcome to Rusty", key: "onboarding" },
          { id: "workspace_select", type: "workspace", title: "Workspaces", key: "workspace" },
        ],
        activeTabId: "welcome",
      },
    ]);
    expect(state.activeGroupId).toBe("group_0");
    expect(state.groupSizes).toEqual([1]);
  });
});

describe("openTab: singleton dedup", () => {
  it.each(["llm-setup", "mcp-integration", "settings", "skills", "workspace", "onboarding"] as const)(
    "opens only one %s tab across repeated calls",
    (type) => {
      const store = createTabTestStore();
      store.getState().openTab(tab({ id: `${type}-1`, type }));
      store.getState().openTab(tab({ id: `${type}-2`, type }));

      const allTabs = store.getState().editorGroups.flatMap((g) => g.openTabs);
      expect(allTabs.filter((t) => t.type === type)).toHaveLength(1);
    },
  );

  it("KNOWN-WRONG (PR 1): metrics is not in the singleton list, so two metrics tabs can open", () => {
    const store = createTabTestStore();
    store.getState().openTab(tab({ id: "metrics-1", type: "metrics" }));
    store.getState().openTab(tab({ id: "metrics-2", type: "metrics" }));

    const allTabs = store.getState().editorGroups.flatMap((g) => g.openTabs);
    expect(allTabs.filter((t) => t.type === "metrics")).toHaveLength(2);
  });

  it("KNOWN-WRONG (PR 1): a singleton already open elsewhere ignores the requested groupId", () => {
    const store = createTabTestStore();
    // Open settings in the default group, then split into a second group by
    // hand (bypassing splitTab, which is out of scope here) so the singleton
    // lives in "group_B" while "group_A" is the target of the second call.
    store.setState({
      editorGroups: [
        { id: "group_A", openTabs: [tab({ id: "file-a", type: "file" })], activeTabId: "file-a" },
        { id: "group_B", openTabs: [tab({ id: "settings-1", type: "settings" })], activeTabId: "settings-1" },
      ],
      activeGroupId: "group_A",
      groupSizes: [0.5, 0.5],
    });

    store.getState().openTab(tab({ id: "settings-2", type: "settings" }), "group_A");

    const state = store.getState();
    // Activated in place in group_B, not opened into the requested group_A.
    expect(state.activeGroupId).toBe("group_B");
    expect(state.editorGroups.find((g) => g.id === "group_B")?.activeTabId).toBe("settings-1");
    expect(state.editorGroups.find((g) => g.id === "group_A")?.openTabs).toHaveLength(1);
  });
});

describe("openTab: canvas/rusty aliasing", () => {
  it("treats canvas and rusty types as interchangeable for dedup by key", () => {
    const store = createTabTestStore();
    store.getState().openTab(tab({ id: "canvas-1", type: "canvas", key: "k1" }));
    store.getState().openTab(tab({ id: "rusty-1", type: "rusty", key: "k1" }));

    const allTabs = store.getState().editorGroups.flatMap((g) => g.openTabs);
    expect(allTabs).toHaveLength(3); // welcome + workspace_select + the one canvas tab
    expect(allTabs.filter((t) => t.type === "canvas" || t.type === "rusty")).toHaveLength(1);
  });

  it("opens a distinct tab for a different canvas/rusty key", () => {
    const store = createTabTestStore();
    store.getState().openTab(tab({ id: "canvas-1", type: "canvas", key: "k1" }));
    store.getState().openTab(tab({ id: "canvas-2", type: "canvas", key: "k2" }));

    const allTabs = store.getState().editorGroups.flatMap((g) => g.openTabs);
    expect(allTabs.filter((t) => t.type === "canvas")).toHaveLength(2);
  });
});

describe("openTab: file tab id-upsert scoping", () => {
  it("KNOWN-WRONG (PR 1): the same tab id opened into two different groups produces two tabs", () => {
    const store = createTabTestStore();
    store.setState({
      editorGroups: [
        { id: "group_A", openTabs: [], activeTabId: null },
        { id: "group_B", openTabs: [], activeTabId: null },
      ],
      activeGroupId: "group_A",
      groupSizes: [0.5, 0.5],
    });

    store.getState().openTab(tab({ id: "file-1", type: "file" }), "group_A");
    store.getState().openTab(tab({ id: "file-1", type: "file" }), "group_B");

    const allTabs = store.getState().editorGroups.flatMap((g) => g.openTabs);
    expect(allTabs.filter((t) => t.id === "file-1")).toHaveLength(2);
  });

  it("KNOWN-WRONG (PR 1): reopening a file tab without a line keeps the previous line", () => {
    const store = createTabTestStore();
    store.getState().openTab(tab({ id: "file-1", type: "file", line: 10 }));
    store.getState().openTab(tab({ id: "file-1", type: "file" }));

    const reopened = store.getState().editorGroups[0].openTabs.find((t) => t.id === "file-1");
    expect(reopened?.line).toBe(10);
  });

  it("reopening a file tab with an explicit line updates and activates it", () => {
    const store = createTabTestStore();
    store.getState().openTab(tab({ id: "file-1", type: "file", line: 10 }));
    store.getState().openTab(tab({ id: "file-1", type: "file", line: 42 }));

    const state = store.getState();
    const reopened = state.editorGroups[0].openTabs.find((t) => t.id === "file-1");
    expect(reopened?.line).toBe(42);
    expect(state.editorGroups[0].activeTabId).toBe("file-1");
    expect(state.editorGroups[0].openTabs.filter((t) => t.id === "file-1")).toHaveLength(1);
  });
});

describe("openTab: missing target group", () => {
  it("KNOWN-WRONG (PR 1): opening into a nonexistent groupId destroys every other group", () => {
    const store = createTabTestStore();
    store.getState().openTab(tab({ id: "file-1", type: "file" }));
    const before = store.getState().editorGroups.length;
    expect(before).toBeGreaterThanOrEqual(1);

    store.getState().openTab(tab({ id: "file-2", type: "file" }), "does_not_exist");

    const state = store.getState();
    expect(state.editorGroups).toEqual([
      { id: "does_not_exist", openTabs: [tab({ id: "file-2", type: "file" })], activeTabId: "file-2" },
    ]);
    expect(state.groupSizes).toEqual([1]);
  });
});

describe("openTab: canvasContexts side effect", () => {
  it("KNOWN-WRONG (PR 1): opening any tab seeds canvasContexts by mutating it in place", () => {
    const store = createTabTestStore();
    const before = store.getState().canvasContexts;

    store.getState().openTab(tab({ id: "file-1", type: "file" }));

    const after = store.getState().canvasContexts;
    expect(after).toHaveProperty("canvas");
    // getOrCreateContext mutates the object passed to it rather than
    // returning a new one, so the reference survives the update.
    expect(after).toBe(before);
  });
});

describe("closeTab", () => {
  it("refuses to close workspace_select when it is the only tab of the only group", () => {
    const store = createTabTestStore();
    store.setState({
      editorGroups: [{ id: "group_0", openTabs: [tab({ id: "workspace_select", type: "workspace" })], activeTabId: "workspace_select" }],
      activeGroupId: "group_0",
      groupSizes: [1],
    });

    store.getState().closeTab("workspace_select");

    expect(store.getState().editorGroups[0].openTabs).toHaveLength(1);
  });

  it("closes workspace_select when other tabs exist", () => {
    const store = createTabTestStore();
    store.getState().closeTab("workspace_select");

    const allTabs = store.getState().editorGroups.flatMap((g) => g.openTabs);
    expect(allTabs.find((t) => t.id === "workspace_select")).toBeUndefined();
  });

  it("replaces the last tab of the only group with a fresh welcome tab", () => {
    const store = createTabTestStore();
    store.getState().closeTab("workspace_select");
    store.getState().closeTab("welcome");

    const state = store.getState();
    expect(state.editorGroups).toEqual([
      { id: "group_0", openTabs: [{ id: "welcome", type: "onboarding", title: "Welcome to Rusty", key: "onboarding" }], activeTabId: "welcome" },
    ]);
    expect(state.groupSizes).toEqual([1]);
  });

  it("KNOWN-WRONG (PR 1): closing the active tab falls back to the LAST remaining tab, not a neighbor", () => {
    const store = createTabTestStore();
    store.getState().openTab(tab({ id: "file-1", type: "file" }));
    store.getState().openTab(tab({ id: "file-2", type: "file" }));
    store.getState().setActiveTabId("welcome");

    store.getState().closeTab("welcome");

    const group = store.getState().editorGroups[0];
    expect(group.activeTabId).toBe("file-2");
  });

  it("leaves activeTabId unchanged when closing an inactive tab", () => {
    const store = createTabTestStore();
    store.getState().openTab(tab({ id: "file-1", type: "file" }));

    store.getState().closeTab("workspace_select");

    expect(store.getState().editorGroups[0].activeTabId).toBe("file-1");
  });

  it("closing an ambiguous id (present in two groups) closes it in the first matching group", () => {
    const store = createTabTestStore();
    store.setState({
      editorGroups: [
        { id: "group_A", openTabs: [tab({ id: "dup", type: "file" }), tab({ id: "other-a", type: "file" })], activeTabId: "dup" },
        { id: "group_B", openTabs: [tab({ id: "dup", type: "file" }), tab({ id: "other-b", type: "file" })], activeTabId: "dup" },
      ],
      activeGroupId: "group_A",
      groupSizes: [0.5, 0.5],
    });

    store.getState().closeTab("dup");

    const state = store.getState();
    expect(state.editorGroups.find((g) => g.id === "group_A")?.openTabs.map((t) => t.id)).toEqual(["other-a"]);
    expect(state.editorGroups.find((g) => g.id === "group_B")?.openTabs.map((t) => t.id)).toEqual(["dup", "other-b"]);
  });

  it("removing a group folds its size into the LEFT neighbor", () => {
    const store = createTabTestStore();
    store.setState({
      editorGroups: [
        { id: "group_0", openTabs: [tab({ id: "a", type: "file" })], activeTabId: "a" },
        { id: "group_1", openTabs: [tab({ id: "b", type: "file" })], activeTabId: "b" },
        { id: "group_2", openTabs: [tab({ id: "c", type: "file" })], activeTabId: "c" },
      ],
      activeGroupId: "group_1",
      groupSizes: [0.2, 0.3, 0.5],
    });

    store.getState().closeTab("b", "group_1");

    const state = store.getState();
    expect(state.editorGroups.map((g) => g.id)).toEqual(["group_0", "group_2"]);
    expect(state.groupSizes).toEqual([0.5, 0.5]);
    expect(state.activeGroupId).toBe("group_0");
  });

  it("removing group index 0 folds its size into the new index 0 (former index 1)", () => {
    const store = createTabTestStore();
    store.setState({
      editorGroups: [
        { id: "group_0", openTabs: [tab({ id: "a", type: "file" })], activeTabId: "a" },
        { id: "group_1", openTabs: [tab({ id: "b", type: "file" })], activeTabId: "b" },
      ],
      activeGroupId: "group_1",
      groupSizes: [0.4, 0.6],
    });

    store.getState().closeTab("a", "group_0");

    const state = store.getState();
    expect(state.editorGroups.map((g) => g.id)).toEqual(["group_1"]);
    expect(state.groupSizes).toEqual([1]);
  });
});

describe("setActiveTabId", () => {
  it("KNOWN-WRONG (PR 1): accepts a dangling tab id with no existence check", () => {
    const store = createTabTestStore();
    store.getState().setActiveTabId("no_such_tab");

    expect(store.getState().editorGroups[0].activeTabId).toBe("no_such_tab");
  });

  it("KNOWN-WRONG (PR 1): accepts a nonexistent groupId, silently updating nothing but activeGroupId", () => {
    const store = createTabTestStore();
    store.getState().setActiveTabId("welcome", "no_such_group");

    expect(store.getState().activeGroupId).toBe("no_such_group");
    // No group actually has id "no_such_group", so no openTabs/activeTabId changed.
    expect(store.getState().editorGroups[0].activeTabId).toBe("welcome");
  });
});

describe("updateTabTitle", () => {
  it("KNOWN-WRONG (PR 1): updates a matching id in every group, not just the owning one", () => {
    const store = createTabTestStore();
    store.setState({
      editorGroups: [
        { id: "group_A", openTabs: [tab({ id: "dup", type: "file", title: "A" })], activeTabId: "dup" },
        { id: "group_B", openTabs: [tab({ id: "dup", type: "file", title: "A" })], activeTabId: "dup" },
      ],
      activeGroupId: "group_A",
      groupSizes: [0.5, 0.5],
    });

    store.getState().updateTabTitle("dup", "Renamed");

    const state = store.getState();
    expect(state.editorGroups[0].openTabs[0].title).toBe("Renamed");
    expect(state.editorGroups[1].openTabs[0].title).toBe("Renamed");
  });
});

describe("splitTab / moveTab (removed entirely in PR 1 -- minimal pins only)", () => {
  it("splitTab inserts a new group after the source and halves its size", () => {
    const store = createTabTestStore();
    store.getState().splitTab("welcome", "group_0");

    const state = store.getState();
    expect(state.editorGroups.map((g) => g.id)).toEqual(["group_0", "group_1767225600000"]);
    expect(state.groupSizes).toEqual([0.5, 0.5]);
    expect(state.activeGroupId).toBe("group_1767225600000");
  });

  it("KNOWN-WRONG: two splitTab calls under frozen time produce colliding group ids", () => {
    const store = createTabTestStore();
    store.getState().openTab(tab({ id: "file-1", type: "file" }));
    store.getState().splitTab("welcome", "group_0");
    store.getState().splitTab("file-1", "group_0");

    const ids = store.getState().editorGroups.map((g) => g.id);
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it("moveTab is a no-op when source and destination are the same group", () => {
    const store = createTabTestStore();
    const before = store.getState().editorGroups;

    store.getState().moveTab("welcome", "group_0", "group_0");

    expect(store.getState().editorGroups).toBe(before);
  });

  it("moveTab removes an emptied source group and folds its size left", () => {
    const store = createTabTestStore();
    store.setState({
      editorGroups: [
        { id: "group_0", openTabs: [tab({ id: "a", type: "file" })], activeTabId: "a" },
        { id: "group_1", openTabs: [tab({ id: "b", type: "file" })], activeTabId: "b" },
      ],
      activeGroupId: "group_0",
      groupSizes: [0.5, 0.5],
    });

    store.getState().moveTab("a", "group_0", "group_1");

    const state = store.getState();
    expect(state.editorGroups.map((g) => g.id)).toEqual(["group_1"]);
    expect(state.groupSizes).toEqual([1]);
    expect(state.editorGroups[0].openTabs.map((t) => t.id)).toEqual(["b", "a"]);
    expect(state.editorGroups[0].activeTabId).toBe("a");
    expect(state.activeGroupId).toBe("group_1");
  });
});
