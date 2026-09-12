// ============================================================
// globalExploreService.ts — Typed replacement for raw
// createAgentHarnessSocket() use of the "global_explore" capability
// (PR 4b), used only by useExplorerWebSocket.ts's "Summarize" flow.
//
// Mirrors inlineChatService.ts's shape. Also carries this capability's
// bug fix: global_explore had no registered stop message at all before
// this (its shouldAbort only polled the per-run socket's readyState,
// which no longer closes per-run now that every capability shares one
// agentHarnessClient connection) -- see agent-sidecar/src/capabilities/
// globalExplore.ts's new stopGlobalExploration() and this service's
// cancel(), which now sends a real global_explore_stop.
// ============================================================

import { agentHarnessClient, RunEvent } from "./agentHarnessClient";
import { SIDECAR_PORT } from "../config/sidecar";

export interface GlobalExploreRequest {
  nodeId: string;
  prompt: string;
  workspaceRoot: string;
  model: string;
  chatHistory: unknown[];
  customProvider: unknown;
  skill: unknown;
}

export interface GlobalExploreCallbacks {
  onLog: (message: string) => void;
  onReadFile: (path: string) => Promise<string>;
  onComplete: (response: string) => void;
  onError: (message: string) => void;
}

export interface GlobalExploreRun {
  cancel: () => void;
}

export const globalExploreService = {
  explore(request: GlobalExploreRequest, callbacks: GlobalExploreCallbacks): GlobalExploreRun {
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
      if (event.type === "log") {
        callbacks.onLog(String(event.message ?? ""));
        return;
      }
      if (event.type === "read_file") {
        void callbacks.onReadFile(String(event.path ?? ""))
          .then((content) => agentHarnessClient.respondToRpc(event, { content }))
          .catch((error: unknown) =>
            agentHarnessClient.respondToRpc(event, { error: error instanceof Error ? error.message : String(error) }),
          );
        return;
      }
      if (event.type === "global_explore_complete") {
        finish();
        callbacks.onComplete(String(event.response || "Summary not available."));
        return;
      }
      if (event.type === "global_explore_error") {
        fail(String(event.error || "Summarization failed."));
      }
    };

    unsubscribe = agentHarnessClient.subscribe(request.nodeId, handleEvent);

    void agentHarnessClient
      .startRun({
        type: "global_explore",
        runId: request.nodeId,
        conversationId: request.nodeId,
        nodeId: request.nodeId,
        prompt: request.prompt,
        workspaceRoot: request.workspaceRoot,
        model: request.model,
        chatHistory: request.chatHistory,
        customProvider: request.customProvider,
        skill: request.skill,
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
