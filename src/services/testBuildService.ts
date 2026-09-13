// ============================================================
// testBuildService.ts — Typed replacement for raw
// createAgentHarnessSocket() use of the "test_build" capability
// (PR 4b), used only by ReconciliationGraphPane.tsx.
//
// Mirrors inlineChatService.ts's shape. Drops the
// `__test_build__:${tabId}` prefixed stream-id hack entirely -- see
// graphReconciliationService.ts's header for why.
//
// Real fix: test_build had a UI stop button already
// (handleStopTestBuild), but it only ever closed the client's own
// socket -- no stop message existed server-side, so the build
// subprocess and any in-flight model fix-attempt kept running. Now
// sends a real test_build_stop, which (see agent-sidecar/src/
// capabilities/testBuild.ts's stopTestBuild) kills the actual build/
// diagnostic subprocess via the existing stopCommandsForSession and
// flags the model fix-attempt loop to stop.
// ============================================================

import { agentHarnessClient, RunEvent } from "./agentHarnessClient";
import { SIDECAR_PORT } from "../config/sidecar";

export interface TestBuildRequest {
  tabId: string;
  buildCommand: string;
  workspaceRoot: string;
  reconciledFiles: string[];
  model: string;
  customProvider: unknown;
}

export interface TestBuildCallbacks {
  onLog: (message: string) => void;
  onIteration: (attempt: number, maxAttempts: number) => void;
  onComplete: (result: { success: boolean; attempts: number; finalFiles: Record<string, string> }) => void;
  onError: (message: string) => void;
}

export interface TestBuildRun {
  cancel: () => void;
}

export const testBuildService = {
  run(request: TestBuildRequest, callbacks: TestBuildCallbacks): TestBuildRun {
    let settled = false;
    let cancelRun: (() => Promise<void>) | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = () => {
      settled = true;
      unsubscribe?.();
    };

    const fail = (message: string) => {
      if (settled) return;
      finish();
      callbacks.onError(message);
    };

    const handleEvent = (event: RunEvent) => {
      if (event.type === "test_build_log") {
        callbacks.onLog(String(event.message ?? ""));
        return;
      }
      if (event.type === "test_build_iteration") {
        callbacks.onIteration(Number(event.attempt ?? 0), Number(event.maxAttempts ?? 0));
        return;
      }
      if (event.type === "test_build_complete") {
        finish();
        callbacks.onComplete({
          success: !!event.success,
          attempts: Number(event.attempts ?? 0),
          finalFiles: (event.finalFiles as Record<string, string>) || {},
        });
        return;
      }
      if (event.type === "test_build_error") {
        fail(String(event.error || "Test build failed."));
      }
    };

    unsubscribe = agentHarnessClient.subscribe(request.tabId, handleEvent);

    void agentHarnessClient
      .startRun({
        type: "test_build",
        runId: request.tabId,
        conversationId: request.tabId,
        tabId: request.tabId,
        buildCommand: request.buildCommand,
        workspaceRoot: request.workspaceRoot,
        reconciledFiles: request.reconciledFiles,
        model: request.model,
        customProvider: request.customProvider,
      })
      .then((handle) => {
        cancelRun = handle.cancel;
        if (settled) void handle.cancel();
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error.message : `Could not connect to the agent sidecar on port ${SIDECAR_PORT}.`);
      });

    return {
      cancel: () => {
        if (settled) return;
        finish();
        if (cancelRun) void cancelRun();
      },
    };
  },
};
