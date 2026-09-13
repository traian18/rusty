import { describe, expect, it } from "vitest";
import { createSemaphore } from "./concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createSemaphore", () => {
  it("runs tasks immediately up to the limit", async () => {
    const sem = createSemaphore(2);
    let concurrentCount = 0;
    let maxObserved = 0;

    const task = async () => {
      concurrentCount++;
      maxObserved = Math.max(maxObserved, concurrentCount);
      await Promise.resolve();
      concurrentCount--;
    };

    await Promise.all([sem.run(task), sem.run(task), sem.run(task)]);
    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it("queues a task past the limit until one finishes", async () => {
    const sem = createSemaphore(1);
    const first = deferred<void>();
    const order: string[] = [];

    const p1 = sem.run(async () => {
      order.push("first-start");
      await first.promise;
      order.push("first-end");
    });
    const p2 = sem.run(async () => {
      order.push("second-start");
    });

    // Give the microtask queue a chance to run p2's acquire attempt --
    // it must NOT have started yet, since the slot is held by p1.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);

    first.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("propagates a task's rejection without leaking its slot", async () => {
    const sem = createSemaphore(1);

    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The slot must have been released despite the throw -- otherwise
    // every later call would queue forever.
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("runs the next queued task in FIFO order", async () => {
    const sem = createSemaphore(1);
    const gate = deferred<void>();
    const order: string[] = [];

    const p1 = sem.run(async () => {
      await gate.promise;
    });
    const p2 = sem.run(async () => {
      order.push("second");
    });
    const p3 = sem.run(async () => {
      order.push("third");
    });

    gate.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(["second", "third"]);
  });
});
