import { Component, ErrorInfo, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  children?: ReactNode;
  /** Custom fallback UI (REFACTOR_PLAN.md PR 7 commit 5) -- when absent,
      behavior is exactly what it always was: the full-viewport crash
      screen below, still the only one used at the app root (main.tsx).
      A tab-scoped boundary (TabOutlet.tsx) passes a compact, panel-shaped
      fallback instead, since a per-tab boundary must not claim the whole
      viewport the way a top-level crash screen can. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({ errorInfo });
    invoke("log_to_terminal", {
      level: "error",
      message: `React Error Boundary caught crash: ${error?.stack || error}\nComponent Stack:\n${errorInfo?.componentStack}`
    }).catch((err) => console.error("Failed to log crash to terminal:", err));
  }

  private reset = () => this.setState({ hasError: false, error: null, errorInfo: null });

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback && this.state.error) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-[var(--color-surface-app)] text-[var(--color-fg-strong)] font-sans p-6 overflow-auto">
          <div className="max-w-2xl w-full bg-[var(--color-surface-sunken)] border border-[var(--color-status-danger-border)] rounded-xl p-6 shadow-2xl space-y-4">
            <h1 className="text-[var(--color-status-danger)] font-bold text-lg flex items-center space-x-2">
              <span>⚠️ Application Crashed</span>
            </h1>
            <p className="text-xs text-[var(--color-fg-default)]">
              An unhandled error occurred in the React component tree.
            </p>
            <div className="bg-[var(--color-surface-sunken)] p-4 rounded-lg border border-[var(--color-border-subtle)] font-mono text-xs text-[var(--color-status-danger)] overflow-x-auto whitespace-pre-wrap">
              {this.state.error && this.state.error.toString()}
            </div>
            {this.state.errorInfo && (
              <div className="bg-[var(--color-surface-sunken)] p-4 rounded-lg border border-[var(--color-border-subtle)] font-mono text-[10px] text-[var(--color-fg-muted)] overflow-x-auto whitespace-pre-wrap max-h-60">
                {this.state.errorInfo.componentStack}
              </div>
            )}
            <div className="flex space-x-2 pt-2">
              <button
                onClick={() => window.location.reload()}
                className="bg-[var(--color-status-info-solid)] hover:bg-[var(--color-status-info-solid)] text-[var(--color-status-info-solid-foreground)] font-mono font-bold text-xs px-4 py-2 rounded-lg transition-colors cursor-pointer"
              >
                Reload Application
              </button>
              <button
                onClick={this.reset}
                className="bg-[var(--color-surface-sunken)] hover:bg-[var(--color-surface-sunken)] text-[var(--color-fg-strong)] font-mono font-bold text-xs px-4 py-2 rounded-lg transition-colors cursor-pointer"
              >
                Reset State
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
