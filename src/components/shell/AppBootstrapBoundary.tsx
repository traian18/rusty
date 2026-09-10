import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../../store";
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
 * state, loading secure configuration, and (if a workspace was restored)
 * loading its skills.
 *
 * This is a shell around what PR 3's startup coordinator replaces. The
 * `ShellBootstrapStatus` here is intentionally the minimal three states;
 * PR 3 swaps this component's internals for a full `StartupPhase` machine
 * (sidecar health, bounded-concurrency model discovery, `degraded` mode)
 * WITHOUT changing `AppBootstrapBoundaryView`'s prop contract, so the rest of
 * the tree does not need to change again. `degraded` will map onto `ready`
 * plus a banner; the finer-grained phases map onto `pending` plus `message`.
 *
 * Explicitly NOT this PR's job: fixing the slice import-time I/O violations
 * in createIntegrationSlice/createMetricsSlice, moving main.tsx's pre-React
 * theme/typography apply, sidecar health checks, or LlmSetupTab's polling.
 * All recorded in ARCHITECTURE.md as PR 3's.
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

    setStatus("pending");
    setError(null);
    setShowPendingUi(false);

    const pendingTimer = setTimeout(() => {
      if (!cancelled && runId === runIdRef.current) setShowPendingUi(true);
    }, PENDING_UI_DELAY_MS);

    const store = useWorkspaceStore.getState();
    store.hydrateUi();
    store.initTerminalState(import.meta.env.DEV);

    store.loadSecureConfig()
      .then(async () => {
        if (cancelled || runId !== runIdRef.current) return;
        const { rootPath, loadSkills } = useWorkspaceStore.getState();
        if (rootPath) {
          await loadSkills().catch((skillsError) => {
            // Non-fatal, matching today's behavior: a workspace with no
            // loadable skills still becomes usable.
            console.error("Failed to load skills on startup:", skillsError);
          });
        }
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
