import { describe, expect, it } from "vitest";
import { createStartupTestStore } from "../../test/startupTestStore";

describe("createStartupSlice", () => {
  it("starts idle", () => {
    expect(createStartupTestStore().getState().startupState).toEqual({ status: "idle" });
  });

  it("setStartupState replaces the whole state with whatever it's given", () => {
    const store = createStartupTestStore();

    store.getState().setStartupState({ status: "running", stepId: "config", message: "Loading configuration…", done: 0, total: 4 });
    expect(store.getState().startupState).toEqual({
      status: "running",
      stepId: "config",
      message: "Loading configuration…",
      done: 0,
      total: 4,
    });

    store.getState().setStartupState({ status: "ready" });
    expect(store.getState().startupState).toEqual({ status: "ready" });

    store.getState().setStartupState({
      status: "degraded",
      failures: [{ id: "sidecar", status: "timedOut", durationMs: 1500 }],
    });
    expect(store.getState().startupState).toEqual({
      status: "degraded",
      failures: [{ id: "sidecar", status: "timedOut", durationMs: 1500 }],
    });

    const error = new Error("boom");
    store.getState().setStartupState({ status: "failed", stepId: "config", error });
    expect(store.getState().startupState).toEqual({ status: "failed", stepId: "config", error });
  });
});
