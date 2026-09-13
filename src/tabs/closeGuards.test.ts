import { describe, expect, it } from "vitest";
import { evaluateClose, isClosable } from "./closeGuards";
import type { CloseEvaluationState } from "./closeGuards";
import type { TabDomainState, TabInstance } from "./types";

const emptyDomain: TabDomainState = {
  canvasContexts: {},
  canvasHistories: {},
  agentChats: {},
  agentStreams: {},
  agentPermissionRequests: {},
  busyAgentTabIds: {},
};

function canvasTab(id: string): TabInstance {
  return { id, type: "canvas", title: "Pipeline", status: "idle", dirty: false, canvasId: id };
}

function state(
  tabs: TabInstance[],
  domain: Partial<TabDomainState> = {},
): CloseEvaluationState {
  return { ...emptyDomain, ...domain, tabs };
}

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

describe("evaluateClose", () => {
  it("allows closing an unknown tab id", () => {
    expect(evaluateClose(state([]), "nope").kind).toBe("allow");
  });

  it("surfaces the running confirmation for a busy canvas", () => {
    const s = state([canvasTab("c1")], {
      canvasContexts: { c1: canvasContext({ nodeStatus: { n: "running" } }) },
    });
    expect(evaluateClose(s, "c1")).toEqual({
      kind: "confirm",
      reason: "running",
      tabId: "c1",
      title: "Pipeline",
    });
  });

  it("surfaces the unsaved confirmation for a dirty canvas", () => {
    const s = state([canvasTab("c1")], {
      canvasContexts: { c1: canvasContext({ nodes: [{ id: "n" }] }) },
    });
    expect(evaluateClose(s, "c1")).toMatchObject({ kind: "confirm", reason: "unsaved" });
  });

  it("allows closing a saved, idle canvas", () => {
    const s = state([canvasTab("c1")], {
      canvasContexts: { c1: canvasContext({ nodes: [{ id: "n" }], hasBeenSaved: true }) },
    });
    expect(evaluateClose(s, "c1").kind).toBe("allow");
  });

  it("allows closing a canvas whose context has already gone", () => {
    expect(evaluateClose(state([canvasTab("c1")]), "c1").kind).toBe("allow");
  });

  it("allows closing a file tab regardless of domain state", () => {
    const file: TabInstance = {
      id: "file:/a.ts",
      type: "file",
      title: "a.ts",
      status: "idle",
      dirty: false,
      path: "/a.ts",
    };
    expect(evaluateClose(state([file]), "file:/a.ts").kind).toBe("allow");
  });
});

describe("isClosable", () => {
  it("reports every current tab type as closable", () => {
    expect(isClosable(canvasTab("c1"))).toBe(true);
  });
});
