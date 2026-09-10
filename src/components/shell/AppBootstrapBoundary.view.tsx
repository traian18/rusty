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
  /** PR 3 fills this with the current StartupPhase's label. */
  message?: string;
  error?: unknown;
  onRetry: () => void;
  onContinue: () => void;
  children: React.ReactNode;
}

export const AppBootstrapBoundaryView: React.FC<AppBootstrapBoundaryViewProps> = ({
  status,
  showPendingUi,
  message,
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
        <p className={styles.message}>{message || "Starting Rusty…"}</p>
      </div>
    </div>
  );
};
