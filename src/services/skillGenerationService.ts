// ============================================================
// skillGenerationService.ts — Typed replacement for raw
// createAgentHarnessSocket() use of the "generate_skill" capability
// (PR 4b), used only by SkillsTab.tsx's "Generate with AI" button.
//
// Mirrors inlineChatService.ts's shape. generate_skill previously had
// no routing id in its payload at all (unlike every other capability)
// and no cancellation -- both fixed server-side (see
// agent-sidecar/src/capabilities/generateSkill.ts's header) by using
// the envelope's own runId, which PR 4a's unwrapEnvelope already
// spreads into every capability's `data` whether or not that
// capability's own payload defines a routing field. This service's
// startRun lets agentHarnessClient generate that runId; cancel() sends
// a real generate_skill_stop instead of just closing a socket.
//
// Also renames the completion event from generate_skill_response
// (not even named _complete, the one inconsistency this fixes) to
// generate_skill_complete.
// ============================================================

import { agentHarnessClient, RunEvent } from "./agentHarnessClient";
import { SIDECAR_PORT } from "../config/sidecar";

export interface SkillGenerationRequest {
  model: string;
  description: string;
  workspaceRoot: string;
  customProvider: unknown;
}

export interface SkillGenerationCallbacks {
  onLog?: (message: string) => void;
  onComplete: (spec: unknown) => void;
  onError: (message: string) => void;
}

export interface SkillGenerationRun {
  cancel: () => void;
}

export const skillGenerationService = {
  generate(request: SkillGenerationRequest, callbacks: SkillGenerationCallbacks): SkillGenerationRun {
    let settled = false;
    let cancelRun: (() => Promise<void>) | undefined;
    let unsubscribe: (() => void) | undefined;
    let runId: string | undefined;

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
      if (event.type === "generate_skill_log") {
        callbacks.onLog?.(String(event.message ?? ""));
        return;
      }
      if (event.type === "generate_skill_complete") {
        finish();
        callbacks.onComplete(event.spec);
        return;
      }
      if (event.type === "generate_skill_error") {
        fail(String(event.error || "Generation failed."));
      }
    };

    void agentHarnessClient
      .startRun({
        type: "generate_skill",
        model: request.model,
        description: request.description,
        workspaceRoot: request.workspaceRoot,
        customProvider: request.customProvider,
      })
      .then((handle) => {
        runId = handle.runId;
        cancelRun = handle.cancel;
        unsubscribe = agentHarnessClient.subscribe(runId, handleEvent);
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
