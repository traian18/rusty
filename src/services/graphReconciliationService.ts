// ============================================================
// graphReconciliationService.ts — Typed replacement for raw
// createAgentHarnessSocket() use of the "reconciliate_graph"
// capability (PR 4b), used only by ReconciliationGraphPane.tsx.
//
// Mirrors inlineChatService.ts's shape. Drops the
// `__reconciliation__:${tabId}` prefixed stream-id hack entirely --
// that existed only to work around createAgentHarnessSocket's
// one-subscription-per-routing-id model, which this service doesn't
// have (it subscribes directly on the real tabId). Two real bugs
// fixed here:
//
// 1. No cancellation existed at all -- the pane's only "stop" sent
//    agent_chat_stop (the wrong capability's stop message, a no-op
//    for this run). Added stopGraphReconciliation()/
//    cancelledGraphReconciliations (see agent-sidecar/src/
//    capabilities/reconciliateGraph.ts) mirroring globalExplore.ts's
//    fix, and a new reconciliate_graph_stop dispatch in server.ts.
// 2. Command-permission requests were never wired at all -- silently
//    dropped, same gap as edge reconciliation had.
// ============================================================

import { agentHarnessClient, RunEvent } from "./agentHarnessClient";
import { commandPermissionService, handleCommandPermissionMessage, CommandPermissionSocket } from "./commandPermissionService";
import { SIDECAR_PORT } from "../config/sidecar";

export interface GraphReconciliationRequest {
  tabId: string;
  model: string;
  nodes: unknown[];
  workspaceRoot: string;
  customProvider: unknown;
  duplicateFiles: unknown;
  fileSources: unknown;
  chatHistory: unknown[];
  userMessage: string;
}

export interface GraphReconciliationCallbacks {
  onLog: (message: string) => void;
  onUsage?: (usage: unknown) => void;
  onReadFile: (path: string) => Promise<string>;
  onWriteFile: (path: string, content: string) => Promise<void>;
  onFileComplete: (result: { filePath: string; taskIds: unknown; modified: boolean; response: string }) => void;
  onFileError: (result: { filePath: string; taskIds: unknown; error: string }) => void;
  onComplete: (result: { response: string; reviewedFiles: unknown; reconciledFiles: string[]; modifiedFiles: string[] }) => void;
  onError: (result: { message: string; filePath?: string }) => void;
}

export interface GraphReconciliationRun {
  cancel: () => void;
}

export const graphReconciliationService = {
  send(request: GraphReconciliationRequest, callbacks: GraphReconciliationCallbacks): GraphReconciliationRun {
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

    const fail = (message: string, filePath?: string) => {
      if (settled) return;
      finish();
      callbacks.onError({ message, filePath });
    };

    // Ledger updates must be committed in wire order -- mirrors the previous
    // socket.onmessage's own messageQueue: several async per-file events can
    // otherwise read and overwrite the same snapshot concurrently.
    let messageQueue = Promise.resolve();

    const handleEvent = (event: RunEvent) => {
      messageQueue = messageQueue.then(async () => {
        if (handleCommandPermissionMessage(event, permissionSocket)) return;

        if (event.type === "log") {
          callbacks.onLog(String(event.message ?? ""));
          return;
        }
        if (event.type === "usage_update") {
          callbacks.onUsage?.(event.usage);
          return;
        }
        if (event.type === "read_file") {
          try {
            const content = await callbacks.onReadFile(String(event.path ?? ""));
            await agentHarnessClient.respondToRpc(event, { content });
          } catch (error: unknown) {
            await agentHarnessClient.respondToRpc(event, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (event.type === "write_file") {
          try {
            await callbacks.onWriteFile(String(event.path ?? ""), String(event.content ?? ""));
            await agentHarnessClient.respondToRpc(event, {});
          } catch (error: unknown) {
            await agentHarnessClient.respondToRpc(event, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (event.type === "reconciliation_file_complete") {
          callbacks.onFileComplete({
            filePath: String(event.filePath ?? ""),
            taskIds: event.taskIds,
            modified: !!event.modified,
            response: String(event.response ?? ""),
          });
          return;
        }
        if (event.type === "reconciliation_file_error") {
          callbacks.onFileError({
            filePath: String(event.filePath ?? ""),
            taskIds: event.taskIds,
            error: String(event.error ?? "Unknown reconciliation error"),
          });
          return;
        }
        if (event.type === "reconciliation_graph_complete") {
          finish();
          callbacks.onComplete({
            response: String(event.response || "Reconciliation complete."),
            reviewedFiles: event.reviewedFiles,
            reconciledFiles: Array.isArray(event.reconciledFiles) ? event.reconciledFiles as string[] : [],
            modifiedFiles: Array.isArray(event.modifiedFiles) ? event.modifiedFiles as string[] : [],
          });
          return;
        }
        if (event.type === "reconciliation_graph_error") {
          fail(String(event.error || "Reconciliation failed."), event.filePath ? String(event.filePath) : undefined);
        }
      });
    };

    unsubscribe = agentHarnessClient.subscribe(request.tabId, handleEvent);

    void agentHarnessClient
      .startRun({
        type: "reconciliate_graph",
        runId: request.tabId,
        conversationId: request.tabId,
        tabId: request.tabId,
        model: request.model,
        nodes: request.nodes,
        workspaceRoot: request.workspaceRoot,
        customProvider: request.customProvider,
        duplicateFiles: request.duplicateFiles,
        fileSources: request.fileSources,
        chatHistory: request.chatHistory,
        userMessage: request.userMessage,
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
