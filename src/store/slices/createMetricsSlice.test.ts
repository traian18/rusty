import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMetricsTestStore } from "../../test/metricsTestStore";
import type { RunEvent, RunEventListener } from "../../services/agentHarnessClient";

/**
 * Every test re-imports both createMetricsSlice.ts and
 * agentHarnessClient.ts fresh via vi.resetModules() + dynamic import --
 * both modules hold module-level singleton state (the unsubscribe guard,
 * and the client instance itself), so a static top-level import would let
 * one test's subscription leak into the next.
 */
beforeEach(() => {
  vi.resetModules();
});

async function freshMetricsSlice() {
  const [{ createMetricsSlice }, agentHarnessClientModule] = await Promise.all([
    import("./createMetricsSlice"),
    import("../../services/agentHarnessClient"),
  ]);
  return { createMetricsSlice, agentHarnessClient: agentHarnessClientModule.agentHarnessClient };
}

describe("createMetricsSlice: creation-time purity (REFACTOR_PLAN.md PR 3a)", () => {
  it("does not touch agentHarnessClient.subscribeAll at slice creation", async () => {
    const { createMetricsSlice, agentHarnessClient } = await freshMetricsSlice();
    const subscribeAllSpy = vi.spyOn(agentHarnessClient, "subscribeAll");

    createMetricsTestStore(createMetricsSlice);

    expect(subscribeAllSpy).not.toHaveBeenCalled();
  });
});

describe("createMetricsSlice: initMetricsSubscription", () => {
  it("subscribes exactly once even when called multiple times", async () => {
    const { createMetricsSlice, agentHarnessClient } = await freshMetricsSlice();
    const subscribeAllSpy = vi.spyOn(agentHarnessClient, "subscribeAll");
    const store = createMetricsTestStore(createMetricsSlice);

    store.getState().initMetricsSubscription();
    store.getState().initMetricsSubscription();
    store.getState().initMetricsSubscription();

    expect(subscribeAllSpy).toHaveBeenCalledTimes(1);
  });

  it("routes a usage_update event to applyUsageUpdate", async () => {
    const { createMetricsSlice, agentHarnessClient } = await freshMetricsSlice();
    let capturedListener: RunEventListener | undefined;
    vi.spyOn(agentHarnessClient, "subscribeAll").mockImplementation((listener) => {
      capturedListener = listener;
      return () => {};
    });
    const store = createMetricsTestStore(createMetricsSlice);

    store.getState().initMetricsSubscription();
    capturedListener?.({ type: "usage_update", runId: "run-1", usage: { totalTokens: 42 } } as RunEvent);

    expect(store.getState().metricsTodayTotal).toBe(42);
  });

  it("ignores an event that isn't usage_update", async () => {
    const { createMetricsSlice, agentHarnessClient } = await freshMetricsSlice();
    let capturedListener: RunEventListener | undefined;
    vi.spyOn(agentHarnessClient, "subscribeAll").mockImplementation((listener) => {
      capturedListener = listener;
      return () => {};
    });
    const store = createMetricsTestStore(createMetricsSlice);

    store.getState().initMetricsSubscription();
    capturedListener?.({ type: "run_started", runId: "run-1" } as RunEvent);

    expect(store.getState().metricsTodayTotal).toBe(0);
  });
});
