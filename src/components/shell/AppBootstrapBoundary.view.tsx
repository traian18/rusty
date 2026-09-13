import React from "react";
import { Button } from "../ui";
import { RustyIcon } from "../RustyIcon";
import type { ShellBootstrapStatus } from "./AppBootstrapBoundary";
import styles from "./AppBootstrapBoundary.module.css";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

interface AppBootstrapBoundaryViewProps {
  status: ShellBootstrapStatus;
  /** Delay-gated: only true once bootstrap has been pending long enough to
      justify showing anything, so a fast/warm boot never flashes a screen. */
  showPendingUi: boolean;
  /** The current step's label (REFACTOR_PLAN.md PR 3a) -- was accepted but
      never populated before this commit. */
  message?: string;
  /** How many of the total steps have settled, for the "(done/total)"
      progress readout -- present only alongside `message`. */
  done?: number;
  total?: number;
  /** True once the pending screen has been visible long enough (2.5s) to
      offer an escape hatch from a slow or stuck run. Only meaningful
      while `status === "pending"`. */
  showContinueWithoutWaiting: boolean;
  error?: unknown;
  onRetry: () => void;
  onContinue: () => void;
  children: React.ReactNode;
}

export const AppBootstrapBoundaryView: React.FC<AppBootstrapBoundaryViewProps> = ({
  status,
  showPendingUi,
  message,
  done,
  total,
  showContinueWithoutWaiting,
  error,
  onRetry,
  onContinue,
  children,
}) => {
  if (status === "ready") return <>{children}</>;

  if (status === "failed") {
    return (
      <div className={styles.screen}>
        <div className={styles.card}>
          <RustyIcon size={40} />
          <h1 className={styles.failedHeading}>Rusty could not start</h1>
          <p className={styles.message}>
            {message || "Something went wrong while loading your configuration."}
          </p>
          {error !== undefined && error !== null && (
            <pre className={styles.errorDetail}>{describeError(error)}</pre>
          )}
          <div className={styles.actions}>
            <Button variant="primary" onClick={onRetry}>Retry</Button>
            <Button variant="secondary" onClick={onContinue}>Continue anyway</Button>
            {/* Required: GlobalShortcuts swallows Cmd/Ctrl+R everywhere,
                including on this screen, so there must be an explicit way
                to reload. */}
            <Button variant="ghost" onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </div>
      </div>
    );
  }

  // status === "pending"
  if (!showPendingUi) return null;

  return (
    <div className={styles.screen} role="status" aria-live="polite">
      <div className={styles.card}>
        <RustyIcon size={40} />
        <p className={styles.message}>
          {message || "Starting Rusty…"}
          {done !== undefined && total !== undefined && (
            <span className={styles.progress}> ({done}/{total})</span>
          )}
        </p>
        {showContinueWithoutWaiting && (
          <Button variant="ghost" onClick={onContinue}>Continue without waiting</Button>
        )}
      </div>
    </div>
  );
};
