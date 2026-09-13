import { withTimeout, TimeoutError } from "./withTimeout";
import type { StartupResult, StartupStep, StepId, StepOutcome, StepStatus } from "./types";

export interface RunStartupOptions {
  /** Absolute wall-clock budget for the whole run, in ms, from the first
      step's start. Truncates any individual step's own timeoutMs once the
      remaining budget is smaller -- two 5s steps under a 6s global budget
      take 6s total, not 10s. */
  globalDeadlineMs: number;
  /** External cancellation, e.g. the splash's "Continue without waiting" or
      a Retry that wants to abandon an in-flight run. Steps not yet started
      when this fires are recorded "skipped" with reason "aborted"; a step
      already in flight has its own per-step signal aborted so it can bail
      out of its own `run`, but is not awaited further. */
  signal?: AbortSignal;
  /** Called synchronously right after each step settles (ok, failed,
      timedOut, or skipped), before the next step starts. */
  onStepSettled?: (outcome: StepOutcome, index: number, total: number) => void;
  /** Injectable clock, for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Runs `steps` in order, in one settled pass -- "settled" meaning resolved,
 * timed out, or skipped, never "everything succeeded". A step's own
 * `timeoutMs` never lets it exceed the run's global deadline; a critical
 * step settling anything but "ok" halts the run with status "failed";
 * everything else that settles non-"ok" makes the run "degraded" rather
 * than stopping it.
 *
 * Pure: takes only the step list and plain callbacks. No import from
 * ../store, ../services, or React belongs here -- see layering.test.ts.
 */
export async function runStartup(
  steps: readonly StartupStep[],
  options: RunStartupOptions,
): Promise<StartupResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.globalDeadlineMs;
  const outcomes: StepOutcome[] = [];
  const outcomeById = new Map<StepId, StepOutcome>();

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const stepStart = now();

    const settle = (status: StepStatus, extra: Partial<StepOutcome> = {}): StepOutcome => {
      const outcome: StepOutcome = { id: step.id, status, durationMs: now() - stepStart, ...extra };
      outcomes.push(outcome);
      outcomeById.set(step.id, outcome);
      options.onStepSettled?.(outcome, index, steps.length);
      return outcome;
    };

    if (options.signal?.aborted) {
      settle("skipped", { skipReason: "aborted" });
      continue;
    }

    const unmetDependency = (step.dependsOn ?? []).find(
      (depId) => outcomeById.get(depId)?.status !== "ok",
    );
    if (unmetDependency) {
      settle("skipped", { skipReason: "dependency-failed" });
      continue;
    }

    const effectiveTimeout = Math.min(step.timeoutMs, deadline - now());
    if (effectiveTimeout <= 0) {
      settle("skipped", { skipReason: "budget-exhausted" });
      continue;
    }

    const stepController = new AbortController();
    const forwardAbort = () => stepController.abort();
    options.signal?.addEventListener("abort", forwardAbort);

    let outcome: StepOutcome;
    try {
      await withTimeout(step.run({ signal: stepController.signal }), effectiveTimeout);
      outcome = settle("ok");
    } catch (error) {
      // Let a still-running, non-cancellable step observe the timeout via
      // its own signal even though we stop waiting for it here.
      stepController.abort();
      outcome = error instanceof TimeoutError ? settle("timedOut") : settle("failed", { error });
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
    }

    // A critical step that actually failed or timed out is fatal. A
    // critical step that was merely *skipped* (e.g. the user hit "Continue
    // without waiting" before it ran) is not -- that is the existing
    // "Continue anyway" path, and it degrades rather than hard-fails.
    if (step.critical && (outcome.status === "failed" || outcome.status === "timedOut")) {
      return {
        status: "failed",
        stepId: step.id,
        error: outcome.status === "failed" ? outcome.error : new TimeoutError(`${step.id} timed out`),
        outcomes,
      };
    }
  }

  const allOk = outcomes.every((outcome) => outcome.status === "ok");
  return { status: allOk ? "ready" : "degraded", outcomes };
}
