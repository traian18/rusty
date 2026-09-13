import { describe, expect, it, vi } from "vitest";
import { runStartup } from "./runStartup";
import type { StartupStep } from "./types";

function step(overrides: Partial<StartupStep> & Pick<StartupStep, "id" | "run">): StartupStep {
  return { label: overrides.id, timeoutMs: 1000, ...overrides };
}

describe("runStartup: ordering and success", () => {
  it("runs steps strictly in array order", async () => {
    const order: string[] = [];
    const steps = [
      step({ id: "a", run: async () => { order.push("a"); } }),
      step({ id: "b", run: async () => { order.push("b"); } }),
      step({ id: "c", run: async () => { order.push("c"); } }),
    ];

    await runStartup(steps, { globalDeadlineMs: 1000 });

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("yields ready when every step settles ok", async () => {
    const steps = [
      step({ id: "a", run: async () => {} }),
      step({ id: "b", run: async () => {} }),
    ];

    const result = await runStartup(steps, { globalDeadlineMs: 1000 });

    expect(result.status).toBe("ready");
    expect(result.outcomes.map((o) => o.status)).toEqual(["ok", "ok"]);
  });

  it("calls onStepSettled once per step with the right index and total", async () => {
    const onStepSettled = vi.fn();
    const steps = [
      step({ id: "a", run: async () => {} }),
      step({ id: "b", run: async () => {} }),
    ];

    await runStartup(steps, { globalDeadlineMs: 1000, onStepSettled });

    expect(onStepSettled).toHaveBeenCalledTimes(2);
    expect(onStepSettled).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "a", status: "ok" }),
      0,
      2,
    );
    expect(onStepSettled).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "b", status: "ok" }),
      1,
      2,
    );
  });
});

describe("runStartup: failure and timeout, non-critical", () => {
  it("a non-critical step that throws degrades the run but does not stop it", async () => {
    const bRun = vi.fn(async () => {});
    const steps = [
      step({ id: "a", run: async () => { throw new Error("boom"); } }),
      step({ id: "b", run: bRun }),
    ];

    const result = await runStartup(steps, { globalDeadlineMs: 1000 });

    expect(bRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("degraded");
    const a = result.outcomes.find((o) => o.id === "a")!;
    expect(a.status).toBe("failed");
    expect((a.error as Error).message).toBe("boom");
  });

  it("a non-critical step that outlives its own timeout settles timedOut and does not halt the run", async () => {
    const bRun = vi.fn(async () => {});
    const steps = [
      step({ id: "a", timeoutMs: 5, run: () => new Promise<void>(() => {}) }),
      step({ id: "b", run: bRun }),
    ];

    const result = await runStartup(steps, { globalDeadlineMs: 1000 });

    expect(bRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("degraded");
    expect(result.outcomes.find((o) => o.id === "a")?.status).toBe("timedOut");
  }, 500);
});

describe("runStartup: critical steps", () => {
  it("a critical step that throws halts the run with status failed", async () => {
    const bRun = vi.fn(async () => {});
    const boom = new Error("secure config unreadable");
    const steps = [
      step({ id: "config", critical: true, run: async () => { throw boom; } }),
      step({ id: "b", run: bRun }),
    ];

    const result = await runStartup(steps, { globalDeadlineMs: 1000 });

    expect(bRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", stepId: "config", error: boom });
  });

  it("a critical step that times out halts the run with status failed", async () => {
    const steps = [
      step({ id: "config", critical: true, timeoutMs: 5, run: () => new Promise<void>(() => {}) }),
    ];

    const result = await runStartup(steps, { globalDeadlineMs: 1000 });

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.stepId).toBe("config");
  }, 500);

  it("a critical step merely skipped by an early abort degrades rather than hard-fails", async () => {
    const controller = new AbortController();
    controller.abort();
    const steps = [step({ id: "config", critical: true, run: async () => {} })];

    const result = await runStartup(steps, { globalDeadlineMs: 1000, signal: controller.signal });

    expect(result.status).toBe("degraded");
    expect(result.outcomes[0]).toMatchObject({ status: "skipped", skipReason: "aborted" });
  });
});

describe("runStartup: dependsOn skipping", () => {
  it("skips a step whose dependency did not settle ok, and skips transitively", async () => {
    const bRun = vi.fn(async () => {});
    const cRun = vi.fn(async () => {});
    const steps = [
      step({ id: "a", run: async () => { throw new Error("a failed"); } }),
      step({ id: "b", dependsOn: ["a"], run: bRun }),
      step({ id: "c", dependsOn: ["b"], run: cRun }),
    ];

    const result = await runStartup(steps, { globalDeadlineMs: 1000 });

    expect(bRun).not.toHaveBeenCalled();
    expect(cRun).not.toHaveBeenCalled();
    expect(result.outcomes.map((o) => ({ id: o.id, status: o.status, skipReason: o.skipReason }))).toEqual([
      { id: "a", status: "failed", skipReason: undefined },
      { id: "b", status: "skipped", skipReason: "dependency-failed" },
      { id: "c", status: "skipped", skipReason: "dependency-failed" },
    ]);
  });

  it("runs a dependent step normally once its dependency settles ok", async () => {
    const bRun = vi.fn(async () => {});
    const steps = [
      step({ id: "a", run: async () => {} }),
      step({ id: "b", dependsOn: ["a"], run: bRun }),
    ];

    const result = await runStartup(steps, { globalDeadlineMs: 1000 });

    expect(bRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ready");
  });
});

describe("runStartup: global deadline", () => {
  it("truncates a step's effective timeout to the remaining global budget", async () => {
    let clock = 0;
    const now = () => clock;
    const steps = [
      // Simulates consuming 90 of a 100ms global budget without any real wait.
      step({ id: "a", run: async () => { clock += 90; } }),
      // Wants 1000ms, but only ~10ms of budget remains -- must time out fast,
      // not after a real 1000ms wait (the test's own timeout would catch that).
      step({ id: "b", timeoutMs: 1000, run: () => new Promise<void>(() => {}) }),
    ];

    const result = await runStartup(steps, { globalDeadlineMs: 100, now });

    expect(result.outcomes.find((o) => o.id === "b")?.status).toBe("timedOut");
  }, 300);

  it("skips a step with budget-exhausted, without calling run, once no time remains", async () => {
    let clock = 0;
    const now = () => clock;
    const bRun = vi.fn(async () => {});
    const steps = [
      step({ id: "a", run: async () => { clock += 50; } }),
      step({ id: "b", run: bRun }),
    ];

    const result = await runStartup(steps, { globalDeadlineMs: 50, now });

    expect(bRun).not.toHaveBeenCalled();
    expect(result.outcomes.find((o) => o.id === "b")).toMatchObject({
      status: "skipped",
      skipReason: "budget-exhausted",
    });
  });
});

describe("runStartup: external abort", () => {
  it("skips steps not yet started once the external signal aborts mid-run", async () => {
    const controller = new AbortController();
    const bRun = vi.fn(async () => {});
    const steps = [
      step({ id: "a", run: async () => { controller.abort(); } }),
      step({ id: "b", run: bRun }),
    ];

    const result = await runStartup(steps, { globalDeadlineMs: 1000, signal: controller.signal });

    expect(bRun).not.toHaveBeenCalled();
    expect(result.outcomes.find((o) => o.id === "b")).toMatchObject({
      status: "skipped",
      skipReason: "aborted",
    });
    expect(result.status).toBe("degraded");
  });

  it("forwards an external abort to an in-flight step's own signal", async () => {
    const controller = new AbortController();
    let observedAborted = false;
    const steps = [
      step({
        id: "a",
        run: (ctx) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              observedAborted = ctx.signal.aborted;
              resolve();
            }, 20);
          }),
      }),
    ];

    const runPromise = runStartup(steps, { globalDeadlineMs: 1000, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await runPromise;

    expect(observedAborted).toBe(true);
  }, 500);
});
