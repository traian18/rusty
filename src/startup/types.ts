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
