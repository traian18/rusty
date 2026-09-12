import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useWorkspaceStore } from "../../store";
import { STARTUP_STEPS } from "./startupSteps";
import type { StepOutcome } from "../../startup/types";
import styles from "./StartupDegradedBanner.module.css";

const STEP_LABELS: Record<string, string> = Object.fromEntries(
  STARTUP_STEPS.map((step) => [step.id, step.label.replace(/[…\s]+$/, "")]),
);

export function describeFailure(outcome: StepOutcome): string {
  const label = STEP_LABELS[outcome.id] ?? outcome.id;
  if (outcome.status === "timedOut") return `${label} timed out`;
  if (outcome.status === "skipped") {
    if (outcome.skipReason === "dependency-failed") return `${label} was skipped (a dependency didn't complete)`;
    if (outcome.skipReason === "aborted") return `${label} was skipped (cancelled)`;
    return `${label} was skipped (no time left)`;
  }
  return `${label} failed`;
}

/**
 * Shown when startup settled "degraded" -- something didn't complete (the
 * sidecar was unreachable, a directory listing timed out, ...) but the app
 * is otherwise usable, so this is a dismissible banner rather than
 * AlertModal's blocking dialog. Rendered inside AppBootstrapBoundary's
 * children (App.tsx), never a route unto itself -- it exists in the tree
 * only once bootstrap has actually let the app render.
 *
 * Considered and rejected: routing this through the existing notify() /
 * AlertModal path. The sidecar being briefly unreachable is the NORMAL
 * case in dev (see startupSteps.ts's sidecar-health step and BUILD.md),
 * so a blocking dialog on ordinary developer launches would be hostile.
 */
export const StartupDegradedBanner: React.FC = () => {
  const startupState = useWorkspaceStore((state) => state.startupState);
  const [dismissed, setDismissed] = useState(false);

  // A later run (Retry) settling degraded again -- even with the exact
  // same failures -- should reappear rather than staying hidden because
  // an earlier, unrelated instance was dismissed.
  useEffect(() => {
    if (startupState.status !== "degraded") setDismissed(false);
  }, [startupState]);

  if (startupState.status !== "degraded" || dismissed) return null;

  return (
    <div className={styles.banner} role="status">
      <span className={styles.message}>
        Rusty started, but some checks didn't complete: {startupState.failures.map(describeFailure).join("; ")}.
      </span>
      <button type="button" className={styles.dismiss} onClick={() => setDismissed(true)} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
};
