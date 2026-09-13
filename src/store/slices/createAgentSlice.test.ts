import { describe, expect, it } from "vitest";
import { createTabTestStore } from "../../test/tabTestStore";
import type { AgentMessage } from "../types";

/**
 * Agent tabs used to be created by `createAgentTab`, which bypassed `openTab`
 * entirely: no dedup, a `Date.now()` id that collided under frozen timers, and
 * a chat seed that ran on every call. Every case PR 0 pinned here was marked
 * KNOWN-WRONG; all of them are flipped or deleted now that agent creation goes
 * through the registry as a global singleton.
 */

function message(id: string): AgentMessage {
  return { id, role: "user", content: "hello", timestamp: "2026-01-01T00:00:00Z" };
}

describe("opening agent tabs", () => {
  it("is a global singleton -- two opens yield one tab", () => {
    const store = createTabTestStore();
    const first = store.getState().openTab({ type: "agent" });
    const second = store.getState().openTab({ type: "agent" });

    expect(second).toBe(first);
    expect(store.getState().tabs.filter((tab) => tab.type === "agent")).toHaveLength(1);
  });

  it("preserves the conversation when the tab is reopened", () => {
    // The second createAgentTab call used to re-seed agentChats[tabId] = [],
    // silently discarding the existing conversation. seedOnCreate now runs
    // only when a tab is actually created.
    const store = createTabTestStore();
    const id = store.getState().openTab({ type: "agent" });
    store.getState().addAgentMessage(id, message("m1"));

    store.getState().openTab({ type: "agent" });

    expect(store.getState().agentChats[id]).toHaveLength(1);
  });

  it("seeds an empty conversation on first open", () => {
    const store = createTabTestStore();
    const id = store.getState().openTab({ type: "agent" });

    expect(store.getState().agentChats[id]).toEqual([]);
  });

  it("titles the tab from the policy, or from an explicit request", () => {
    const store = createTabTestStore();
    const id = store.getState().openTab({ type: "agent" });
    expect(store.getState().tabs.find((tab) => tab.id === id)?.title).toBe("Agent");

    const reopened = store.getState().openTab({ type: "agent", title: "Custom" });
    expect(reopened).toBe(id);
    // A re-open is an activation, so it leaves the existing title in place.
    expect(store.getState().tabs.find((tab) => tab.id === id)?.title).toBe("Agent");
  });

  it("syncs canvas aliases, because creation goes through openTab", () => {
    const store = createTabTestStore({ nodes: [{ id: "sentinel" }] } as never);
    store.getState().openTab({ type: "agent" });

    // No canvas is open, so the aliases resync to an empty context.
    expect(store.getState().nodes).toEqual([]);
  });
});

describe("mutators ignore tabs that are no longer open", () => {
  // An agent tab's WebSocket is torn down on unmount, which happens after the
  // tab and its chat have been pruned. Without these guards a late message
  // would recreate the key, and the next agent tab -- which reuses the same
  // singleton id -- would inherit the orphaned history.
  it("drops a message for a closed tab", () => {
    const store = createTabTestStore();
    const id = store.getState().openTab({ type: "agent" });
    store.getState().closeTab(id);

    store.getState().addAgentMessage(id, message("late"));

    expect(store.getState().agentChats).not.toHaveProperty(id);
  });

  it("drops a stream update for a closed tab", () => {
    const store = createTabTestStore();
    const id = store.getState().openTab({ type: "agent" });
    store.getState().closeTab(id);

    store.getState().updateAgentStream(id, "late chunk");

    expect(store.getState().agentStreams).not.toHaveProperty(id);
  });

  it("drops a permission request for a closed tab", () => {
    const store = createTabTestStore();
    const id = store.getState().openTab({ type: "agent" });
    store.getState().closeTab(id);

    store.getState().addAgentPermissionRequest(id, {
      id: "req",
      toolCall: { id: "t", name: "bash", arguments: {}, status: "pending" },
      description: "run",
      timestamp: "2026-01-01T00:00:00Z",
    });

    expect(store.getState().agentPermissionRequests).not.toHaveProperty(id);
  });

  it("a fresh agent tab starts empty after the previous one was closed", () => {
    const store = createTabTestStore();
    const first = store.getState().openTab({ type: "agent" });
    store.getState().addAgentMessage(first, message("m1"));
    store.getState().closeTab(first);

    const second = store.getState().openTab({ type: "agent" });

    expect(second).toBe(first); // same singleton id
    expect(store.getState().agentChats[second]).toEqual([]);
  });

  it("still accepts messages for an open tab", () => {
    const store = createTabTestStore();
    const id = store.getState().openTab({ type: "agent" });
    store.getState().addAgentMessage(id, message("m1"));
    store.getState().addAgentMessage(id, message("m2"));

    expect(store.getState().agentChats[id]).toHaveLength(2);
  });
});
