// ============================================================
// agentChatService.ts — Typed replacement for raw createAgentHarnessSocket()
// use of the "agent_chat" capability (PR 4b).
//
// Two consumers share this: useExplorerWebSocket.ts's "Explorer Chat" send
// (global/task-node chat is agent_chat under the hood, planOnly/vfsOnly
// flags picking the behavior) and AgentTab.tsx's main agent tab. Mirrors
// inlineChatService.ts's shape: no raw socket, requests go through
// agentHarnessClient.startRun/subscribe, RPC (read_file/write_file/
// write_plan/agent_question) goes through respondToRpc, command-permission
// requests forward through commandPermissionService via a lightweight
// facade instead of a real WebSocket.
//
// agent_chat already has real server-side cancellation (stopPiAgentRun +
// stopAgentChatDelegations, wired well before PR 4) -- this migration is
// transport-only for this capability, no new cancellation to add.
// ============================================================

import { agentHarnessClient, RunEvent } from "./agentHarnessClient";
import { commandPermissionService, handleCommandPermissionMessage, CommandPermissionSocket } from "./commandPermissionService";
import { SIDECAR_PORT } from "../config/sidecar";
import { isReadFileRpcRequest, isWriteFileRpcRequest, ReadFileRpcResponse, WriteFileRpcResponse } from "../../shared/agent-protocol";

export interface AgentChatRequest {
  tabId: string;
  message: string;
  workspaceRoot: string;
  model: string;
  chatHistory: unknown[];
  mcpServers: unknown[];
  customProvider: unknown;
  skill: unknown;
  planOnly: boolean;
  vfsOnly: boolean;
  lspSettings: unknown;
}

export interface AgentChatCallbacks {
  onConnected?: () => void;
  onLog: (message: string) => void;
  onToken?: (content: string) => void;
  onSubagentUpdate: (subagent: unknown) => void;
  onAgentQuestion: (question: { requestId: string; question: string; options: Array<{ label: string; description?: string }> }) => void;
  onCommandOutput?: (content: string) => void;
  onCommandComplete?: () => void;
  onReadFile: (path: string) => Promise<string>;
  onWriteFile: (path: string, content: string) => Promise<void>;
  onWritePlan?: (filename: string, content: string) => Promise<string>;
  onComplete: (result: { response: string; modifiedFiles: string[]; subagents: unknown[] }) => void;
  onError: (message: string) => void;
}

export interface AgentChatRun {
  cancel: () => void;
  answerQuestion: (requestId: string, answer: string) => void;
}

export const agentChatService = {
  send(request: AgentChatRequest, callbacks: AgentChatCallbacks): AgentChatRun {
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

      if (event.type === "command_output") {
        callbacks.onCommandOutput?.(String(event.content ?? ""));
        return;
      }
      if (event.type === "command_complete") {
        callbacks.onCommandComplete?.();
        return;
      }
      if (event.type === "log") {
        callbacks.onLog(String(event.message ?? ""));
        return;
      }
      if (event.type === "token") {
        callbacks.onToken?.(String(event.content ?? ""));
        return;
      }
      if (event.type === "subagent_update") {
        callbacks.onSubagentUpdate(event.subagent);
        return;
      }
      if (event.type === "agent_question" && event.requestId) {
        callbacks.onAgentQuestion({
          requestId: String(event.requestId),
          question: String(event.question || "The agent needs your input."),
          options: Array.isArray(event.options)
            ? event.options.filter((option): option is { label: string; description?: string } =>
                !!option && typeof option === "object" && typeof (option as { label?: unknown }).label === "string",
              )
            : [],
        });
        return;
      }
      if (isReadFileRpcRequest(event)) {
        void callbacks.onReadFile(String(event.path ?? ""))
          .then((content) => agentHarnessClient.respondToRpc(event, { content } satisfies ReadFileRpcResponse))
          .catch((error: unknown) =>
            agentHarnessClient.respondToRpc(event, { error: error instanceof Error ? error.message : String(error) } satisfies ReadFileRpcResponse),
          );
        return;
      }
      if (isWriteFileRpcRequest(event)) {
        void callbacks.onWriteFile(String(event.path ?? ""), String(event.content ?? ""))
          .then(() => agentHarnessClient.respondToRpc(event, {} satisfies WriteFileRpcResponse))
          .catch((error: unknown) =>
            agentHarnessClient.respondToRpc(event, { error: error instanceof Error ? error.message : String(error) } satisfies WriteFileRpcResponse),
          );
        return;
      }
      if (event.type === "write_plan") {
        if (!callbacks.onWritePlan) {
          void agentHarnessClient.respondToRpc(event, { error: "write_plan is not supported on this surface." });
          return;
        }
        void callbacks.onWritePlan(String(event.filename ?? ""), String(event.content ?? ""))
          .then((path) => agentHarnessClient.respondToRpc(event, { path }))
          .catch((error: unknown) =>
            agentHarnessClient.respondToRpc(event, { error: error instanceof Error ? error.message : String(error) }),
          );
        return;
      }
      if (event.type === "agent_chat_complete") {
        finish();
        callbacks.onComplete({
          response: String(event.response || "Agent chat complete."),
          modifiedFiles: Array.isArray(event.modifiedFiles) ? event.modifiedFiles as string[] : [],
          subagents: Array.isArray(event.subagents) ? event.subagents : [],
        });
        return;
      }
      if (event.type === "agent_chat_error") {
        fail(String(event.error || "Agent chat failed."));
      }
    };

    unsubscribe = agentHarnessClient.subscribe(request.tabId, handleEvent);

    void agentHarnessClient
      .startRun({
        type: "agent_chat",
        runId: request.tabId,
        conversationId: request.tabId,
        tabId: request.tabId,
        message: request.message,
        workspaceRoot: request.workspaceRoot,
        model: request.model,
        chatHistory: request.chatHistory,
        mcpServers: request.mcpServers,
        customProvider: request.customProvider,
        skill: request.skill,
        planOnly: request.planOnly,
        vfsOnly: request.vfsOnly,
        lspSettings: request.lspSettings,
      })
      .then((handle) => {
        cancelRun = handle.cancel;
        callbacks.onConnected?.();
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
      answerQuestion: (requestId, answer) => {
        void agentHarnessClient.respondToQuestion({ runId: request.tabId, requestId, answer });
      },
    };
  },
};
