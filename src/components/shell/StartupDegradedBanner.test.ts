import { describe, expect, it } from "vitest";
import { describeFailure } from "./StartupDegradedBanner";

describe("describeFailure", () => {
  it("describes a timed-out step using its real label", () => {
    expect(describeFailure({ id: "sidecar-health", status: "timedOut", durationMs: 2000 }))
      .toBe("Checking the agent sidecar timed out");
  });

  it("describes a failed step", () => {
    expect(describeFailure({ id: "workspace-restore", status: "failed", durationMs: 10, error: new Error("boom") }))
      .toBe("Restoring your workspace failed");
  });

  it("describes a dependency-skipped step", () => {
    expect(
      describeFailure({ id: "workspace-restore", status: "skipped", skipReason: "dependency-failed", durationMs: 0 }),
    ).toBe("Restoring your workspace was skipped (a dependency didn't complete)");
  });

  it("describes an aborted-skip step", () => {
    expect(describeFailure({ id: "sidecar-health", status: "skipped", skipReason: "aborted", durationMs: 0 }))
      .toBe("Checking the agent sidecar was skipped (cancelled)");
  });

  it("describes a budget-exhausted skip step", () => {
    expect(
      describeFailure({ id: "sidecar-health", status: "skipped", skipReason: "budget-exhausted", durationMs: 0 }),
    ).toBe("Checking the agent sidecar was skipped (no time left)");
  });

  it("falls back to the raw id for an unknown step", () => {
    expect(describeFailure({ id: "some-future-step", status: "failed", durationMs: 5 }))
      .toBe("some-future-step failed");
  });
});
