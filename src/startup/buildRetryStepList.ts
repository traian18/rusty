import type { StartupStep, StepOutcome } from "./types";

/**
 * Builds the step list for a Retry: a step whose last outcome was "ok" is
 * replaced with a trivial no-op (still contributing a fresh "ok" outcome,
 * so anything depending on it remains satisfied) rather than genuinely
 * re-run; every other step -- failed, timed out, or skipped -- keeps its
 * real `run`. runStartup's own dependsOn evaluation then naturally re-runs
 * anything that transitively depended on a step that's actually being
 * retried, evaluated fresh against THIS run's outcomes as they accumulate
 * -- this needs no separate graph walk of its own (REFACTOR_PLAN.md PR 3a).
 *
 * With today's three-step registry (secure-config is both critical and
 * first), a critical failure means nothing downstream ever ran, so this
 * degenerates to "retry everything" -- identical to the interim full-rerun
 * behavior it replaces. The distinction starts mattering once 3b adds more
 * steps where a later, non-critical one can fail independently of earlier
 * steps that already succeeded.
 */
export function buildRetryStepList(
  steps: readonly StartupStep[],
  lastOutcomes: readonly StepOutcome[],
): StartupStep[] {
  const lastStatusById = new Map(lastOutcomes.map((outcome) => [outcome.id, outcome.status]));
  return steps.map((step) =>
    lastStatusById.get(step.id) === "ok" ? { ...step, run: async () => {} } : step,
  );
}
