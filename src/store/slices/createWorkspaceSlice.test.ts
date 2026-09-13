import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceTestStore } from "../../test/workspaceTestStore";

describe("createWorkspaceSlice: loadWorkspaceData (REFACTOR_PLAN.md PR 3a)", () => {
  it("calls loadGitStatus, loadSkills, and loadMetricsSummary", async () => {
    const loadGitStatus = vi.fn().mockResolvedValue(undefined);
    const loadSkills = vi.fn().mockResolvedValue(undefined);
    const loadMetricsSummary = vi.fn().mockResolvedValue(undefined);
    const store = createWorkspaceTestStore({ loadGitStatus, loadSkills, loadMetricsSummary } as any);

    await store.getState().loadWorkspaceData();

    expect(loadGitStatus).toHaveBeenCalledTimes(1);
    expect(loadSkills).toHaveBeenCalledTimes(1);
    expect(loadMetricsSummary).toHaveBeenCalledTimes(1);
  });

  it("one of the three throwing does not stop the others from running", async () => {
    const loadGitStatus = vi.fn().mockRejectedValue(new Error("git status failed"));
    const loadSkills = vi.fn().mockResolvedValue(undefined);
    const loadMetricsSummary = vi.fn().mockResolvedValue(undefined);
    const store = createWorkspaceTestStore({ loadGitStatus, loadSkills, loadMetricsSummary } as any);

    // Promise.allSettled: loadWorkspaceData itself never rejects, even
    // though one of its three loaders did.
    await expect(store.getState().loadWorkspaceData()).resolves.toBeUndefined();

    expect(loadSkills).toHaveBeenCalledTimes(1);
    expect(loadMetricsSummary).toHaveBeenCalledTimes(1);
  });
});

describe("createWorkspaceSlice: setRootPath calls loadWorkspaceData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires loadWorkspaceData exactly once, not the three loaders directly", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    const loadWorkspaceData = vi.fn().mockResolvedValue(undefined);
    const saveSecureConfig = vi.fn().mockResolvedValue(undefined);
    const store = createWorkspaceTestStore({ loadWorkspaceData, saveSecureConfig } as any);

    store.getState().setRootPath("/some/workspace");

    expect(loadWorkspaceData).toHaveBeenCalledTimes(1);
  });

  it("still resets tabs/canvases/nodes exactly as before", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    const loadWorkspaceData = vi.fn().mockResolvedValue(undefined);
    const saveSecureConfig = vi.fn().mockResolvedValue(undefined);
    const store = createWorkspaceTestStore({
      loadWorkspaceData,
      saveSecureConfig,
      nodes: [{ id: "stale-node" }] as any,
      edges: [{ id: "stale-edge" }] as any,
      selectedNodeId: "stale-node",
    } as any);

    store.getState().setRootPath("/some/workspace");

    const state = store.getState();
    expect(state.rootPath).toBe("/some/workspace");
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.selectedNodeId).toBeNull();
    expect(state.expandedPaths).toEqual({});
    expect(state.revealPath).toBeNull();
  });
});
