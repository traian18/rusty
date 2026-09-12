/**
 * A minimal counting semaphore -- bookkeeping only, no timers or I/O, so
 * it's testable directly. Used by providerCoordinator.ts (which cannot
 * live under src/integrations/ itself -- it imports the store and
 * llmIntegrationService, which this directory's layering.test.ts
 * forbids) to bound how many sidecar status/discovery/quota checks run at
 * once: Copilot's status check can cold-start a whole SDK client, Codex
 * spawns a child process, and Claude Code's probe can shell out twice --
 * three of those firing unbounded at every launch is the "PBKDF2 storm"'s
 * sibling problem on the network side (REFACTOR_PLAN.md PR 3b).
 */
export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        active++;
        resolve();
      });
    });
  }

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) next();
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
