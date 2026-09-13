// ============================================================
// taskGenerationService.ts — Typed replacement for raw
// createAgentHarnessSocket() use of the "generate_task_nodes"
// capability (PR 4b), used only by useExplorerWebSocket.ts's
// "Generate Tasks" flow.
//
// generate_task_nodes already has real cancellation (an AbortController
// per requestId, agent-sidecar/src/capabilities/generateTaskNodes.ts) --
// this migration is transport-only, plus one bug fix folded in: the
// stopped/settled dual-shape under one event name (see
// generateTaskNodes.ts's updated comment) is now resolved server-side,
// so this service only needs to expect one shape per event type.
// ============================================================

import { agentHarnessClient, RunEvent } from "./agentHarnessClient";
import { SIDECAR_PORT } from "../config/sidecar";

export interface TaskGenerationRequest {
  nodeId: string;
  requestId: string;
  model: string;
  chatHistory: unknown[];
  additionalInstructions: string;
  workspaceRoot: string;
  customProvider: unknown;
}

export interface TaskGenerationCallbacks {
  onLog: (message: string) => void;
  onComplete: (result: { tasks: unknown[]; contexts: unknown[] }) => void;
  onStopped: () => void;
  onError: (failure: { code?: string; message: string; attempts?: number }) => void;
}

export interface TaskGenerationRun {
  cancel: () => void;
}

export const taskGenerationService = {
  generate(request: TaskGenerationRequest, callbacks: TaskGenerationCallbacks): TaskGenerationRun {
    let settled = false;
    let cancelRun: (() => Promise<void>) | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = () => {
      settled = true;
      unsubscribe?.();
    };

    const handleEvent = (event: RunEvent) => {
      if (event.requestId !== request.requestId) return;

      if (event.type === "generate_task_nodes_log") {
        callbacks.onLog(String(event.message ?? ""));
        return;
      }
      if (event.type === "generate_task_nodes_complete") {
        finish();
        callbacks.onComplete({
          tasks: Array.isArray(event.tasks) ? event.tasks : [],
          contexts: Array.isArray(event.contexts) ? event.contexts : [],
        });
        return;
      }
      if (event.type === "generate_task_nodes_stopped") {
        finish();
        callbacks.onStopped();
        return;
      }
      if (event.type === "generate_task_nodes_error") {
        finish();
        callbacks.onError({
          code: typeof event.errorCode === "string" ? event.errorCode : undefined,
          message: String(event.error || "The model could not generate tasks."),
          attempts: typeof event.attempts === "number" ? event.attempts : undefined,
        });
      }
    };

    unsubscribe = agentHarnessClient.subscribe(request.nodeId, handleEvent);

    void agentHarnessClient
      .startRun({
        type: "generate_task_nodes",
        runId: request.nodeId,
        conversationId: request.nodeId,
        requestId: request.requestId,
        nodeId: request.nodeId,
        model: request.model,
        chatHistory: request.chatHistory,
        additionalInstructions: request.additionalInstructions,
        workspaceRoot: request.workspaceRoot,
        customProvider: request.customProvider,
      })
      .then((handle) => {
        cancelRun = handle.cancel;
        if (settled) void handle.cancel();
      })
      .catch((error: unknown) => {
        if (settled) return;
        finish();
        callbacks.onError({
          message: error instanceof Error ? error.message : `Could not connect to the agent sidecar on port ${SIDECAR_PORT}.`,
        });
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
