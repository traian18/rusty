import { describe, expect, it } from "vitest";
import { buildRetryStepList } from "./buildRetryStepList";
import type { StartupStep } from "./types";

function step(id: string, overrides: Partial<StartupStep> = {}): StartupStep {
  return { id, label: id, timeoutMs: 1000, run: async () => {}, ...overrides };
}

describe("buildRetryStepList", () => {
  it("retries everything when nothing settled ok (today's degenerate full-rerun case)", async () => {
    const original = [step("a"), step("b"), step("c")];
    const retryList = buildRetryStepList(original, [
      { id: "a", status: "failed", durationMs: 1 },
      { id: "b", status: "skipped", skipReason: "dependency-failed", durationMs: 0 },
      { id: "c", status: "skipped", skipReason: "dependency-failed", durationMs: 0 },
    ]);

    // Every step's real run function survives -- identical to a full rerun.
    expect(retryList.map((s) => s.run)).toEqual(original.map((s) => s.run));
  });

  it("replaces a step that already succeeded with a no-op", async () => {
    const original = [step("a"), step("b")];
    const retryList = buildRetryStepList(original, [
      { id: "a", status: "ok", durationMs: 1 },
      { id: "b", status: "failed", durationMs: 1 },
    ]);

    expect(retryList[0].run).not.toBe(original[0].run);
    await expect(retryList[0].run({ signal: new AbortController().signal })).resolves.toBeUndefined();
    // b's real run function survives, untouched.
    expect(retryList[1].run).toBe(original[1].run);
  });

  it("preserves every other field (id, label, critical, timeoutMs, dependsOn) on a no-op'd step", () => {
    const original = [step("a", { label: "A label", critical: true, timeoutMs: 3000, dependsOn: ["z"] })];
    const retryList = buildRetryStepList(original, [{ id: "a", status: "ok", durationMs: 1 }]);

    expect(retryList[0]).toMatchObject({ id: "a", label: "A label", critical: true, timeoutMs: 3000, dependsOn: ["z"] });
  });

  it("treats a step absent from lastOutcomes (never reached last time) as needing a real run", () => {
    const original = [step("a"), step("b")];
    // Simulates a critical failure on "a": "b" never even got an outcome.
    const retryList = buildRetryStepList(original, [{ id: "a", status: "failed", durationMs: 1 }]);

    expect(retryList[1].run).toBe(original[1].run);
  });
});
