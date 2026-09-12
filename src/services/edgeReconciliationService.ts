// ============================================================
// edgeReconciliationService.ts — Typed replacement for raw
// createAgentHarnessSocket() use of the "reconciliate_edge"
// capability (PR 4b), used only by useEdgeWebSocket.ts.
//
// Mirrors inlineChatService.ts's shape. Two real bugs fixed here:
//
// 1. No cancellation existed at all -- no stop button, no stop
//    message. Added reconciliate_edge_stop (server.ts) +
//    stopEdgeReconciliation()/cancelledReconciliations (see
//    agent-sidecar/src/capabilities/reconciliateEdge.ts) mirroring
//    globalExplore.ts's fix, for the same reason: its tool loop's
//    shouldAbort only polled a per-run socket's readyState, which no
//    longer trips now that every capability shares one connection.
// 2. Command-permission requests were never wired at all -- this
//    consumer never called handleCommandPermissionMessage, so a
//    command_permission_request arriving on this capability's runId
//    was silently dropped (the request would hang forever on the
//    sidecar side, waiting for a response that would never come).
//    Now forwarded through commandPermissionService via the same
//    lightweight facade nodeExecutionService/agentChatService use.
// ============================================================

import { agentHarnessClient, RunEvent } from "./agentHarnessClient";
import { commandPermissionService, handleCommandPermissionMessage, CommandPermissionSocket } from "./commandPermissionService";
import { SIDECAR_PORT } from "../config/sidecar";

export interface EdgeReconciliationRequest {
  edgeId: string;
  sourceTaskId: string | undefined;
  targetTaskId: string | undefined;
  modifiedFiles: string[];
  userMessage: string;
  chatHistory: unknown[];
  workspaceRoot: string;
  model: string;
  sourcePrompt: string;
  targetPrompt: string;
  customProvider: unknown;
}

export interface EdgeReconciliationCallbacks {
  onUsage?: (usage: unknown) => void;
  onReadFile: (path: string) => Promise<string>;
  onWriteFile: (path: string, content: string) => Promise<void>;
  onComplete: (response: string) => void;
  onError: (message: string) => void;
}

export interface EdgeReconciliationRun {
  cancel: () => void;
}

export const edgeReconciliationService = {
  send(request: EdgeReconciliationRequest, callbacks: EdgeReconciliationCallbacks): EdgeReconciliationRun {
    let settled = false;
    let cancelRun: (() => Promise<void>) | undefined;
    let unsubscribe: (() => void) | undefined;

    const permissionSocket: CommandPermissionSocket = {
      get readyState() {
        return agentHarnessClient.getConnectionState() === "connected" ? WebSocket.OPEN : WebSocket.CLOSED;
      },
      send: (data: string) => {
        void agentHarnessClient.send(JSON.parse(data));
      },
    };

    const finish = () => {
      settled = true;
      unsubscribe?.();
      commandPermissionService.removeForSocket(permissionSocket);
    };

    const fail = (message: string) => {
      if (settled) return;
      finish();
      callbacks.onError(message);
    };

    const handleEvent = (event: RunEvent) => {
      if (handleCommandPermissionMessage(event, permissionSocket)) return;

      if (event.type === "usage_update") {
        callbacks.onUsage?.(event.usage);
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
      if (event.type === "write_file") {
        void callbacks.onWriteFile(String(event.path ?? ""), String(event.content ?? ""))
          .then(() => agentHarnessClient.respondToRpc(event, {}))
          .catch((error: unknown) =>
            agentHarnessClient.respondToRpc(event, { error: error instanceof Error ? error.message : String(error) }),
          );
        return;
      }
      if (event.type === "reconciliation_complete") {
        finish();
        callbacks.onComplete(String(event.response || "Analysis complete."));
        return;
      }
      if (event.type === "reconciliation_error") {
        fail(String(event.error || "Reconciliation failed."));
      }
    };

    unsubscribe = agentHarnessClient.subscribe(request.edgeId, handleEvent);

    void agentHarnessClient
      .startRun({
        type: "reconciliate_edge",
        runId: request.edgeId,
        conversationId: request.edgeId,
        edgeId: request.edgeId,
        sourceTaskId: request.sourceTaskId,
        targetTaskId: request.targetTaskId,
        modifiedFiles: request.modifiedFiles,
        userMessage: request.userMessage,
        chatHistory: request.chatHistory,
        workspaceRoot: request.workspaceRoot,
        model: request.model,
        sourcePrompt: request.sourcePrompt,
        targetPrompt: request.targetPrompt,
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
