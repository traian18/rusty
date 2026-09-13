/**
 * Reconciliate Edge Capability
 * 
 * Implements the "reconciliate_edge" operation. It gathers information from
 * source and target tasks connected by a workspace canvas edge, loads the file diffs,
 * and calls the agent session runtime to evaluate and resolve conflicting requirements.
 */

import { WebSocket } from "ws";
import path from "path";
import { safeSend, request, validateReadFileRpcResponse, validateWriteFileRpcResponse } from "../services/websocket";
import { PayloadValidationError, requireString } from "../../../shared/agent-protocol";
import { createListFilesTool, createSearchCodebaseTool } from "../services/tools";
import { callLlmWithToolsPiStreaming } from "../services/llmRuntime";
import { createUsageReporter } from "../services/usageBroadcast";

// Same rationale as globalExplore.ts's stopGlobalExploration: this capability's
// tool loop (callLlmWithToolsPiStreaming, the same shouldAbort-polling
// implementation globalExplore uses) has no activePiRuns-backed cancellation
// of its own, and shouldAbort's old "has the per-run socket closed" check no
// longer trips once every capability shares one agentHarnessClient connection.
const activeReconciliations = new Set<string>();
const cancelledReconciliations = new Set<string>();

/** Real cancellation for a reconciliate_edge run: returns whether one was active. */
export function stopEdgeReconciliation(edgeId: string): boolean {
  const wasActive = activeReconciliations.has(edgeId);
  cancelledReconciliations.add(edgeId);
  return wasActive;
}

export async function reconciliateEdge(ws: WebSocket, data: any): Promise<void> {
  const { edgeId, sourceTaskId, targetTaskId, modifiedFiles, userMessage, chatHistory, workspaceRoot, model, sourcePrompt, targetPrompt, customProvider } = data;

  try {
    requireString(edgeId, "edgeId");
    requireString(sourceTaskId, "sourceTaskId");
    requireString(targetTaskId, "targetTaskId");
    requireString(workspaceRoot, "workspaceRoot");
  } catch (error) {
    if (!(error instanceof PayloadValidationError)) throw error;
    safeSend(ws, { type: "reconciliation_error", edgeId, error: error.message });
    return;
  }

  console.log(`WebSocket [Server] reconciliate_edge starting`, { edgeId, sourceTaskId, targetTaskId });
  activeReconciliations.add(edgeId);
  cancelledReconciliations.delete(edgeId);

  try {
    const readVfsTool = {
      name: "read_file",
      description: "Read a file from the workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative file path" } },
        required: ["path"],
      },
      execute: async ({ path: filePath }: { path: string }) => {
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
        const res = await request(ws, {
          type: "read_file",
          runId: edgeId,
          payload: { path: resolvedPath },
          validateResponse: validateReadFileRpcResponse,
        });
        if (res.error) {
          const errorMsg = String(res.error).toLowerCase();
          if (errorMsg.includes("not found") || errorMsg.includes("no such file") || errorMsg.includes("exist")) {
            console.log(`WebSocket [Server] reconciliate_edge read_file target not found, returning placeholder: ${resolvedPath}`);
            return "[File does not exist yet. You can create it by calling write_file with content.]";
          }
          throw new Error(String(res.error));
        }
        return res.content;
      }
    };

    const writeVfsTool = {
      name: "write_file",
      description: "Write file content to the virtual workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          content: { type: "string", description: "Complete replacement file content" },
        },
        required: ["path", "content"],
      },
      execute: async ({ path: filePath, content }: { path: string; content: string }) => {
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
        const res = await request(ws, {
          type: "write_file",
          runId: edgeId,
          payload: { path: resolvedPath, content },
          validateResponse: validateWriteFileRpcResponse,
        });
        if (res.error) throw new Error(String(res.error));
        return `File successfully written to: ${resolvedPath}`;
      }
    };

    const filesInfo = modifiedFiles?.length > 0
      ? `Files modified by source task: ${modifiedFiles.join(", ")}`
      : "No files were modified by the source task.";

    const systemPrompt = `You are a code reconciliation assistant inside a spatial development canvas.
You are checking whether the code changes made by a SOURCE task are compatible with a TARGET task's requirements.

${filesInfo}

Source task instructions: ${sourcePrompt || "(not provided)"}
Target task instructions: ${targetPrompt || "(not provided)"}

User message: ${userMessage}

Your job:
1. Read the modified files to understand what changes were made.
2. Analyze whether these changes conflict with the target task's requirements.
3. If there are conflicts, explain them clearly and suggest fixes.
4. If the user asks you to fix conflicts, use 'write_file' to apply the resolution.
5. CRITICAL: When making changes to a file, write the complete file with all changes included to the EXACT same path. Do NOT create a new/duplicate file with a similar or modified name. You must replace/overwrite the existing file. Never write partial code or snippets.

Workspace root: ${workspaceRoot || "unknown"}
`;

    const modelReference = model || customProvider?.models?.find((item: any) => item.supported !== false)?.id || "";
    if (!modelReference) throw new Error("No model is selected. Configure one in LLM Setup.");
    const response = await callLlmWithToolsPiStreaming({
      modelReference,
      customProvider,
      systemPrompt,
      userMessage: userMessage || "Check for code conflicts between the tasks and reconcile if needed.",
      tools: [readVfsTool, writeVfsTool, createListFilesTool(workspaceRoot), createSearchCodebaseTool(workspaceRoot)],
      sendLog: (message) => console.log(`[ReconciliateEdge] ${message}`),
      sendToken: () => {},
      maxRounds: 15,
      cwd: workspaceRoot,
      history: chatHistory || [],
      shouldAbort: () => ws.readyState !== WebSocket.OPEN || cancelledReconciliations.has(edgeId),
      onUsage: createUsageReporter(ws, {
        workspaceRoot,
        surface: "edge_reconciliation",
        nodeId: edgeId,
        model: modelReference,
        provider: customProvider?.id,
      }),
    });

    safeSend(ws, {
      type: "reconciliation_complete",
      edgeId,
      response
    });
  } catch (err: any) {
    console.error("WebSocket [Server] reconciliate_edge error:", err);
    safeSend(ws, {
      type: "reconciliation_error",
      edgeId,
      error: err.message
    });
  } finally {
    activeReconciliations.delete(edgeId);
    cancelledReconciliations.delete(edgeId);
  }
}
