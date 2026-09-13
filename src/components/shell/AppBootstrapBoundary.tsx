import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../../store";
import { runStartup } from "../../startup/runStartup";
import { startupStateFromResult } from "../../startup/types";
import { buildRetryStepList } from "../../startup/buildRetryStepList";
import type { StartupResult, StartupState, StartupStep, StepOutcome } from "../../startup/types";
import { STARTUP_STEPS } from "./startupSteps";
import { startProviderCoordinator } from "./providerCoordinator";
import { startWorkspaceFsWatch } from "./workspaceFsWatchCoordinator";
import { AppBootstrapBoundaryView } from "./AppBootstrapBoundary.view";

export type ShellBootstrapStatus = "pending" | "ready" | "failed";

/**
 * The splash is now the normal case (a blocking startup, per REFACTOR_PLAN
 * .md PR 3a's design decision), so this delay is no longer "prevent a
 * flash of splash" alone -- it still does that for a fast/warm boot, but
 * MIN_VISIBLE_UI_MS below is the complementary half: once the splash HAS
 * appeared, it stays for at least that long, so a boot that's fast-but-not-
 * instant doesn't flash on and back off within one frame.
 */
const PENDING_UI_DELAY_MS = 150;
const MIN_VISIBLE_UI_MS = 400;
/** How long the pending screen must have been visible before offering
    "Continue without waiting". */
const CONTINUE_WITHOUT_WAITING_DELAY_MS = 2_500;
/** Hard ceiling on the whole run; anything still unsettled past this is
    abandoned -- the splash can never outlive it. */
const GLOBAL_DEADLINE_MS = 8_000;

/**
 * Module-level, surviving StrictMode's double-invoke by construction: the
 * effect below calls beginRun() on every mount, but a second invocation
 * (StrictMode's remount) sees `activeRun` already set and adopts it rather
 * than starting a second one -- the same dedupe agentHarnessClient.connect()
 * already uses via its own connectPromise. Never cleared by the component's
 * own effect cleanup (StrictMode's cleanup fires BETWEEN the two
 * invocations; aborting there would kill the only run) -- only by the run
 * itself finishing, or by retryStartup() explicitly discarding it.
 */
let activeRun: Promise<StartupResult> | undefined;
let activeAbortController: AbortController | undefined;
/** The most recently completed run's per-step outcomes, for Retry to
    consult -- see buildRetryStepList. Empty until the first run settles. */
let lastOutcomes: StepOutcome[] = [];

function beginRun(steps: readonly StartupStep[]): Promise<StartupResult> {
  if (activeRun) return activeRun;

  activeAbortController = new AbortController();
  const controller = activeAbortController;

  const firstStep = steps[0];
  if (firstStep) {
    useWorkspaceStore.getState().setStartupState({
      status: "running",
      stepId: firstStep.id,
      message: firstStep.label,
      done: 0,
      total: steps.length,
    });
  }

  activeRun = runStartup(steps, {
    globalDeadlineMs: GLOBAL_DEADLINE_MS,
    signal: controller.signal,
    onStepSettled: (outcome, index, total) => {
      // Only advance the displayed step when the one that just settled
      // actually succeeded. Caught live: a critical step's outcome fires
      // this callback too, one tick before runStartup's own critical-check
      // returns "failed" -- without this guard, the splash would flash the
      // NEXT step's label as "running" for a frame on the way to a failure
      // it's never actually going to reach (and likewise a skipped
      // dependent step has no business being shown as "running" either).
      if (outcome.status !== "ok") return;
      const next = steps[index + 1];
      if (!next) return;
      useWorkspaceStore.getState().setStartupState({
        status: "running",
        stepId: next.id,
        message: next.label,
        done: index + 1,
        total,
      });
    },
  })
    .then((result) => {
      lastOutcomes = result.outcomes;
      useWorkspaceStore.getState().setStartupState(startupStateFromResult(result));
      // Started here, not inside a startup step (REFACTOR_PLAN.md PR 3b):
      // providers don't exist meaningfully in the store until secure-config
      // has run, and saveSecureConfig is a no-op until secureConfigLoaded
      // is true, so provider work started any earlier would settle into a
      // registry nobody can act on and any persistence it later needs
      // would silently fail. Runs regardless of whether this run ended
      // ready/degraded/failed -- even after a critical failure, checking
      // providers against whatever defaults are in the store is harmless,
      // and "Continue anyway" shouldn't mean waiting even longer for
      // integrations to settle. Idempotent, so Retry calling beginRun()
      // again is a no-op here.
      startProviderCoordinator();
      // Started here for the same reason: rootPath (if restored at all)
      // only exists in the store once secure-config's restore step has
      // run, and the coordinator's own store subscription handles every
      // rootPath change from here on regardless of when this particular
      // run settled.
      startWorkspaceFsWatch();
      return result;
    })
    .finally(() => {
      activeRun = undefined;
      activeAbortController = undefined;
    });

  return activeRun;
}

/**
 * Discards any in-flight run's bookkeeping and starts a fresh one, re-
 * running only the sub-DAG rooted at whatever didn't settle "ok" last time
 * (buildRetryStepList) -- a step that already succeeded is replaced with a
 * no-op rather than genuinely re-invoked, and anything that transitively
 * depended on a step actually being retried gets re-evaluated naturally by
 * runStartup's own dependsOn check. With today's three-step registry
 * (secure-config both critical and first), a critical failure means
 * nothing downstream ever ran, so this is currently indistinguishable from
 * a full re-run -- the distinction starts mattering once 3b adds steps
 * that can fail independently of ones that already succeeded.
 */
function retryStartup(): void {
  activeAbortController?.abort();
  activeRun = undefined;
  activeAbortController = undefined;
  void beginRun(buildRetryStepList(STARTUP_STEPS, lastOutcomes));
}

function abortActiveRun(): void {
  activeAbortController?.abort();
}

/**
 * Owns application bootstrap via the startup coordinator (REFACTOR_PLAN.md
 * PR 3a): src/components/shell/startupSteps.ts's ordered steps, run through
 * src/startup/runStartup.ts. Replaces the ad hoc three-line sequence this
 * component used through commit 10 -- StartupState (idle/running/ready/
 * degraded/failed) now lives in the store, and this component's only job is
 * to kick off beginRun() once and translate the store's live state into
 * AppBootstrapBoundaryView's existing three-status prop contract.
 *
 * "degraded" renders exactly like "ready" for now (StartupDegradedBanner is
 * commit 12); a real "failed" (a critical step -- secure-config -- actually
 * throwing or timing out, not merely being skipped by an early abort) is
 * the only state that still shows the dedicated failure screen.
 */
export const AppBootstrapBoundary: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const storeStartupState = useWorkspaceStore((state) => state.startupState);
  const [displayState, setDisplayState] = useState<StartupState>(storeStartupState);
  const [showPendingUi, setShowPendingUi] = useState(false);
  const [showContinueWithoutWaiting, setShowContinueWithoutWaiting] = useState(false);
  const pendingShownAtRef = useRef<number | null>(null);

  useEffect(() => {
    const pendingTimer = setTimeout(() => {
      setShowPendingUi(true);
      pendingShownAtRef.current = Date.now();
    }, PENDING_UI_DELAY_MS);
    const continueTimer = setTimeout(
      () => setShowContinueWithoutWaiting(true),
      CONTINUE_WITHOUT_WAITING_DELAY_MS,
    );

    void beginRun(STARTUP_STEPS);

    return () => {
      clearTimeout(pendingTimer);
      clearTimeout(continueTimer);
    };
  }, []);

  useEffect(() => {
    // A real failure surfaces immediately -- never worth hiding for UX
    // smoothness -- and "running" always propagates immediately too (it's
    // what drives the step label/progress). Only a ready/degraded
    // transition respects the minimum-visible-duration floor, and only
    // once the splash actually appeared: a run that finished inside the
    // 150ms gate never showed anything, so there's nothing to avoid
    // flashing.
    if (
      storeStartupState.status === "failed" ||
      storeStartupState.status === "running" ||
      storeStartupState.status === "idle" ||
      !showPendingUi ||
      pendingShownAtRef.current === null
    ) {
      setDisplayState(storeStartupState);
      return;
    }
    const remaining = MIN_VISIBLE_UI_MS - (Date.now() - pendingShownAtRef.current);
    if (remaining <= 0) {
      setDisplayState(storeStartupState);
      return;
    }
    const timer = setTimeout(() => setDisplayState(storeStartupState), remaining);
    return () => clearTimeout(timer);
  }, [storeStartupState, showPendingUi]);

  const handleContinue = () => {
    if (displayState.status === "running" || displayState.status === "idle") {
      // Pending screen's "Continue without waiting": abort the real run so
      // it settles (degraded) with accurate per-step outcomes, rather than
      // just forcing the UI past it and discarding that information.
      abortActiveRun();
    } else {
      // Failed screen's "Continue anyway": the run already fully settled
      // as a hard failure -- there is nothing left in flight to abort.
      useWorkspaceStore.getState().setStartupState({ status: "ready" });
    }
  };

  const status: ShellBootstrapStatus =
    displayState.status === "failed"
      ? "failed"
      : displayState.status === "ready" || displayState.status === "degraded"
        ? "ready"
        : "pending";

  return (
    <AppBootstrapBoundaryView
      status={status}
      showPendingUi={showPendingUi}
      message={displayState.status === "running" ? displayState.message : undefined}
      done={displayState.status === "running" ? displayState.done : undefined}
      total={displayState.status === "running" ? displayState.total : undefined}
      showContinueWithoutWaiting={showContinueWithoutWaiting && status === "pending"}
      error={displayState.status === "failed" ? displayState.error : undefined}
      onRetry={retryStartup}
      onContinue={handleContinue}
    >
      {children}
    </AppBootstrapBoundaryView>
  );
};
