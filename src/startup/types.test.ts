import { describe, expect, it } from "vitest";
import { startupStateFromResult } from "./types";
import type { StartupResult } from "./types";

describe("startupStateFromResult", () => {
  it("maps a ready result to { status: ready }", () => {
    const result: StartupResult = { status: "ready", outcomes: [{ id: "a", status: "ok", durationMs: 1 }] };
    expect(startupStateFromResult(result)).toEqual({ status: "ready" });
  });

  it("maps a failed result straight through, including stepId and error", () => {
    const error = new Error("boom");
    const result: StartupResult = {
      status: "failed",
      stepId: "config",
      error,
      outcomes: [{ id: "config", status: "failed", error, durationMs: 5 }],
    };
    expect(startupStateFromResult(result)).toEqual({ status: "failed", stepId: "config", error });
  });

  it("maps a degraded result to only its non-ok outcomes as failures", () => {
    const result: StartupResult = {
      status: "degraded",
      outcomes: [
        { id: "a", status: "ok", durationMs: 1 },
        { id: "b", status: "timedOut", durationMs: 100 },
        { id: "c", status: "skipped", skipReason: "dependency-failed", durationMs: 0 },
      ],
    };
    expect(startupStateFromResult(result)).toEqual({
      status: "degraded",
      failures: [
        { id: "b", status: "timedOut", durationMs: 100 },
        { id: "c", status: "skipped", skipReason: "dependency-failed", durationMs: 0 },
      ],
    });
  });
});
