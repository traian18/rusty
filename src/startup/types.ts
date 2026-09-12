/**
 * Types for the startup coordinator (REFACTOR_PLAN.md PR 3a). Pure data --
 * no store, service, or React import belongs here or anywhere else in
 * src/startup/; see layering.test.ts.
 */

export type StepId = string;

export type StepStatus = "ok" | "failed" | "timedOut" | "skipped";

/** Present only when `status === "skipped"`. */
export type SkipReason =
  /** A step this one `dependsOn` did not settle "ok". */
  | "dependency-failed"
  /** The run's external signal (e.g. "Continue without waiting") fired
      before this step started. */
  | "aborted"
  /** The global deadline left no time budget for this step to even start. */
  | "budget-exhausted";

export interface StepOutcome {
  id: StepId;
  status: StepStatus;
  /** Only for `status === "skipped"`. */
  skipReason?: SkipReason;
  /** Only for `status === "failed"`. */
  error?: unknown;
  durationMs: number;
}

export interface StepContext {
  /**
   * Fires on timeout OR external abort. Most steps in 3a wrap work that
   * cannot itself be cancelled (WebCrypto, Tauri `invoke` have no
   * AbortSignal) -- `run` should check `signal.aborted` immediately before
   * any `set()` call so a late-arriving result after the run has moved on
   * is discarded rather than landing out of order.
   */
  signal: AbortSignal;
}

export interface StartupStep {
  id: StepId;
  /** Shown in the splash while this step is the active one. */
  label: string;
  /**
   * A critical step that settles anything other than "ok" halts the whole
   * run with StartupResult.status "failed" -- everything else degrades but
   * lets startup proceed. Exactly one step (secure-config) is critical in
   * 3a.
   */
  critical?: boolean;
  timeoutMs: number;
  /**
   * Steps this one depends on. If any dependency's outcome isn't "ok" by
   * the time this step is reached, it is skipped without running -- this
   * is what makes an unreachable sidecar cost one health-check budget
   * instead of N sequential provider timeouts (3b).
   */
  dependsOn?: readonly StepId[];
  run: (ctx: StepContext) => Promise<void>;
}

export type StartupResult =
  | { status: "ready"; outcomes: StepOutcome[] }
  | { status: "degraded"; outcomes: StepOutcome[] }
  | { status: "failed"; stepId: StepId; error: unknown; outcomes: StepOutcome[] };

/**
 * The store-facing lifecycle state -- distinct from StartupResult (the
 * executor's one-shot return value) because the UI needs to see progress
 * WHILE a run is in flight, not just its final outcome. Shaped like the
 * existing `LspStatus` (src/services/lspService.ts) rather than a flat
 * phase-name union: REFACTOR_PLAN.md's draft `StartupPhase` union conflates
 * lifecycle status, progress position, and outcome into one dimension, so
 * it can't express "running, at the workspace step, with the sidecar step
 * already degraded" -- the single most common real state.
 */
export type StartupState =
  | { status: "idle" }
  | { status: "running"; stepId: StepId; message: string; done: number; total: number }
  | { status: "ready" }
  | { status: "degraded"; failures: StepOutcome[] }
  | { status: "failed"; stepId: StepId; error: unknown };

/**
 * Derives the terminal StartupState from an executor result. The "running"
 * state is produced separately and live, from runStartup's onStepSettled
 * callback as a run progresses -- this only covers the three ways a run can
 * finish.
 */
export function startupStateFromResult(result: StartupResult): StartupState {
  // Constructed explicitly rather than `return result` for the failed case:
  // StartupResult's failed variant also carries the full `outcomes` array,
  // which StartupState's failed variant deliberately does not -- that array
  // is executor-internal detail, not part of the state the UI is meant to
  // read.
  if (result.status === "failed") return { status: "failed", stepId: result.stepId, error: result.error };
  if (result.status === "ready") return { status: "ready" };
  return { status: "degraded", failures: result.outcomes.filter((outcome) => outcome.status !== "ok") };
}
