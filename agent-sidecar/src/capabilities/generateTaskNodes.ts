import { WebSocket } from "ws";
import { safeSend } from "../services/websocket";
import { EmptyLlmResponseError } from "../services/llmRuntime";
import { resolveHarness } from "../services/harness";
import {
  buildTaskGenerationQuery,
  TASK_GENERATION_SYSTEM_PROMPT,
  type TaskGenerationChatEntry,
} from "./taskGenerationPrompt";
import {
  InvalidTaskOutputError,
  parseGeneratedTaskGraph,
} from "./generatedTaskGraph";

const activeTaskGenerations = new Map<string, AbortController>();
const TASK_GENERATION_MAX_TOKENS = 16_000;

export function stopTaskNodeGeneration(requestId: string): boolean {
  const controller = activeTaskGenerations.get(requestId);
  if (!controller) return false;
  controller.abort();
  activeTaskGenerations.delete(requestId);
  return true;
}

export async function generateTaskNodes(ws: WebSocket, data: any): Promise<void> {
  const { requestId, nodeId, model, customProvider } = data;
  const abortController = new AbortController();
  activeTaskGenerations.set(requestId, abortController);
  try {
    const history: TaskGenerationChatEntry[] = Array.isArray(data.chatHistory)
      ? data.chatHistory.filter((entry: any) => (entry?.role === "user" || entry?.role === "assistant") && typeof entry.content === "string")
      : [];
    if (!history.length) throw new Error("Discuss the story in Global Chat before generating tasks.");

    const modelReference = model || customProvider?.models?.find((item: any) => item.supported !== false)?.id || "";
    if (!modelReference) throw new Error("Select a model before generating tasks.");
    safeSend(ws, { type: "generate_task_nodes_log", requestId, nodeId, message: `Generating task draft with ${modelReference}...` });

    const additionalInstructions = typeof data.additionalInstructions === "string"
      ? data.additionalInstructions.trim().slice(0, 8000)
      : "";
    const userMessage = buildTaskGenerationQuery(history, additionalInstructions);
    const harness = resolveHarness(customProvider);

    let previousFailure: "empty" | "invalid" | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const retryInstruction = previousFailure === "empty"
          ? "Your previous response contained no visible text. This is the final retry. Use minimal reasoning and return the required JSON object immediately."
          : "Your previous response could not be parsed as the required task JSON. This is the final retry. Return exactly one JSON object that follows the schema, with no surrounding text.";
        const content = await harness.completeText({
          modelReference,
          customProvider,
          systemPrompt: attempt === 1
            ? TASK_GENERATION_SYSTEM_PROMPT
            : `${TASK_GENERATION_SYSTEM_PROMPT}\n\n${retryInstruction}`,
          userMessage,
          // Generated plans can now include verbatim code-context nodes, so the
          // former 5k budget is too small for otherwise valid task graphs.
          maxTokens: TASK_GENERATION_MAX_TOKENS,
          reasoning: "minimal",
          cwd: data.workspaceRoot,
          signal: abortController.signal,
        });
        const graph = parseGeneratedTaskGraph(content);
        safeSend(ws, {
          type: "generate_task_nodes_complete",
          requestId,
          nodeId,
          tasks: graph.tasks,
          contexts: graph.contexts,
          attempts: attempt,
        });
        return;
      } catch (error) {
        if (abortController.signal.aborted) throw error;
        const isEmptyResponse = error instanceof EmptyLlmResponseError;
        if (!isEmptyResponse && !(error instanceof InvalidTaskOutputError)) throw error;
        if (attempt === 1) {
          previousFailure = isEmptyResponse ? "empty" : "invalid";
          safeSend(ws, {
            type: "generate_task_nodes_log",
            requestId,
            nodeId,
            message: isEmptyResponse
              ? "The model returned no visible task JSON. Retrying once with a larger output budget and minimal reasoning..."
              : "The model returned invalid task JSON. Retrying once with stricter formatting instructions...",
          });
          continue;
        }
        if (isEmptyResponse) {
          const lengthHint = error.stopReason === "length"
            ? " The model exhausted its available output budget; reduce unusually large code snippets or use a model with a larger output limit."
            : " Try again or verify that the provider supports text completions for this model.";
          safeSend(ws, {
            type: "generate_task_nodes_error",
            requestId,
            nodeId,
            errorCode: "EMPTY_MODEL_RESPONSE",
            attempts: attempt,
            error: `The model returned no task JSON after two attempts.${lengthHint}`,
          });
          return;
        }
        safeSend(ws, {
          type: "generate_task_nodes_error",
          requestId,
          nodeId,
          errorCode: "INVALID_TASK_JSON",
          attempts: attempt,
          error: "The model returned invalid task JSON twice. This model may be too small to generate a reliable task plan. Switch to a more capable model and try again.",
        });
        return;
      }
    }
  } catch (error: any) {
    // generate_task_nodes_stopped is owned exclusively by server.ts's
    // immediate ack to a generate_task_nodes_stop request ({requestId,
    // nodeId, stopped}) -- this used to ALSO emit generate_task_nodes_stopped
    // from here with a different shape ({requestId, nodeId, error}) once the
    // aborted signal unwound into this catch block, so a client would
    // receive two events sharing one type name but incompatible fields.
    // Settling as generate_task_nodes_error uniformly (whether the cause was
    // a real failure or a user-requested stop) mirrors how agent_chat/
    // inline_chat already report a stopped run's own settlement.
    safeSend(ws, {
      type: "generate_task_nodes_error",
      requestId,
      nodeId,
      error: abortController.signal.aborted ? "Task generation stopped." : error?.message || String(error),
    });
  } finally {
    activeTaskGenerations.delete(requestId);
  }
}
