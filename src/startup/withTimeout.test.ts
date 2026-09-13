import { describe, expect, it } from "vitest";
import { withTimeout, TimeoutError } from "./withTimeout";

describe("withTimeout", () => {
  it("resolves with the operation's value when it settles before the timeout", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1000)).resolves.toBe("done");
  });

  it("rejects with TimeoutError when the operation is slower than the timeout", async () => {
    const neverSettles = new Promise<void>(() => {});
    await expect(withTimeout(neverSettles, 5)).rejects.toBeInstanceOf(TimeoutError);
  }, 500);

  it("rejects immediately for a non-positive timeout", async () => {
    const start = Date.now();
    await expect(withTimeout(new Promise<void>(() => {}), 0)).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("propagates the operation's own rejection when it loses to no timeout", async () => {
    const boom = new Error("boom");
    await expect(withTimeout(Promise.reject(boom), 1000)).rejects.toBe(boom);
  });

  it("does not leave an unhandled rejection when the abandoned operation later rejects", async () => {
    let rejectLate!: (error: unknown) => void;
    const lateOperation = new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });

    await expect(withTimeout(lateOperation, 5)).rejects.toBeInstanceOf(TimeoutError);
    // The operation is still "in flight" from withTimeout's perspective --
    // settling it late must not throw or produce a process-level warning.
    rejectLate(new Error("late failure, after the caller stopped waiting"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }, 500);
});
