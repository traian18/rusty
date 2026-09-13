/**
 * Execute Node Capability
 * 
 * Implements the "execute_node" operation. It gathers attached input context files,
 * builds a system prompt matching the instructions, and runs the task through the
 * resolved harness (Pi's native runtime, or the matching managed-runtime adapter).
 */

import { WebSocket } from "ws";
import path from "path";
import { safeSend, request, validateReadFileRpcResponse, validateWriteFileRpcResponse } from "../services/websocket";
import { createListFilesTool, createSearchCodebaseTool } from "../services/tools";
import { createMcpTools, McpServerConfig } from "../services/mcpClient";
import { createLspTools } from "../services/lspTools";
import { resolveHarness } from "../services/harness";
import { createUsageReporter } from "../services/usageBroadcast";
import {
  acquireTaskExecutionSlot,
  getTaskExecutionLimit,
  taskExecutionWouldQueue,
} from "../services/taskExecutionLimiter";

export async function executeNode(ws: WebSocket, data: any): Promise<void> {
  const { nodeId, instructions, model, workspaceRoot, inputFiles, customProvider, globalContext, contextDescriptions, chatHistory, skill, mcpContext, upstreamTaskContext, lspSettings } = data;
  console.log(`WebSocket [Server] execute_node task starting`, {
    nodeId,
    model,
    workspaceRoot,
    inputFilesCount: inputFiles?.length || 0,
    chatHistoryCount: chatHistory?.length || 0,
    hasSkill: !!skill,
    mcpContextCount: mcpContext?.length || 0,
    upstreamTasksCount: upstreamTaskContext?.length || 0,
    lspEnabled: lspSettings?.enabled
  });

  const modifiedFiles = new Set<string>();
  const mcpDisposers: Array<() => void> = [];

  const sendLog = (message: string) => {
    safeSend(ws, { type: "log", nodeId, message });
  };

  const wasQueued = taskExecutionWouldQueue();
  if (wasQueued) {
    sendLog(`Queued until an agent slot is available (${getTaskExecutionLimit()} task nodes may run concurrently).`);
  }
  const releaseExecutionSlot = await acquireTaskExecutionSlot();
  if (ws.readyState !== WebSocket.OPEN) {
    releaseExecutionSlot();
    return;
  }
  if (wasQueued) sendLog("Agent slot acquired; starting task execution.");

  try {
    const readVfsTool = {
      name: "read_file",
      description: "Read a file's content from the virtual workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to read" }
        },
        required: ["path"]
      },
      execute: async ({ path: filePath }: { path: string }) => {
        console.log(`WebSocket [Server] tool read_file requested: ${filePath}`);
        sendLog(`AI reading file context: ${filePath}`);
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
        const res = await request(ws, {
          type: "read_file",
          runId: nodeId,
          payload: { path: resolvedPath },
          validateResponse: validateReadFileRpcResponse,
        });
        if (res.error) {
          const errorMsg = String(res.error).toLowerCase();
          if (errorMsg.includes("not found") || errorMsg.includes("no such file") || errorMsg.includes("exist")) {
            console.log(`WebSocket [Server] read_file target not found, returning placeholder for new file creation: ${resolvedPath}`);
            return "[File does not exist yet. You can create it by calling write_file with content.]";
          }
          console.error(`WebSocket [Server] read_file failed for: ${resolvedPath}`, res.error);
          throw new Error(String(res.error));
        }
        console.log(`WebSocket [Server] read_file success for: ${resolvedPath} (${String(res.content || "").length} chars)`);
        return res.content;
      }
    };

    const writeVfsTool = {
      name: "write_file",
      description: "Write or edit a file's content in the virtual workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to write/edit" },
          content: { type: "string", description: "The full content of the file" }
        },
        required: ["path", "content"]
      },
      execute: async ({ path: filePath, content }: { path: string; content: string }) => {
        console.log(`WebSocket [Server] tool write_file requested: ${filePath} (${content.length} chars)`);
        sendLog(`AI modifying file: ${filePath}`);
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
        modifiedFiles.add(resolvedPath);
        
        const res = await request(ws, {
          type: "write_file",
          runId: nodeId,
          payload: { path: resolvedPath, content },
          validateResponse: validateWriteFileRpcResponse,
        });
        if (res.error) {
          console.error(`WebSocket [Server] write_file failed for: ${resolvedPath}`, res.error);
          throw new Error(String(res.error));
        }
        console.log(`WebSocket [Server] write_file success for: ${resolvedPath}`);
        return `File successfully written to: ${resolvedPath}`;
      }
    };

    sendLog("Initializing Pi agent runtime...");

    const lspTools = createLspTools(workspaceRoot, lspSettings, sendLog);

    const allTools = [
      readVfsTool,
      writeVfsTool,
      createListFilesTool(workspaceRoot),
      createSearchCodebaseTool(workspaceRoot),
      ...lspTools
    ];

    // Connect to MCP servers attached via MCP context nodes and merge their tools.
    const mcpToolDescriptions: string[] = [];
    if (Array.isArray(mcpContext) && mcpContext.length > 0) {
      for (const ctx of mcpContext) {
        const server: McpServerConfig = ctx.server;
        const description: string = ctx.description || "";
        const mcpNodeId = ctx.nodeId;
        try {
          const { tools: mcpTools, dispose } = await createMcpTools(server, sendLog);
          mcpDisposers.push(dispose);
          
          if (server.enabled && mcpTools.length === 0) {
            throw new Error(`Failed to list tools from MCP server "${server.name}". Handshake failed or server returned no tools.`);
          }
          
          for (const t of mcpTools) {
            allTools.push(t);
            mcpToolDescriptions.push(`- '${t.name}': ${t.description}`);
          }
          if (description) {
            mcpToolDescriptions.push(`  (User intent for ${server.name}: ${description})`);
          }
          
          // Connection succeeded
          if (mcpNodeId) {
            safeSend(ws, {
              type: "node_status_change",
              targetNodeId: mcpNodeId,
              status: "success",
              nodeName: server.name,
            });
          }
        } catch (err: any) {
          // Connection failed
          if (mcpNodeId) {
            safeSend(ws, {
              type: "node_status_change",
              targetNodeId: mcpNodeId,
              status: "error",
              message: err.message,
              nodeName: server.name,
            });
          }
          const errMsg = `MCP Node execution aborted: ${err.message}`;
          sendLog(errMsg);
          throw new Error(errMsg);
        }
      }
    }

    // Task Nodes are VFS code generators. Even if a selected skill advertises
    // run_command, physical command execution is reserved for interactive
    // agent surfaces and the controlled reconciliation verifier.
    const enabledToolNames = (skill?.enabledTools || [
      "read_file",
      "write_file",
      "list_files",
      "search_codebase",
      "web_search",
      ...(lspSettings?.enabled ? ["lsp_get_definition", "lsp_get_references", "lsp_get_diagnostics"] : [])
    ]).filter((name: string) => name !== "run_command");
    // Built-in tools are filtered by the skill; MCP tools are always available.
    const tools = [
      ...allTools.filter((t: any) => enabledToolNames.includes(t.name)),
      ...allTools.filter((t: any) => t.name.startsWith("mcp__")),
    ];

    const toolDescriptions: Record<string, string> = {
      read_file: "- 'read_file': Read a file's current content before editing it.",
      write_file: "- 'write_file': Write or edit a file.",
      list_files: "- 'list_files': Discover files in the workspace.",
      search_codebase: "- 'search_codebase': Find specific code patterns.",
      web_search: "- 'web_search': Search the public web for current information and return cited sources (input: {\"query\": \"search query\"}).",
      lsp_get_definition: "- 'lsp_get_definition': Find definition of a symbol (input: {\"path\": \"file/path\", \"line\": lineNum, \"character\": colNum}).",
      lsp_get_references: "- 'lsp_get_references': Find all references of a symbol (input: {\"path\": \"file/path\", \"line\": lineNum, \"character\": colNum}).",
      lsp_get_diagnostics: "- 'lsp_get_diagnostics': Get compile errors/warnings for a file (input: {\"path\": \"file/path\"})."
    };
    const toolListText = [
      ...enabledToolNames.map((name: string) => toolDescriptions[name] || `- '${name}'`),
      ...mcpToolDescriptions,
    ].join("\n");

    const filesList = inputFiles && inputFiles.length > 0
      ? `You have direct read/write access to the following connected files:
${inputFiles.map((f: any) => `- ${f.path}`).join("\n")}
Please read them first if you need to modify or inspect them.`
      : `No input files are directly connected to this task node. You can read/write any files in the workspace.`;

    const upstreamSection = Array.isArray(upstreamTaskContext) && upstreamTaskContext.length > 0
      ? upstreamTaskContext.map((t: any) => {
          const fileBlocks = (t.files || [])
            .map((f: any) => `--- File: ${f.path} ---\n${f.content}`)
            .join("\n\n");
          return `[Upstream Task: ${t.taskName}]\nPrevious instructions: ${t.prompt || "(none)"}\nGenerated code:\n${fileBlocks || "(no files captured)"}`;
        }).join("\n\n")
      : "";

    const defaultSystemPrompt = `You are a bounded task executor — one node in a larger multi-node plan. You have a single, small, well-defined responsibility. Other nodes handle everything else.

YOUR TASK:
${instructions}

HARD BOUNDARIES — read these before anything else:
- You may ONLY write files that are directly and explicitly required by your task above. Nothing else.
- You may NOT create any file that was not asked for: no README, no docs, no changelogs, no extra configs, no test files, no helper utilities, no migration scripts — unless the task explicitly requests them.
- You may NOT refactor, clean up, or improve code that is outside your task scope, even if you notice issues.
- You may NOT add features, abstractions, or "while I'm at it" improvements beyond what is stated.
- You are NOT working independently. Other nodes have run before you and others will run after. Stay in your lane.

READING vs WRITING:
- You may read any file in the codebase to understand structure, conventions, or dependencies. Reading is free.
- Writing is restricted: only files your task explicitly requires.

Workspace root: ${workspaceRoot || "unknown"}
${filesList}
${globalContext ? `\n--- GLOBAL CONTEXT (read-only reference) ---\n${globalContext}\n` : ""}
${contextDescriptions && contextDescriptions.length > 0 ? `\n--- CONNECTED CONTEXT (read-only reference) ---\n${contextDescriptions.join("\n")}\n` : ""}
${upstreamSection ? `\n--- UPSTREAM TASK CHANGES (already applied — do not redo) ---\nThe following tasks have already run and modified these files. Treat their output as the current state of the codebase.\nYOUR ONLY JOB: Make the additional changes required by YOUR instructions. Do NOT rewrite, re-implement, or reapply anything the upstream task already did. Do NOT write a file unless your task specifically requires changing it.\n${upstreamSection}\n` : ""}
${mcpToolDescriptions.length > 0 ? `\n--- MCP TOOL INTEGRATIONS ---\n${mcpToolDescriptions.join("\n")}\n` : ""}
Available tools:
${toolListText}

File writing rules:
- Write the complete file content — never partial edits or diffs.
- Write to the exact existing path. Do NOT create a renamed or duplicate file.
- Once all required files are written, stop immediately and summarize what changed.
`;

    const skillGuidance = skill?.systemPrompt
      ? `\n\nActive skill guidance (adds to, does not replace, the boundaries above):\n${skill.systemPrompt
          .replace(/\$\{workspaceRoot\}/g, workspaceRoot || "unknown")
          .replace(/\$\{instructions\}/g, instructions)}`
      : "";

    const systemPrompt = `${defaultSystemPrompt}${skillGuidance}`;

    (ws as any).__activeAgentTabId = nodeId;
    const piModel = model || customProvider?.models?.find((item: any) => item.supported !== false)?.id || "";
    if (!piModel) throw new Error("No model is selected. Configure one in LLM Setup.");
    const usageReporter = createUsageReporter(ws, {
      workspaceRoot,
      surface: "node_execution",
      nodeId,
      model: piModel,
      provider: customProvider?.id,
    });

    const responseText = await resolveHarness(customProvider).runAgentic({
      tabId: nodeId,
      model: piModel,
      workspaceRoot,
      systemPrompt,
      conversationHistory: chatHistory || [],
      message: instructions,
      tools,
      customProvider,
      sendLog,
      sendToken: (token) => safeSend(ws, { type: "token", nodeId, content: token }),
      sendSubagentUpdate: (subagent) => safeSend(ws, { type: "subagent_update", tabId: nodeId, nodeId, subagent }),
      enableSubagents: false,
      onUsage: usageReporter,
    });
    const runResult = { status: "success", modified: Array.from(modifiedFiles), response: responseText };

    console.log(`WebSocket [Server] Task complete. Sending success payload...`);
    mcpDisposers.forEach((d) => d());
    safeSend(ws, {
      type: "execution_complete",
      nodeId,
      result: runResult
    });

  } catch (err: any) {
    console.error(`WebSocket [Server] execute_node failed:`, err);
    mcpDisposers.forEach((d) => d());
    sendLog(`Critical failure: ${err.message}`);
    safeSend(ws, {
      type: "execution_error",
      nodeId,
      error: err.message
    });
  } finally {
    releaseExecutionSlot();
  }
}
