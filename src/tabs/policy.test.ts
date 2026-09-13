import { describe, expect, it } from "vitest";
import {
  TAB_POLICIES,
  closeGuardFor,
  getTabPolicy,
  pruneForClosedTab,
  seedForNewTab,
  shouldKeepMounted,
} from "./policy";
import type { TabDomainState, TabResolveContext, TabType } from "./types";

const ALL_TYPES = Object.keys(TAB_POLICIES) as TabType[];

const ctx = (overrides: Partial<TabResolveContext> = {}): TabResolveContext => ({
  rootPath: "/root",
  existingIds: [],
  existingCanvasIds: [],
  ...overrides,
});

const domain = (overrides: Partial<TabDomainState> = {}): TabDomainState => ({
  canvasContexts: {},
  canvasHistories: {},
  agentChats: {},
  agentStreams: {},
  agentPermissionRequests: {},
  busyAgentTabIds: {},
  ...overrides,
});

function canvasContext(overrides: Record<string, unknown> = {}) {
  return {
    nodes: [],
    edges: [],
    nodeLogs: {},
    nodeStatus: {},
    globalChatHistory: {},
    edgeReconciliationStatus: {},
    ...overrides,
  } as never;
}

describe("the policy table is total", () => {
  it("declares a policy for every tab type, keyed consistently", () => {
    for (const type of ALL_TYPES) {
      expect(TAB_POLICIES[type].type).toBe(type);
    }
  });

  it("gives every type a keepAlive and a closable flag", () => {
    for (const type of ALL_TYPES) {
      const policy = getTabPolicy(type);
      expect(["active-only", "while-busy", "always"]).toContain(policy.keepAlive);
      expect(typeof policy.closable).toBe("boolean");
    }
  });

  it("declares isBusy for exactly the while-busy types", () => {
    for (const type of ALL_TYPES) {
      const policy = getTabPolicy(type);
      if (policy.keepAlive === "while-busy") expect(policy.isBusy).toBeTypeOf("function");
    }
  });
});

describe("uniqueness", () => {
  it("gives every global singleton an identity equal to its type name", () => {
    for (const type of ALL_TYPES) {
      const policy = getTabPolicy(type);
      if (policy.uniqueness !== "global") continue;
      expect(policy.getIdentity({ type } as never, ctx())).toBe(type);
    }
  });

  it("marks metrics as a singleton", () => {
    // The old hard-coded singleton array omitted "metrics", so metrics tabs
    // silently duplicated. Declaring uniqueness in one table is what fixes it.
    expect(getTabPolicy("metrics").uniqueness).toBe("global");
  });

  it("varies resource identities with the resource", () => {
    const file = getTabPolicy("file");
    expect(file.getIdentity({ type: "file", path: "/a.ts" }, ctx())).not.toBe(
      file.getIdentity({ type: "file", path: "/b.ts" }, ctx()),
    );
  });

  it("resolves a file identity against the workspace root", () => {
    const file = getTabPolicy("file");
    expect(file.getIdentity({ type: "file", path: "a.ts" }, ctx({ rootPath: "/root" }))).toBe(
      file.getIdentity({ type: "file", path: "/root/a.ts" }, ctx()),
    );
  });

  it("allocates a fresh canvas id when the request names none", () => {
    const canvas = getTabPolicy("canvas");
    const first = canvas.getIdentity({ type: "canvas" }, ctx());
    const second = canvas.getIdentity({ type: "canvas" }, ctx({ existingIds: [first] }));
    expect(first).not.toBe(second);
  });

  it("honours an explicit canvas id", () => {
    expect(getTabPolicy("canvas").getIdentity({ type: "canvas", canvasId: "canvas_9" }, ctx())).toBe(
      "canvas_9",
    );
  });
});

describe("labels and creation", () => {
  it("titles a file tab with its basename", () => {
    const tab = getTabPolicy("file").create({ type: "file", path: "/a/b/readme.md" }, "id", ctx());
    expect(tab.title).toBe("readme.md");
  });

  it("lets the request override the title", () => {
    const tab = getTabPolicy("file").create(
      { type: "file", path: "/a/b.ts", title: "Custom" },
      "id",
      ctx(),
    );
    expect(tab.title).toBe("Custom");
  });

  it("stores a case-preserving canonical path, not the folded identity", () => {
    const tab = getTabPolicy("file").create({ type: "file", path: "\\A\\B.ts" }, "id", ctx());
    expect(tab.path).toBe("/A/B.ts");
  });

  it("labels git diffs by kind and commit", () => {
    const gitDiff = getTabPolicy("git-diff");
    expect(gitDiff.label({ type: "git-diff", path: "/a.ts", diffType: "staged" })).toBe(
      "a.ts (Index)",
    );
    expect(
      gitDiff.label({
        type: "git-diff",
        path: "/a.ts",
        diffType: "commit",
        commitHash: "abcdef1234",
      }),
    ).toBe("a.ts (abcdef1)");
  });

  it("defaults a git-history tab to the workspace root when no repo is given", () => {
    const tab = getTabPolicy("git-history").create(
      { type: "git-history" },
      "id",
      ctx({ rootPath: "/root" }),
    );
    expect(tab.repoPath).toBe("/root");
  });
});

describe("file merge on re-open", () => {
  const file = getTabPolicy("file");
  const existing = file.create({ type: "file", path: "/a.ts", line: 10 }, "file:/a.ts", ctx());

  it("keeps the previous line when the re-open names none", () => {
    // Deliberate: re-opening an already-open file from the tree should not
    // yank the caret back to line 1.
    const merged = file.merge!(existing, { type: "file", path: "/a.ts" });
    expect(merged.line).toBe(10);
  });

  it("adopts an explicitly requested line", () => {
    expect(file.merge!(existing, { type: "file", path: "/a.ts", line: 42 }).line).toBe(42);
  });

  it("returns the same object when nothing changed, so the store can skip the write", () => {
    expect(file.merge!(existing, { type: "file", path: "/a.ts" })).toBe(existing);
  });
});

describe("keepAlive", () => {
  const tab = (type: TabType, id = "t") => ({ id, type });

  it("keeps agent tabs mounted always", () => {
    expect(shouldKeepMounted(tab("agent"), domain())).toBe(true);
  });

  it("unmounts git diffs and git history when inactive", () => {
    expect(shouldKeepMounted(tab("git-diff"), domain())).toBe(false);
    expect(shouldKeepMounted(tab("git-history"), domain())).toBe(false);
  });

  it("keeps a canvas mounted only while a node is running", () => {
    const idle = domain({ canvasContexts: { c1: canvasContext({ nodeStatus: { n: "idle" } }) } });
    const busy = domain({ canvasContexts: { c1: canvasContext({ nodeStatus: { n: "running" } }) } });
    expect(shouldKeepMounted(tab("canvas", "c1"), idle)).toBe(false);
    expect(shouldKeepMounted(tab("canvas", "c1"), busy)).toBe(true);
  });

  it("treats a canvas with no context as idle", () => {
    expect(shouldKeepMounted(tab("canvas", "missing"), domain())).toBe(false);
  });
});

describe("seed and prune", () => {
  it("seeds an empty chat for a new agent tab", () => {
    const seeded = seedForNewTab({ id: "agent", type: "agent" }, domain());
    expect(seeded.agentChats).toEqual({ agent: [] });
  });

  it("preserves other tabs' state when seeding", () => {
    const state = domain({ agentChats: { other: [{ id: "m" } as never] } });
    const seeded = seedForNewTab({ id: "agent", type: "agent" }, state);
    expect(seeded.agentChats?.other).toHaveLength(1);
  });

  it("seeds a canvas context and history for a new canvas tab", () => {
    const seeded = seedForNewTab({ id: "canvas_1", type: "canvas" }, domain());
    expect(seeded.canvasContexts?.canvas_1).toBeDefined();
    expect(seeded.canvasHistories?.canvas_1).toEqual({ past: [], future: [] });
  });

  it("seeds nothing for types without domain state", () => {
    expect(seedForNewTab({ id: "file:/a.ts", type: "file" }, domain())).toEqual({});
  });

  it("prunes a closed canvas's context and history but leaves others", () => {
    const state = domain({
      canvasContexts: { c1: canvasContext(), c2: canvasContext() },
      canvasHistories: { c1: { past: [], future: [] }, c2: { past: [], future: [] } },
    });
    const pruned = pruneForClosedTab({ id: "c1", type: "canvas" }, state);
    expect(pruned.canvasContexts).not.toHaveProperty("c1");
    expect(pruned.canvasContexts).toHaveProperty("c2");
    expect(pruned.canvasHistories).not.toHaveProperty("c1");
  });

  it("prunes all four agent maps on close", () => {
    const state = domain({
      agentChats: { a: [] },
      agentStreams: { a: "partial" },
      agentPermissionRequests: { a: [] },
      busyAgentTabIds: { a: true },
    });
    const pruned = pruneForClosedTab({ id: "a", type: "agent" }, state);
    expect(pruned.agentChats).not.toHaveProperty("a");
    expect(pruned.agentStreams).not.toHaveProperty("a");
    expect(pruned.agentPermissionRequests).not.toHaveProperty("a");
    // REFACTOR_PLAN.md PR 7 commit 2: without this, a stale `true` here
    // would incorrectly mark the next-opened Agent tab as busy immediately
    // -- agent is a singleton, so it reuses this same tab id every time.
    expect(pruned.busyAgentTabIds).not.toHaveProperty("a");
  });
});

describe("close guards", () => {
  const canvasTab = { id: "c1", type: "canvas" as const, title: "Pipeline" };

  it("allows closing a canvas with no context", () => {
    // The old flow dereferenced this context unguarded after stopping nodes.
    expect(closeGuardFor(canvasTab, domain()).kind).toBe("allow");
  });

  it("confirms when a node is running", () => {
    const state = domain({ canvasContexts: { c1: canvasContext({ nodeStatus: { n: "running" } }) } });
    expect(closeGuardFor(canvasTab, state)).toEqual({
      kind: "confirm",
      reason: "running",
      tabId: "c1",
      title: "Pipeline",
    });
  });

  it("confirms when an unsaved canvas has content", () => {
    const state = domain({
      canvasContexts: { c1: canvasContext({ nodes: [{ id: "n" }], hasBeenSaved: false }) },
    });
    expect(closeGuardFor(canvasTab, state)).toMatchObject({ kind: "confirm", reason: "unsaved" });
  });

  it("allows closing an unsaved but empty canvas", () => {
    const state = domain({ canvasContexts: { c1: canvasContext({ hasBeenSaved: false }) } });
    expect(closeGuardFor(canvasTab, state).kind).toBe("allow");
  });

  it("allows closing a saved canvas", () => {
    const state = domain({
      canvasContexts: { c1: canvasContext({ nodes: [{ id: "n" }], hasBeenSaved: true }) },
    });
    expect(closeGuardFor(canvasTab, state).kind).toBe("allow");
  });

  it("prefers the running reason over the unsaved one", () => {
    const state = domain({
      canvasContexts: {
        c1: canvasContext({ nodes: [{ id: "n" }], hasBeenSaved: false, nodeStatus: { n: "running" } }),
      },
    });
    expect(closeGuardFor(canvasTab, state)).toMatchObject({ reason: "running" });
  });

  it("allows closing every non-canvas type when nothing is busy", () => {
    for (const type of ALL_TYPES) {
      if (type === "canvas") continue;
      expect(closeGuardFor({ id: "t", type, title: "t" }, domain()).kind).toBe("allow");
    }
  });

  // REFACTOR_PLAN.md PR 7 commit 2: closing an Agent tab used to have no
  // confirmation at all, unlike canvas -- these pin the fix.
  it("confirms closing an Agent tab with an active run", () => {
    const agentTab = { id: "agent", type: "agent" as const, title: "Agent" };
    const state = domain({ busyAgentTabIds: { agent: true } });
    expect(closeGuardFor(agentTab, state)).toEqual({
      kind: "confirm",
      reason: "running",
      tabId: "agent",
      title: "Agent",
    });
  });

  it("allows closing an Agent tab with no active run", () => {
    const agentTab = { id: "agent", type: "agent" as const, title: "Agent" };
    expect(closeGuardFor(agentTab, domain()).kind).toBe("allow");
  });

  // Bonus consistency fix, same commit: task already computed isBusy but
  // never gated closability on it.
  it("confirms closing a running Task tab", () => {
    const taskTab = { id: "t1", type: "task" as const, title: "Task", canvasId: "c1", taskNodeId: "n1" };
    const state = domain({ canvasContexts: { c1: canvasContext({ nodeStatus: { n1: "running" } }) } });
    expect(closeGuardFor(taskTab, state)).toEqual({
      kind: "confirm",
      reason: "running",
      tabId: "t1",
      title: "Task",
    });
  });

  it("allows closing an idle Task tab", () => {
    const taskTab = { id: "t1", type: "task" as const, title: "Task", canvasId: "c1", taskNodeId: "n1" };
    const state = domain({ canvasContexts: { c1: canvasContext({ nodeStatus: { n1: "success" } }) } });
    expect(closeGuardFor(taskTab, state).kind).toBe("allow");
  });
});
