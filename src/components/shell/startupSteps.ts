import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../store";
import { SIDECAR_HTTP_URL } from "../../config/sidecar";
import type { StartupStep, StepContext } from "../../startup/types";

/**
 * The application's actual startup steps -- deliberately NOT under
 * src/startup/ (unlike the generic executor: types.ts, runStartup.ts,
 * withTimeout.ts), because these need the real store and Tauri's `invoke`,
 * and src/startup/layering.test.ts forbids exactly that import for the
 * generic machinery. Lives next to AppBootstrapBoundary.tsx, its only
 * consumer, the same way consoleFormat.ts lives next to DevLogBridge.tsx.
 */

const SECURE_CONFIG_TIMEOUT_MS = 3_000;
const SIDECAR_HEALTH_POLL_BUDGET_MS = 1_500;
const SIDECAR_HEALTH_POLL_INTERVAL_MS = 150;
const SIDECAR_HEALTH_PER_ATTEMPT_TIMEOUT_MS = 500;
const WORKSPACE_RESTORE_TIMEOUT_MS = 5_000;

/**
 * Polls GET /health rather than firing one request: the bundled sidecar is
 * spawned by Rust in parallel with the webview loading (src-tauri/src/
 * lib.rs), so a single request at t=0 would almost always see connection-
 * refused during a cold start and report "down" even though the sidecar is
 * about to come up fine a moment later. Connection-refused on localhost
 * fails instantly, so the common dev case (no sidecar reachable at all --
 * see commit 8's port fix) still costs next to nothing, not a full
 * timeout's worth of waiting.
 */
export async function pollSidecarHealth(signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + SIDECAR_HEALTH_POLL_BUDGET_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (signal.aborted) return;
    try {
      const response = await fetch(`${SIDECAR_HTTP_URL}/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(SIDECAR_HEALTH_PER_ATTEMPT_TIMEOUT_MS)]),
      });
      if (response.ok) return;
      lastError = new Error(`Sidecar health check returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (signal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, SIDECAR_HEALTH_POLL_INTERVAL_MS));
  }
  throw lastError ?? new Error("Sidecar health check did not respond in time");
}

/**
 * Restores the workspace loadSecureConfig found saved
 * (pendingWorkspaceRestorePath), if any. A separate function/step from
 * loadSecureConfig itself so it can carry its own, longer timeout budget
 * without a slow directory listing counting against secure-config's
 * critical one (createIntegrationSlice.ts).
 *
 * Non-destructive, unlike setRootPath: never resets tabs/canvases/nodes,
 * so re-running it (a Retry after a timeout) can't destroy work done since
 * "Continue without waiting".
 *
 * Also the sole owner of flipping secureConfigLoaded for the "a saved path
 * exists" case -- set in `finally`, UNCONDITIONALLY (not gated on
 * ctx.signal.aborted), so a step that times out still eventually unblocks
 * saveSecureConfig once its non-cancellable invoke() actually settles in
 * the background, rather than leaving it permanently guarded for the rest
 * of the session. Only the rootPath/fileTree write itself is gated on the
 * signal, so a late result after a timeout/abort is discarded rather than
 * landing out of order.
 */
export async function restoreWorkspace(ctx: StepContext): Promise<void> {
  const path = useWorkspaceStore.getState().pendingWorkspaceRestorePath;
  if (!path) {
    useWorkspaceStore.setState({ secureConfigLoaded: true });
    return;
  }
  try {
    const fileTree: any[] = await invoke("get_directory_structure", { rootDir: path });
    if (ctx.signal.aborted) return;
    useWorkspaceStore.setState({ rootPath: path, fileTree, pendingWorkspaceRestorePath: null });
    await useWorkspaceStore.getState().loadWorkspaceData();
  } catch (error) {
    console.error("Failed to load last workspace folder:", error);
  } finally {
    useWorkspaceStore.setState({ secureConfigLoaded: true });
  }
}

export const STARTUP_STEPS: StartupStep[] = [
  {
    id: "secure-config",
    label: "Loading configuration…",
    critical: true,
    timeoutMs: SECURE_CONFIG_TIMEOUT_MS,
    run: async () => {
      await useWorkspaceStore.getState().loadSecureConfig();
    },
  },
  {
    id: "sidecar-health",
    label: "Checking the agent sidecar…",
    // Slack over pollSidecarHealth's own internal deadline, so that
    // internal loop -- not this outer executor-level timeout -- is what
    // actually bounds it in the common case.
    timeoutMs: SIDECAR_HEALTH_POLL_BUDGET_MS + 500,
    run: (ctx) => pollSidecarHealth(ctx.signal),
  },
  {
    id: "workspace-restore",
    label: "Restoring your workspace…",
    timeoutMs: WORKSPACE_RESTORE_TIMEOUT_MS,
    dependsOn: ["secure-config"],
    run: restoreWorkspace,
  },
];
