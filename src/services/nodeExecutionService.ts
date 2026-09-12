// ============================================================
// nodeExecutionService.ts — Typed replacement for Workspace.tsx's
// raw createAgentHarnessSocket() use for the "execute_node"
// capability (PR 4b, capability 1 of 9).
//
// Mirrors inlineChatService.ts's shape: no raw socket, requests go
// through agentHarnessClient.startRun/subscribe, the VFS read_file/
// write_file reverse-RPC goes through agentHarnessClient.respondToRpc
// instead of hand-built JSON.stringify(socket.send(...)) calls, and
// command-permission requests are forwarded through
// commandPermissionService via a lightweight facade (not a real
// WebSocket -- see CommandPermissionSocket) since there is no longer a
// per-run socket object to hand it.
//
// VFS-specific bridging (which files are already in-flight for this
// execution, upstream-inherited content, on-disk fallback) stays
// exactly where it lived in Workspace.tsx -- it is workspace/canvas
// state, not transport plumbing -- so onReadFile/onWriteFile are
// supplied by the caller rather than reimplemented here.
// ============================================================

import { agentHarnessClient, RunEvent } from "./agentHarnessClient";
import { commandPermissionService, handleCommandPermissionMessage, CommandPermissionSocket } from "./commandPermissionService";
import { SIDECAR_PORT } from "../config/sidecar";

export interface NodeExecutionRequest {
  nodeId: string;
  instructions: string;
  model: string;
  workspaceRoot: string;
  inputFiles: unknown[];
  customProvider: unknown;
  globalContext: string;
  contextDescriptions: unknown;
  chatHistory: unknown[];
  skill: unknown;
  mcpContext: unknown[];
  upstreamTaskContext: unknown[];
  lspSettings: unknown;
}

export interface NodeExecutionCallbacks {
  onConnected?: () => void;
  onLog: (message: string) => void;
  onToken: (content: string) => void;
  onNodeStatusChange: (targetNodeId: string, status: string, message?: string, nodeName?: string) => void;
  onSubagentUpdate: (subagent: unknown) => void;
  onUsage?: (usage: unknown) => void;
  onCommandOutput?: (content: string) => void;
  onCommandComplete?: () => void;
  onReadFile: (path: string) => Promise<string>;
  onWriteFile: (path: string, content: string) => Promise<void>;
  onComplete: (result: { modified: string[]; response: string }) => void;
  onError: (message: string) => void;
}

export interface NodeExecutionRun {
  cancel: () => void;
}

export const nodeExecutionService = {
  execute(request: NodeExecutionRequest, callbacks: NodeExecutionCallbacks): NodeExecutionRun {
    let settled = false;
    let cancelRun: (() => Promise<void>) | undefined;
    let unsubscribe: (() => void) | undefined;

    // A structural stand-in for the WebSocket commandPermissionService used
    // to require: readyState mirrors the shared client's connection state,
    // send() forwards the raw command_permission_response back over it.
    const permissionSocket: CommandPermissionSocket = {
      get readyState() {
        return agentHarnessClient.getConnectionState() === "connected" ? WebSocket.OPEN : WebSocket.CLOSED;
      },
      send: (data: string) => {
        void agentHarnessClient.send(JSON.parse(data));
      },
    };

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      commandPermissionService.removeForSocket(permissionSocket);
      callbacks.onError(message);
    };

    const handleEvent = (event: RunEvent) => {
      if (handleCommandPermissionMessage(event, permissionSocket)) return;

      if (event.type === "command_output") {
        callbacks.onCommandOutput?.(String(event.content ?? ""));
        return;
      }
      if (event.type === "command_complete") {
        callbacks.onCommandComplete?.();
        return;
      }
      if (event.type === "node_status_change") {
        callbacks.onNodeStatusChange(
          String(event.targetNodeId ?? ""),
          String(event.status ?? ""),
          event.message !== undefined ? String(event.message) : undefined,
          event.nodeName !== undefined ? String(event.nodeName) : undefined,
        );
        return;
      }
      if (event.type === "log") {
        callbacks.onLog(String(event.message ?? ""));
        return;
      }
      if (event.type === "token") {
        callbacks.onToken(String(event.content ?? ""));
        return;
      }
      if (event.type === "subagent_update") {
        callbacks.onSubagentUpdate(event.subagent);
        return;
      }
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
      if (event.type === "execution_complete") {
        const result = (event.result as { modified?: string[]; response?: string }) || {};
        settled = true;
        unsubscribe?.();
        commandPermissionService.removeForSocket(permissionSocket);
        callbacks.onComplete({ modified: result.modified || [], response: result.response || "Task completed successfully." });
        return;
      }
      if (event.type === "execution_error") {
        fail(String(event.error || "Execution failed."));
      }
    };

    unsubscribe = agentHarnessClient.subscribe(request.nodeId, handleEvent);

    void agentHarnessClient
      .startRun({
        type: "execute_node",
        runId: request.nodeId,
        conversationId: request.nodeId,
        nodeId: request.nodeId,
        instructions: request.instructions,
        model: request.model,
        workspaceRoot: request.workspaceRoot,
        inputFiles: request.inputFiles,
        globalContext: request.globalContext,
        contextDescriptions: request.contextDescriptions,
        mcpContext: request.mcpContext,
        upstreamTaskContext: request.upstreamTaskContext,
        chatHistory: request.chatHistory,
        customProvider: request.customProvider,
        skill: request.skill,
        lspSettings: request.lspSettings,
      })
      .then((handle) => {
        cancelRun = handle.cancel;
        callbacks.onConnected?.();
        if (settled) void handle.cancel();
      })
      .catch((error: unknown) => {
        fail(
          error instanceof Error
            ? error.message
            : `Could not connect to the agent sidecar on port ${SIDECAR_PORT}.`,
        );
      });

    return {
      cancel: () => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        commandPermissionService.removeForSocket(permissionSocket);
        if (cancelRun) void cancelRun();
      },
    };
  },
};
