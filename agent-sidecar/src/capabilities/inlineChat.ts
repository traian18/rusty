import { WebSocket } from "ws";
import { safeSend } from "../services/websocket";
import { runInlineChatWithModel } from "../services/inlineChatPi";
import { createUsageReporter } from "../services/usageBroadcast";
import { PayloadValidationError, requireRecord, requireString } from "../../../shared/agent-protocol";

/**
 * WebSocket capability for a single, non-agentic inline model call.
 *
 * This was the one capability that already validated its required fields by
 * hand (see shared/agent-protocol/validation.ts's header comment) -- restyled
 * onto the same shared requireString/requireRecord helpers the other 8
 * capabilities adopted in this PR, for one consistent validation style
 * across all 9, with no change in which fields are required or what error
 * is sent back.
 */
export async function inlineChat(ws: WebSocket, data: any): Promise<void> {
  const { sessionId, message, model, workspaceRoot, customProvider, history, context } = data;

  try {
    requireString(sessionId, "sessionId");
    requireString(message, "message");
    requireString(model, "model");
    requireString(workspaceRoot, "workspaceRoot");
    requireString(requireRecord(context, "context").filePath, "context.filePath");
  } catch (error) {
    if (!(error instanceof PayloadValidationError)) throw error;
    safeSend(ws, { type: "inline_chat_error", sessionId, error: "Inline chat request is incomplete." });
    return;
  }
  (ws as any).__activeAgentTabId = sessionId;

  try {
    const response = await runInlineChatWithModel({
      sessionId,
      message,
      model,
      workspaceRoot,
      customProvider,
      history: Array.isArray(history) ? history : [],
      context,
      sendToken: (content) => safeSend(ws, { type: "inline_chat_token", sessionId, content }),
      onUsage: createUsageReporter(ws, {
        workspaceRoot,
        surface: "inline_chat",
        sessionId,
        model,
        provider: customProvider?.id,
      }),
    });
    safeSend(ws, { type: "inline_chat_complete", sessionId, response });
  } catch (error: any) {
    console.error(`[InlineChat:${sessionId}]`, error);
    safeSend(ws, {
      type: "inline_chat_error",
      sessionId,
      error: error?.message || "Inline chat failed.",
    });
  }
}
