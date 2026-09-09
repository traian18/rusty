import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTabTestStore } from "../../test/tabTestStore";

// createAgentTab bypasses openTab entirely (see createAgentSlice.ts), so none
// of openTab's dedup, groupId handling, or canvas-alias syncing applies to
// it. Every case below is a known defect that PR 1 fixes by routing agent
// creation through openTab as a global singleton (REFACTOR_PLAN.md PR 1).

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createAgentTab", () => {
  it("KNOWN-WRONG (PR 1): never dedups -- two calls create two agent tabs", () => {
    const store = createTabTestStore();
    store.getState().createAgentTab();
    vi.advanceTimersByTime(1);
    store.getState().createAgentTab();

    const allTabs = store.getState().editorGroups.flatMap((g) => g.openTabs);
    expect(allTabs.filter((t) => t.type === "agent")).toHaveLength(2);
  });

  it("KNOWN-WRONG (PR 1): under frozen time, two calls collide on the same tab id and clobber agentChats", () => {
    const store = createTabTestStore();
    store.getState().createAgentTab();
    const firstTabId = store.getState().editorGroups[0].openTabs.slice(-1)[0]?.id;
    store.getState().addAgentMessage(firstTabId!, {
      id: "m1",
      role: "user",
      content: "hello",
      timestamp: "2026-01-01T00:00:00Z",
    });

    store.getState().createAgentTab();
    const secondTabId = store.getState().editorGroups[0].openTabs.slice(-1)[0]?.id;

    expect(secondTabId).toBe(firstTabId);
    // The second createAgentTab call re-seeds agentChats[tabId] = [], wiping
    // the message the first agent had already received.
    expect(store.getState().agentChats[firstTabId!]).toEqual([]);
  });

  it("KNOWN-WRONG (PR 1): when activeGroupId matches no group, no tab is added but agentChats is still seeded", () => {
    const store = createTabTestStore();
    store.setState({ activeGroupId: "no_such_group" });

    store.getState().createAgentTab();

    const allTabs = store.getState().editorGroups.flatMap((g) => g.openTabs);
    expect(allTabs.filter((t) => t.type === "agent")).toHaveLength(0);
    expect(Object.keys(store.getState().agentChats)).toHaveLength(1);
  });

  it("KNOWN-WRONG (PR 1): does not sync canvas aliases (no withActiveCanvas)", () => {
    const store = createTabTestStore({ nodes: [{ id: "sentinel" }] as never });

    store.getState().createAgentTab();

    // If withActiveCanvas ran, nodes would be resynced from canvasContexts
    // (which is empty) and this sentinel value would be wiped to [].
    expect(store.getState().nodes).toEqual([{ id: "sentinel" }]);
  });

  it("defaults the title to Agent N using the current agentChats count", () => {
    const store = createTabTestStore();
    store.getState().createAgentTab();
    vi.advanceTimersByTime(1);
    store.getState().createAgentTab();

    const agentTitles = store.getState().editorGroups[0].openTabs
      .filter((t) => t.type === "agent")
      .map((t) => t.title);
    expect(agentTitles).toEqual(["Agent 1", "Agent 2"]);
  });
});

