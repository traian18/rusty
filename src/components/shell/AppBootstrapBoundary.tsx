import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../../store";
import { restoreWorkspace } from "./startupSteps";
import { AppBootstrapBoundaryView } from "./AppBootstrapBoundary.view";

export type ShellBootstrapStatus = "pending" | "ready" | "failed";

/**
 * There is no loading screen today, and `loadSecureConfig` (a Tauri invoke)
 * resolves in single-digit milliseconds on a warm start. The single biggest
 * regression risk of introducing this boundary is a splash-screen flash on
 * every launch, so the pending UI only appears if bootstrap is STILL running
 * after this delay.
 */
const PENDING_UI_DELAY_MS = 150;

/**
 * Owns application bootstrap: hydrating UI preferences, seeding terminal
 * state, subscribing to live usage updates, loading secure configuration,
 * and (if a workspace was saved) restoring it -- fileTree, git status,
 * skills, and metrics together (restoreWorkspace -> loadWorkspaceData).
 *
 * This is a shell around what PR 3a's startup coordinator replaces. The
 * `ShellBootstrapStatus` here is intentionally the minimal three states;
 * PR 3a swaps this component's internals for a full `StartupState` machine
 * (sidecar health, per-step deadlines, `degraded` mode, Retry re-running
 * only what didn't settle) WITHOUT changing `AppBootstrapBoundaryView`'s
 * prop contract, so the rest of the tree does not need to change again.
 * `degraded` will map onto `ready` plus a banner; the finer-grained phases
 * map onto `pending` plus `message`.
 *
 * The slice import-time I/O violations this component used to route around
 * (createIntegrationSlice's theme/MCP reads, createPreferencesSlice's
 * typography/shortcuts reads, createMetricsSlice's agentHarnessClient
 * touch) are fixed as of PR 3a commits 3-5 -- hydrateUi/initTerminalState/
 * initMetricsSubscription above are exactly that pattern, called explicitly
 * here rather than at slice creation. Still explicitly NOT this component's
 * job yet: sidecar health checks, per-step timeouts, and LlmSetupTab's
 * polling (3b). All recorded in ARCHITECTURE.md.
 */
export const AppBootstrapBoundary: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<ShellBootstrapStatus>("pending");
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [showPendingUi, setShowPendingUi] = useState(false);
  // StrictMode double-invokes this effect in dev; guarding with a run id plus
  // a `cancelled` flag on cleanup is the same pattern SourceControl.tsx's
  // branchLoadIdRef already uses for the same reason.
  const runIdRef = useRef(0);

  useEffect(() => {
    const runId = ++runIdRef.current;
    let cancelled = false;
    const abortController = new AbortController();

    setStatus("pending");
    setError(null);
    setShowPendingUi(false);

    const pendingTimer = setTimeout(() => {
      if (!cancelled && runId === runIdRef.current) setShowPendingUi(true);
    }, PENDING_UI_DELAY_MS);

    const store = useWorkspaceStore.getState();
    store.hydrateUi();
    store.initTerminalState(import.meta.env.DEV);
    store.initMetricsSubscription();

    store.loadSecureConfig()
      .then(async () => {
        if (cancelled || runId !== runIdRef.current) return;
        // Interim call, not yet routed through the full startup executor
        // (the next commit) -- restoreWorkspace is the exact function the
        // eventual "workspace-restore" step wraps (components/shell/
        // startupSteps.ts), called directly here so a restored workspace's
        // skills/git/metrics keep loading between this commit and that one
        // landing, same as initMetricsSubscription's interim wiring in
        // commit 5.
        await restoreWorkspace({ signal: abortController.signal });
        if (!cancelled && runId === runIdRef.current) setStatus("ready");
      })
      .catch((bootstrapError) => {
        console.error("Failed to load secure configuration on startup:", bootstrapError);
        if (!cancelled && runId === runIdRef.current) {
          setError(bootstrapError);
          setStatus("failed");
        }
      })
      .finally(() => {
        clearTimeout(pendingTimer);
      });

    return () => {
      cancelled = true;
      abortController.abort();
      clearTimeout(pendingTimer);
    };
  }, [attempt]);

  return (
    <AppBootstrapBoundaryView
      status={status}
      showPendingUi={showPendingUi}
      error={error}
      onRetry={() => setAttempt((a) => a + 1)}
      onContinue={() => setStatus("ready")}
    >
      {children}
    </AppBootstrapBoundaryView>
  );
};
