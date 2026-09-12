import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STARTUP_STEPS, pollSidecarHealth, restoreWorkspace } from "./startupSteps";
import { useWorkspaceStore } from "../../store";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("STARTUP_STEPS: registry shape", () => {
  it("has unique ids", () => {
    const ids = STARTUP_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every dependsOn id resolves to a step earlier in the array", () => {
    const idsSoFar = new Set<string>();
    for (const step of STARTUP_STEPS) {
      for (const depId of step.dependsOn ?? []) {
        expect(idsSoFar.has(depId)).toBe(true);
      }
      idsSoFar.add(step.id);
    }
  });

  it("every step has a non-empty label and a positive timeout", () => {
    for (const step of STARTUP_STEPS) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("exactly one step (secure-config) is critical", () => {
    const criticalIds = STARTUP_STEPS.filter((step) => step.critical).map((step) => step.id);
    expect(criticalIds).toEqual(["secure-config"]);
  });
});

describe("pollSidecarHealth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves as soon as one attempt returns ok", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await expect(pollSidecarHealth(new AbortController().signal)).resolves.toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed attempt and eventually resolves", async () => {
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await expect(pollSidecarHealth(new AbortController().signal)).resolves.toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("throws once its internal deadline passes without a healthy response", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("connection refused"));
    await expect(pollSidecarHealth(new AbortController().signal)).rejects.toThrow("connection refused");
  }, 3000);

  it("returns early, without throwing, once the external signal aborts", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error("connection refused");
    });

    await expect(pollSidecarHealth(controller.signal)).resolves.toBeUndefined();
  });
});

describe("restoreWorkspace", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      pendingWorkspaceRestorePath: null,
      secureConfigLoaded: false,
      rootPath: "",
      fileTree: [],
    });
    vi.mocked(invoke).mockReset();
  });

  it("sets secureConfigLoaded and does nothing else when there is nothing pending", async () => {
    await restoreWorkspace({ signal: new AbortController().signal });

    expect(useWorkspaceStore.getState().secureConfigLoaded).toBe(true);
    expect(useWorkspaceStore.getState().rootPath).toBe("");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("restores rootPath/fileTree and loads workspace data on success", async () => {
    useWorkspaceStore.setState({ pendingWorkspaceRestorePath: "/Users/test/my-project" });
    const loadWorkspaceData = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ loadWorkspaceData } as any);
    vi.mocked(invoke).mockResolvedValue([{ name: "src", path: "src", is_dir: true, children: [] }]);

    await restoreWorkspace({ signal: new AbortController().signal });

    const state = useWorkspaceStore.getState();
    expect(state.rootPath).toBe("/Users/test/my-project");
    expect(state.fileTree).toEqual([{ name: "src", path: "src", is_dir: true, children: [] }]);
    expect(state.pendingWorkspaceRestorePath).toBeNull();
    expect(state.secureConfigLoaded).toBe(true);
    expect(loadWorkspaceData).toHaveBeenCalledTimes(1);
  });

  it("sets secureConfigLoaded even when the underlying invoke fails, so saving is never permanently blocked", async () => {
    useWorkspaceStore.setState({ pendingWorkspaceRestorePath: "/does/not/matter/here" });
    vi.mocked(invoke).mockRejectedValue(new Error("no such directory"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await restoreWorkspace({ signal: new AbortController().signal });

    expect(useWorkspaceStore.getState().secureConfigLoaded).toBe(true);
    // Left in place (not cleared to null) precisely so a Retry has
    // something to retry against.
    expect(useWorkspaceStore.getState().pendingWorkspaceRestorePath).toBe("/does/not/matter/here");
    consoleErrorSpy.mockRestore();
  });

  it("discards a late-arriving result once the signal is already aborted, but still sets secureConfigLoaded", async () => {
    useWorkspaceStore.setState({ pendingWorkspaceRestorePath: "/Users/test/my-project" });
    const loadWorkspaceData = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ loadWorkspaceData } as any);
    vi.mocked(invoke).mockResolvedValue([{ name: "src", path: "src", is_dir: true, children: [] }]);
    const controller = new AbortController();
    controller.abort();

    await restoreWorkspace({ signal: controller.signal });

    const state = useWorkspaceStore.getState();
    // The restore's own writes are discarded...
    expect(state.rootPath).toBe("");
    expect(loadWorkspaceData).not.toHaveBeenCalled();
    // ...but secureConfigLoaded still flips, so saving isn't blocked forever.
    expect(state.secureConfigLoaded).toBe(true);
  });
});
