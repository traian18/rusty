/**
 * Global Explore Capability
 * 
 * Implements the "global_explore" operation. It scans the repository files using
 * recursive explorers, runs search queries, and makes multi-round tool-calling
 * calls to the resolved harness to yield architectural codebase summaries.
 */

import { WebSocket } from "ws";
import path from "path";
import fs from "fs";
import { safeSend, request, validateReadFileRpcResponse } from "../services/websocket";
import { PayloadValidationError, requireString } from "../../../shared/agent-protocol";
import { createListFilesTool, createSearchCodebaseTool, listFilesRecursive } from "../services/tools";
import { resolveHarness } from "../services/harness";
import { createMcpTools, McpServerConfig } from "../services/mcpClient";
import { createUsageReporter } from "../services/usageBroadcast";

// runToolLoop (unlike executeNode/agentChat/inlineChat's runAgentic) has no
// activePiRuns-backed cancellation of its own -- its shouldAbort callback is
// only ever polled between tool-calling rounds, so it needs a real signal to
// poll. Before this, that signal was "has the (per-run, in the old
// architecture) WebSocket closed" -- now that every capability shares one
// long-lived agentHarnessClient connection, the socket no longer closes just
// because one exploration should stop, so a real per-nodeId cancellation
// flag is what shouldAbort now polls instead.
const activeExplorations = new Set<string>();
const cancelledExplorations = new Set<string>();

/** Real cancellation for a global_explore run: returns whether one was active. */
export function stopGlobalExploration(nodeId: string): boolean {
  const wasActive = activeExplorations.has(nodeId);
  cancelledExplorations.add(nodeId);
  return wasActive;
}

export async function globalExplore(ws: WebSocket, data: any): Promise<void> {
  const { nodeId, prompt, workspaceRoot, model, chatHistory, customProvider, mcpServers, planOnly } = data;

  try {
    requireString(nodeId, "nodeId");
    requireString(prompt, "prompt");
    requireString(workspaceRoot, "workspaceRoot");
  } catch (error) {
    if (!(error instanceof PayloadValidationError)) throw error;
    safeSend(ws, { type: "global_explore_error", nodeId, error: error.message });
    return;
  }

  console.log(`WebSocket [Server] global_explore starting`, { nodeId, workspaceRoot, model, mcpCount: mcpServers?.length || 0 });

  const sendLog = (message: string) => {
    safeSend(ws, { type: "log", nodeId, message });
  };

  const mcpDisposers: Array<() => void> = [];
  activeExplorations.add(nodeId);
  cancelledExplorations.delete(nodeId);

  try {
    const readVfsTool = {
      name: "read",
      description: "Read a file from the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to read" }
        },
        required: ["path"]
      },
      execute: async ({ path: filePath }: { path: string }) => {
        console.log(`WebSocket [Server] global_explore read_file tool: ${filePath}`);
        
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
        try {
          if (fs.existsSync(resolvedPath)) {
            const stats = fs.statSync(resolvedPath);
            if (stats.isDirectory()) {
              const errorMsg = `Error: '${filePath}' is a directory, not a file. To list directory contents, use list_files.`;
              console.log(`WebSocket [Server] read_file directory guard: ${errorMsg}`);
              sendLog(`Directory read attempt: ${filePath}`);
              return errorMsg;
            }
          }
        } catch (statErr: any) {
          console.warn(`WebSocket [Server] read_file stat error for ${filePath}:`, statErr);
        }

        sendLog(`Reading file: ${filePath}`);
        const res = await request(ws, {
          type: "read_file",
          runId: nodeId,
          payload: { path: resolvedPath },
          validateResponse: validateReadFileRpcResponse,
        });
        if (res.error) {
          const errorMsg = String(res.error).toLowerCase();
          if (errorMsg.includes("not found") || errorMsg.includes("no such file") || errorMsg.includes("exist")) {
            console.log(`WebSocket [Server] global_explore read_file target not found, returning placeholder: ${resolvedPath}`);
            return "[File does not exist yet. You can create it by calling write_file with content.]";
          }
          console.error(`WebSocket [Server] read_file error: ${res.error}`);
          throw new Error(String(res.error));
        }
        console.log(`WebSocket [Server] read_file success: ${filePath} (${String(res.content || "").length} chars)`);
        return res.content;
      }
    };

    const tools = [
      readVfsTool,
      createListFilesTool(workspaceRoot),
      createSearchCodebaseTool(workspaceRoot)
    ];

    // Merge tools from any MCP servers selected on the Global Explorer node.
    const mcpToolLines: string[] = [];
    if (Array.isArray(mcpServers) && mcpServers.length > 0) {
      for (const server of mcpServers as McpServerConfig[]) {
        try {
          const { tools: mcpTools, dispose } = await createMcpTools(server, sendLog);
          mcpDisposers.push(dispose);
          for (const t of mcpTools) {
            tools.push(t);
            mcpToolLines.push(`- '${t.name}': ${t.description}`);
          }
        } catch (err: any) {
          sendLog(`MCP server "${server.name}" could not be loaded: ${err.message}`);
        }
      }
    }

    const PLAN_ONLY_INSTRUCTIONS = `<model Instructions>
You are a PLANNING AND ANALYSIS assistant. You MUST follow these rules strictly:
1. NEVER write, generate, or suggest any code, code snippets, file paths, or implementation details
2. NEVER provide import statements, function signatures, or class definitions
3. ONLY provide: structured plans, step-by-step descriptions, architecture analysis, dependency mapping, risk assessment
4. ALWAYS structure your response with clear section headers and bullet points
5. Focus on WHAT needs to be done and WHY, never HOW to implement it in code
6. Your entire response must be descriptive planning content only - absolutely no code
<model Instructions>
<user prompt>
`;

    const systemPrompt = `You are a codebase exploration assistant inside a spatial development canvas called Rusty.
Your job is to analyze the workspace and provide architectural summaries, patterns, and guidelines.

Workspace root: ${workspaceRoot || "unknown"}

You have access to tools:
- 'read': Read any file in the workspace (input: {{"path": "file/path"}}).
- 'list_files': List all files in the workspace recursively (no input needed).
- 'search_codebase': Search for text patterns across the codebase (input: {{"pattern": "search text"}}).
${mcpToolLines.length > 0 ? `\nMCP integration tools (external data sources):\n${mcpToolLines.join("\n")}\n` : ""}
IMPORTANT: Always use tools to explore the codebase before answering. Start by listing files, then read relevant ones.
${mcpToolLines.length > 0 ? "If the user asks for external information available via MCP tools, call those tools to fetch it.\n" : ""}

After exploring, provide:
1. A clear architectural summary of the codebase structure.
2. Key patterns and conventions used.
3. Guidelines for making changes that align with the existing codebase.

IMPORTANT: End your response with a section marked "--- SUMMARY ---" that contains a concise bullet-point list of architectural guidelines. This summary will be injected into all task execution prompts.
`;

    sendLog("Initializing exploration agent...");

    let runResult;
    try {
      const modelReference = model || customProvider?.models?.find((item: any) => item.supported !== false)?.id || "";
      if (!modelReference) throw new Error("No model is selected. Configure one in LLM Setup.");
      console.log(`WebSocket [Server] Calling LLM (streaming): ${modelReference}`);

      const augmentedPrompt = planOnly
        ? `${PLAN_ONLY_INSTRUCTIONS}${prompt}\n<user prompt>`
        : prompt;

      console.log(`WebSocket [Server] planOnly=${planOnly}, original prompt length=${prompt.length}, augmented length=${augmentedPrompt.length}`);
      console.log(`WebSocket [Server] augmented prompt preview: ${augmentedPrompt.substring(0, 300)}...`);

      const sendToken = (token: string) => {
        // nodeId added so a client subscribed to multiple runs can tell which
        // exploration a token belongs to -- previously this event carried no
        // correlating id at all, unlike every other capability's token event.
        safeSend(ws, { type: "token", nodeId, content: token });
      };

      const responseText = await resolveHarness(customProvider).runToolLoop({
        modelReference,
        customProvider,
        systemPrompt,
        userMessage: augmentedPrompt,
        tools,
        sendLog,
        sendToken,
        maxRounds: 50,
        cwd: workspaceRoot,
        history: chatHistory || [],
        shouldAbort: () => ws.readyState !== WebSocket.OPEN || cancelledExplorations.has(nodeId),
        onUsage: createUsageReporter(ws, {
          workspaceRoot,
          surface: "global_explore",
          nodeId,
          model: modelReference,
          provider: customProvider?.id,
        }),
      });

      runResult = { response: responseText };
      sendLog("Exploration complete.");
    } catch (sdkError: any) {
      console.error("WebSocket [Server] LLM error:", sdkError);
      sendLog(`LLM error: ${sdkError.message}. Using simulation fallback.`);

      const files = listFilesRecursive(workspaceRoot);
      const fileCount = files.length;
      const dirs = new Set(files.map(f => f.split("/")[0]));
      const topDirs = Array.from(dirs).slice(0, 10).join(", ");

      runResult = {
        response: `# Workspace Analysis (Simulated)\n\nI found **${fileCount}** files across the workspace.\n\nTop-level directories: ${topDirs}\n\n--- SUMMARY ---\n- Workspace contains ${fileCount} files\n- Main directories: ${topDirs}\n- Follow existing code patterns and naming conventions\n- Maintain consistent formatting and styling`,
        summary: `- Workspace contains ${fileCount} files\n- Main directories: ${topDirs}\n- Follow existing code patterns and naming conventions`
      };
    }

    const responseText = (runResult as any)?.response || "Exploration completed.";
    let summary = "";
    const summaryMatch = responseText.match(/---\s*SUMMARY\s*---([\s\S]*?)$/i);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    } else if ((runResult as any)?.summary) {
      summary = (runResult as any).summary;
    }

    console.log(`WebSocket [Server] Global Explore completed. Response length: ${responseText.length} chars`);
    mcpDisposers.forEach((d) => d());

    safeSend(ws, {
      type: "global_explore_complete",
      nodeId,
      response: responseText,
      summary
    });
  } catch (err: any) {
    console.error(`WebSocket [Server] global_explore error:`, err);
    mcpDisposers.forEach((d) => d());
    safeSend(ws, {
      type: "global_explore_error",
      nodeId,
      error: err.message
    });
  } finally {
    activeExplorations.delete(nodeId);
    cancelledExplorations.delete(nodeId);
  }
}
