/**
 * Agent Chat Capability
 *
 * Implements the "agent_chat" operation for the Agent Tab. It runs a multi-round
 * LLM tool-calling loop with read/write/list/search tools, streaming logs back to
 * the frontend, and returns the final response via "agent_chat_complete".
 */

import { WebSocket } from "ws";
import path from "path";
import { safeSend, getNextId, request, validateRpcResponse, validateReadFileRpcResponse, validateWriteFileRpcResponse } from "../services/websocket";
import { PayloadValidationError, requireString } from "../../../shared/agent-protocol";
import { createListFilesTool, createSearchCodebaseTool } from "../services/tools";
import { resolveHarness } from "../services/harness";
import { createLspTools } from "../services/lspTools";
import { createMcpTools, McpServerConfig } from "../services/mcpClient";
import { createWebSearchTool } from "../services/webSearchTool";
import { DeferredUserQuestion, SubagentUpdate, hasActiveBackgroundSubagents } from "../services/piAgentChat";
import { createRunCommandTool } from "./tools/runCommandTool";
import { FileEventPersistence, RunEventRecorder } from "../services/eventPersistence";
import { DelegatedTask, DelegationManager } from "../services/delegationManager";
import { createUsageReporter } from "../services/usageBroadcast";
import {
  AGENT_TAB_HARNESS_POLICY,
  GLOBAL_CHAT_TASK_DEPENDENCY_POLICY,
  agentDelegationPolicy,
  resolveAgentChatToolNames,
} from "./agentChatPolicy";

type AgentTool = {
  name: string;
  description: string;
  inputSchema?: any;
  execute: (args: any) => Promise<any>;
};

const activeDelegationManagers = new Map<string, { manager: DelegationManager; runId: string }>();

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`;
  return `${tokens} tok`;
}

export async function stopAgentChatDelegations(runOrTabId: string, reason?: string): Promise<boolean> {
  const active = activeDelegationManagers.get(runOrTabId);
  if (!active) return false;
  await active.manager.cancelRun(active.runId, reason);
  return true;
}

export async function agentChat(ws: WebSocket, data: any): Promise<void> {
  const { tabId, message, model, workspaceRoot, chatHistory, customProvider, skill, lspSettings, mcpServers, planOnly, vfsOnly } = data;

  try {
    requireString(tabId, "tabId");
    requireString(message, "message");
    requireString(workspaceRoot, "workspaceRoot");
  } catch (error) {
    if (!(error instanceof PayloadValidationError)) throw error;
    safeSend(ws, { type: "agent_chat_error", tabId, error: error.message });
    return;
  }

  const runId = typeof data.runId === "string" && data.runId ? data.runId : getNextId();
  const conversationId = typeof data.conversationId === "string" && data.conversationId ? data.conversationId : tabId;
  const eventRecorder = new RunEventRecorder(
    new FileEventPersistence(workspaceRoot),
    { conversationId, runId, agentId: "parent" },
  );
  const eventWrites: Promise<void>[] = [];
  const recordEvent = (type: string, payload: unknown, correlationId?: string) => {
    const write = eventRecorder.record(type, payload, correlationId).catch((error) => {
      console.error(`Run event persistence failed for ${type}:`, error);
    });
    eventWrites.push(write);
  };
  (ws as any).__activeAgentTabId = tabId;
  const socketRunIds: Set<string> = (ws as any).__activeAgentRunIds || new Set<string>();
  socketRunIds.add(tabId);
  socketRunIds.add(runId);
  (ws as any).__activeAgentRunIds = socketRunIds;
  console.log(`WebSocket [Server] agent_chat starting`, { tabId, runId, workspaceRoot, model, hasSkill: !!skill, lspEnabled: lspSettings?.enabled, mcpCount: mcpServers?.length || 0 });

  const modifiedFiles = new Set<string>();
  const mcpDisposers: Array<() => void> = [];
  let deferredQuestion: DeferredUserQuestion | undefined;
  let activityHeartbeat: NodeJS.Timeout | undefined;
  let lastActivityAt = Date.now();

  const sendLog = (logMessage: string) => {
    lastActivityAt = Date.now();
    console.log(`[Agent:${tabId}] ${logMessage}`);
    safeSend(ws, { type: "log", tabId, runId, conversationId, message: logMessage });
  };

  const sendSubagentUpdate = (subagent: SubagentUpdate) => {
    safeSend(ws, { type: "subagent_update", tabId, runId, conversationId, subagent });
    const status = subagent.status === "completed" || subagent.status === "steered"
      ? "completed"
      : subagent.status === "error"
        ? "failed"
        : subagent.status === "aborted" || subagent.status === "stopped"
          ? "cancelled"
          : "status_changed";
    recordEvent(`delegation.${status}`, subagent);
  };
  const delegationManager = new DelegationManager(3, ({ type, handle, result }) => {
    sendSubagentUpdate({
      id: handle.agentId,
      agentId: handle.agentId,
      displayName: "Investigator",
      description: handle.task.objective,
      subagentType: "read-only",
      status: handle.status === "failed" || handle.status === "timed_out"
        ? "error"
        : handle.status === "cancelled"
          ? "stopped"
          : handle.status,
      activity: type.replace("delegation.", "").replace(/_/g, " "),
      result: result?.findings,
      error: result?.error,
      turnCount: result?.metadata.turnsUsed,
      maxTurns: handle.task.maxTurns,
      toolUses: result?.metadata.toolsCalled.length,
      tokens: result?.metadata.tokensUsed !== undefined ? formatTokenCount(result.metadata.tokensUsed) : undefined,
      startedAt: handle.startedAt,
      parentAgentId: handle.parentAgentId,
      scope: handle.task.scope,
      excludedScope: handle.task.excludedScope,
      expectedOutput: handle.task.expectedOutput,
      evidenceRequired: handle.task.evidenceRequired,
      timeoutMs: handle.task.timeoutMs,
      queuePosition: handle.queuePosition,
      incorporated: handle.resultConsumed,
      updatedAt: new Date().toISOString(),
    });
  });
  activeDelegationManagers.set(tabId, { manager: delegationManager, runId });
  activeDelegationManagers.set(runId, { manager: delegationManager, runId });

  try {
    recordEvent("run.started", { tabId, model, provider: customProvider?.id, planOnly: !!planOnly, vfsOnly: !!vfsOnly });
    const readVfsTool = {
      name: "read_file",
      description: "Read a file's content from the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to read" }
        },
        required: ["path"]
      },
      execute: async ({ path: filePath }: { path: string }) => {
        console.log(`WebSocket [Server] agent_chat read_file tool: ${filePath}`);
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
        sendLog(`Reading file: ${filePath}`);
        const res = await request(ws, {
          type: "read_file",
          runId,
          payload: { path: resolvedPath },
          validateResponse: validateReadFileRpcResponse,
        });
        if (res.error) {
          const errorMsg = String(res.error).toLowerCase();
          if (errorMsg.includes("not found") || errorMsg.includes("no such file") || errorMsg.includes("exist")) {
            return planOnly
              ? "[File does not exist.]"
              : "[File does not exist yet. You can create it by calling write_file with content.]";
          }
          throw new Error(String(res.error));
        }
        return res.content;
      }
    };

    const writeVfsTool = {
      name: "write_file",
      description: "Write or edit a file's content in the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to write/edit" },
          content: { type: "string", description: "The full content of the file" }
        },
        required: ["path", "content"]
      },
      execute: async ({ path: filePath, content }: { path: string; content: string }) => {
        console.log(`WebSocket [Server] agent_chat write_file tool: ${filePath} (${content.length} chars)`);
        sendLog(`Modifying file: ${filePath}`);
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
        modifiedFiles.add(resolvedPath);
        const res = await request(ws, {
          type: "write_file",
          runId,
          payload: { path: resolvedPath, content },
          validateResponse: validateWriteFileRpcResponse,
        });
        if (res.error) throw new Error(String(res.error));
        return `File successfully written to: ${resolvedPath}`;
      }
    };

    const writePlanTool = {
      name: "write_plan",
      description: "Save a Markdown plan in the plans folder at the project root. Use this only when the user explicitly asks to save, write, or store the plan as a file.",
      inputSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "A Markdown filename such as authentication-refactor.md. Do not include a directory."
          },
          content: { type: "string", description: "The complete Markdown plan" }
        },
        required: ["filename", "content"]
      },
      execute: async ({ filename, content }: { filename: string; content: string }) => {
        const normalizedFilename = filename.endsWith(".md") ? filename : `${filename}.md`;
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.md$/.test(normalizedFilename)) {
          throw new Error("Plan filename must use only letters, numbers, hyphens, or underscores and end in .md.");
        }
        sendLog(`Saving plan: plans/${normalizedFilename}`);
        const res = await request(ws, {
          type: "write_plan",
          runId,
          payload: { filename: normalizedFilename, content },
          validateResponse: validateRpcResponse,
        });
        if (res.error) throw new Error(String(res.error));
        return `Plan saved to: ${res.path || path.join(workspaceRoot, "plans", normalizedFilename)}`;
      }
    };

    const lspTools = createLspTools(workspaceRoot, lspSettings, sendLog);
    const progressTool = {
      name: "report_progress",
      description: "Publish a concise, user-visible reasoning summary and the next intended action to the Agent Activity panel.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Brief evidence-based summary of what you know and why the next step is useful." },
          nextAction: { type: "string", description: "The next action you intend to take." }
        },
        required: ["summary", "nextAction"]
      },
      execute: async ({ summary, nextAction }: { summary: string; nextAction: string }) => {
        sendLog(`Reasoning summary: ${summary}\nNext: ${nextAction}`);
        return "Progress update shown to the user.";
      }
    };

    const requestUserQuestion = async (questionRequest: DeferredUserQuestion) => {
      sendLog(`Awaiting user input: ${questionRequest.question}`);
      recordEvent("agent.question_asked", questionRequest);
      const response = await request(ws, {
        type: "agent_question",
        runId,
        payload: { tabId, runId, conversationId, ...questionRequest },
        timeoutMs: 10 * 60_000,
        validateResponse: validateRpcResponse,
      });
      if (response.error) {
        const error = String(response.error);
        sendLog(`User question was not answered: ${error}`);
        throw new Error(error);
      }
      const answer = String(response.answer || "").trim();
      recordEvent("agent.question_answered", { answer }, String(response.requestId || ""));
      sendLog(`User answered: ${answer || "(no answer)"}`);
      return answer || "The user did not provide an answer.";
    };

    const askUserQuestionTool = {
      name: "ask_user_question",
      description: "Ask the user a focused question when a product or implementation choice blocks progress. Offer 2-4 concrete suggestions whenever possible.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The concise question to show the user." },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short selectable answer." },
                description: { type: "string", description: "Optional trade-off or explanation." }
              },
              required: ["label"]
            },
            description: "Optional 2-4 suggested answers."
          }
        },
        required: ["question"]
      },
      execute: async ({ question, options = [] }: { question: string; options?: Array<{ label: string; description?: string }> }) => {
        const normalizedQuestion: DeferredUserQuestion = {
          question,
          options: Array.isArray(options) ? options.filter((option) => option?.label?.trim()).slice(0, 4) : [],
        };
        if (hasActiveBackgroundSubagents(tabId)) {
          deferredQuestion = normalizedQuestion;
          sendLog("Deferred user question until delegated results are aggregated.");
          return "Question deferred. Continue waiting for all subagent results; it will be shown after aggregation.";
        }
        return requestUserQuestion(normalizedQuestion);
      }
    };

    const listFilesTool = createListFilesTool(workspaceRoot);
    const searchCodebaseTool = createSearchCodebaseTool(workspaceRoot);
    const webSearchTool = createWebSearchTool(sendLog);
    const allTools: AgentTool[] = [
      readVfsTool,
      writeVfsTool,
      writePlanTool,
      listFilesTool,
      searchCodebaseTool,
      webSearchTool,
      createRunCommandTool({ ws, sessionId: tabId, workspaceRoot, sendLog }),
      ...lspTools
    ];

    const requestedToolNames = skill?.enabledTools || [
      "read_file",
      "write_file",
      "list_files",
      "search_codebase",
      "web_search",
      "run_command",
      ...(lspSettings?.enabled ? ["lsp_get_definition", "lsp_get_references", "lsp_get_diagnostics"] : [])
    ];
    const enabledToolNames = resolveAgentChatToolNames(requestedToolNames, { planOnly, vfsOnly });
    const tools: AgentTool[] = allTools.filter((t) => enabledToolNames.includes(t.name));
    // Observability is always available, including when a restrictive skill is selected.
    tools.push(progressTool);
    tools.push(askUserQuestionTool);

    const harness = resolveHarness(customProvider);
    // Native Pi delegation ('Agent' tool) is unavailable for managed-runtime
    // providers (Copilot/Codex/Claude), so those get the harness-owned
    // delegate_task tool instead. This mirrors the resolved harness identity
    // rather than re-deriving the same transport/id check locally.
    const providerUsesManagedRuntime = harness.id !== "pi";
    const modelReference = model || customProvider?.models?.find((item: any) => item.supported !== false)?.id || "";
    if (!modelReference) throw new Error("No model is selected. Configure a provider and model in LLM Setup.");
    const usageReporter = createUsageReporter(ws, {
      workspaceRoot,
      surface: "agent_chat",
      runId,
      tabId,
      model: modelReference,
      provider: customProvider?.id,
    });

    if (!vfsOnly && providerUsesManagedRuntime) {
      const delegateTaskTool: AgentTool = {
        name: "delegate_task",
        description: "Delegate one structured, bounded, read-only investigation or review. The harness owns concurrency, queuing, timeout, identity, cancellation, and result collection.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string", description: "A short 3-8 word label for the delegated task." },
            prompt: { type: "string", description: "A precise read-only investigation with a concrete findings deliverable." },
            scope: { type: "array", items: { type: "string" }, description: "Workspace paths or concerns the subagent may inspect." },
            excludedScope: { type: "array", items: { type: "string" }, description: "Paths or concerns the subagent must not inspect." },
            expectedOutput: { type: "string", enum: ["findings", "review", "recommendation"] },
            evidenceRequired: { type: "boolean" },
            maxTurns: { type: "integer", minimum: 1 },
            timeoutMs: { type: "integer", minimum: 1000, maximum: 1200000 },
            benefit: { type: "string", enum: ["coverage", "parallelism", "independent_review", "specialization"] },
          },
          required: ["description", "prompt"],
        },
        execute: async (args: {
          description: string;
          prompt: string;
          scope?: string[];
          excludedScope?: string[];
          expectedOutput?: DelegatedTask["expectedOutput"];
          evidenceRequired?: boolean;
          maxTurns?: number;
          timeoutMs?: number;
          benefit?: DelegatedTask["benefit"];
        }) => {
          const { description, prompt } = args;
          const normalizedDescription = String(description || "Codebase investigation").trim().slice(0, 120);
          const normalizedPrompt = String(prompt || "").trim();
          if (!normalizedPrompt) throw new Error("A delegated task requires a concrete prompt.");
          sendLog(`Delegated subagent: ${normalizedDescription}.`);
          const task: DelegatedTask = {
            objective: normalizedDescription,
            scope: Array.isArray(args.scope) && args.scope.length > 0 ? args.scope.map(String) : [workspaceRoot],
            excludedScope: Array.isArray(args.excludedScope) ? args.excludedScope.map(String) : undefined,
            expectedOutput: args.expectedOutput || "findings",
            evidenceRequired: args.evidenceRequired ?? true,
            // Undefined (the default) means unbounded — the subagent runs until it
            // finishes or hits timeoutMs, rather than being cut off at a fixed turn count.
            maxTurns: args.maxTurns !== undefined ? Math.max(1, Number(args.maxTurns)) : undefined,
            // Default and cap both raised from 120s/600s: reasoning-heavy
            // providers (notably Codex) routinely still had turns in flight
            // at the old defaults, especially under concurrent delegation.
            timeoutMs: Math.max(1_000, Math.min(1_200_000, Number(args.timeoutMs) || 240_000)),
            benefit: args.benefit || "coverage",
          };
          const handle = await delegationManager.spawn(runId, "parent", task, {
            execute: async (delegatedTask, context) => {
              let turnsUsed = 0;
              let tokensUsed = 0;
              const wrapTool = (tool: AgentTool): AgentTool => ({
                ...tool,
                execute: async (toolArgs: any) => {
                  context.reportTool(tool.name);
                  return tool.execute(toolArgs);
                },
              });
              const findings = await harness.runToolLoop({
                modelReference,
                customProvider,
                onUsage: (sample) => {
                  tokensUsed += sample.totalTokens || (sample.input || 0) + (sample.output || 0);
                  usageReporter(sample);
                },
                systemPrompt: `You are a read-only Rusty subagent. Investigate only the assigned task using the provided harness tools.
- Do not create, edit, move, or delete files.
- Do not run commands and do not delegate further.
- Return a concise findings memo with relevant file paths, concrete evidence, risks, and a clear recommendation for the parent agent.
- Stop as soon as the requested evidence is sufficient.
- Scope: ${delegatedTask.scope.join(", ")}.
${delegatedTask.excludedScope?.length ? `- Excluded scope: ${delegatedTask.excludedScope.join(", ")}.` : ""}`,
                userMessage: normalizedPrompt,
                tools: [readVfsTool, listFilesTool, searchCodebaseTool].map(wrapTool),
                sendLog: () => { turnsUsed++; },
                sendToken: () => undefined,
                maxRounds: delegatedTask.maxTurns,
                cwd: workspaceRoot,
                shouldAbort: () => context.signal.aborted || ws.readyState !== WebSocket.OPEN,
              });
              return { findings, turnsUsed, tokensUsed };
            },
          });
          const result = await delegationManager.join(handle.agentId);
          if (result.status !== "completed") throw new Error(result.error || `Delegation ${result.status}.`);
          sendLog(`Subagent completed: ${normalizedDescription}.`);
          return result.findings;
        },
      };
      tools.push(delegateTaskTool);
    }

    // Connect to MCP servers and register their tools
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

    const toolDescriptions: Record<string, string> = {
      read_file: "- 'read_file': Read any file in the workspace (input: {\"path\": \"file/path\"}).",
      write_file: "- 'write_file': Write or edit a file (input: {\"path\": \"file/path\", \"content\": \"full content\"}).",
      write_plan: "- 'write_plan': Save a Markdown plan under the project-root plans folder (input: {\"filename\": \"descriptive-name.md\", \"content\": \"complete plan\"}).",
      list_files: "- 'list_files': List all files in the workspace (no input needed).",
      search_codebase: "- 'search_codebase': Search for text patterns across the codebase (input: {\"pattern\": \"search text\"}).",
      web_search: "- 'web_search': Search the public web for current information and cited sources (input: {\"query\": \"search query\"}).",
      run_command: "- 'run_command': Last-resort execution for an essential build, test, typecheck, lint, generator, or explicitly requested executable. Never use it for file inspection, search, or modification (input: {\"program\": \"npm\", \"args\": [\"test\"], \"cwd\": \".\"}).",
      ask_user_question: "- 'ask_user_question': Pause for a focused user decision, optionally with selectable suggestions.",
      lsp_get_definition: "- 'lsp_get_definition': Find definition of a symbol (input: {\"path\": \"file/path\", \"line\": lineNum, \"character\": colNum}).",
      lsp_get_references: "- 'lsp_get_references': Find all references of a symbol (input: {\"path\": \"file/path\", \"line\": lineNum, \"character\": colNum}).",
      lsp_get_diagnostics: "- 'lsp_get_diagnostics': Get compile errors/warnings for a file (input: {\"path\": \"file/path\"})."
    };
    const toolListText = [
      ...enabledToolNames.map((name: string) => toolDescriptions[name] || `- '${name}'`),
      "- 'report_progress': Publish a concise reasoning summary and the next intended action.",
      toolDescriptions.ask_user_question,
      ...(!vfsOnly && providerUsesManagedRuntime
        ? ["- 'delegate_task': Delegate a bounded read-only investigation or review to an independent subagent; multiple calls in one turn run concurrently."]
        : []),
    ].join("\n");

    const defaultSystemPrompt = `You are an AI coding agent operating inside the Rusty spatial development canvas.
You help the user analyze, modify, and implement code in their workspace.

Workspace root: ${workspaceRoot || "unknown"}


You have access to tools:
${toolListText}

Guidelines:
- Use 'read_file' to read a file before editing it.
- Use 'write_file' to write the updated content back.
- Be concise and focused. Only modify what is requested.
- Output clean code without placeholder comments.
- Once done, summarize the changes you made.
- When a material product, UX, or architecture decision cannot be inferred safely, call 'ask_user_question' instead of guessing. Keep questions focused and offer concrete options with their trade-offs.
${mcpToolLines.length > 0 ? `\nMCP integration tools (external data sources):\n${mcpToolLines.join("\n")}\n` : ""}
`;

    const planningPolicy = planOnly ? `

Global Chat planning policy (this overrides any conflicting skill instruction):
- Work only on planning, analysis, requirements, architecture, risks, and recommendations. Never implement code or modify project source files.
- The VFS is read-only for this session. Never attempt to call 'write_file', and never use commands to create or modify files.
- Always present requested plans in the chat. A request to create, draft, generate, or prepare a plan means to answer with the plan in chat; it does NOT authorize creating a file.
- Never generate, create, or persist any file unless the user explicitly asks you to save, write, or store that file on disk.
- The only permitted filesystem change is saving a Markdown planning document with 'write_plan'. It stores the document in the 'plans' folder at the project root (${path.join(workspaceRoot, "plans")}).
- Call 'write_plan' only after an explicit user request to save, write, or store the plan as a file. Even then, also show the plan in chat.
- Any persisted plan MUST use 'write_plan' with a descriptive Markdown filename. Never store a plan in the VFS or anywhere outside the project-root 'plans' folder.
${GLOBAL_CHAT_TASK_DEPENDENCY_POLICY}
` : "";

    const taskNodePolicy = vfsOnly ? `

TaskNode VFS policy (this overrides any conflicting skill instruction):
- Follow the user-selected skill while staying inside the TaskNode's virtual workspace.
- You may read workspace files, but every file creation or modification MUST use 'write_file'. That tool writes only to this TaskNode's VFS for later review and reconciliation; it does not modify the physical workspace.
- Continue iterating on the current VFS versions of files when the user requests refinements.
- Physical command execution is unavailable. Do not attempt shell commands or ask another agent to bypass this boundary.
` : "";

    const agentTabHarnessPolicy = !planOnly && !vfsOnly
      ? AGENT_TAB_HARNESS_POLICY
      : "";

    const skillGuidance = skill?.systemPrompt
      ? `\n\nActive skill guidance (adds to, does not replace, the defaults above):\n${skill.systemPrompt}`
      : "";

    const systemPrompt = `${defaultSystemPrompt}${skillGuidance}${planningPolicy}${taskNodePolicy}${agentTabHarnessPolicy}

User-visible reasoning updates:
- Before the first substantive action, call 'report_progress' with a concise summary of your approach and the next action.
- Call it again whenever the evidence changes your plan or before a distinct new phase.
- Base updates on concrete context and tool results. Do not reveal private chain-of-thought or hidden reasoning; keep each update to 1-3 clear sentences.

Delegation:
${vfsOnly
  ? "- TaskNodes work directly and cannot delegate to other agents."
  : agentDelegationPolicy(providerUsesManagedRuntime ? "delegate_task" : "Agent")}

Questions:
- When a material product, UX, or architecture decision cannot be inferred safely, call 'ask_user_question' instead of guessing. Keep questions focused and offer concrete options with their trade-offs.`;

    sendLog("Initializing agent...");
    activityHeartbeat = setInterval(() => {
      if (Date.now() - lastActivityAt < 12_000) return;
      sendLog("Model is still working; awaiting its next visible action.");
    }, 4_000);
    activityHeartbeat.unref?.();

    const sendToken = (token: string) => {
      lastActivityAt = Date.now();
      safeSend(ws, { type: "token", tabId, runId, conversationId, content: token });
    };

    const responseText = await harness.runAgentic({
      tabId,
      model: modelReference,
      workspaceRoot,
      systemPrompt,
      conversationHistory: chatHistory || [],
      message,
      tools,
      customProvider,
      sendLog,
      sendToken,
      sendSubagentUpdate,
      enableSubagents: !vfsOnly,
      consumeDeferredQuestion: () => {
        const question = deferredQuestion;
        deferredQuestion = undefined;
        return question;
      },
      requestUserQuestion,
      onUsage: usageReporter,
    });

    sendLog("Agent complete.");

    // Small delay to ensure message is sent before closing
    await new Promise(resolve => setTimeout(resolve, 50));

    safeSend(ws, {
      type: "agent_chat_complete",
      tabId,
      runId,
      conversationId,
      response: responseText,
      modifiedFiles: Array.from(modifiedFiles)
    });
    recordEvent("run.completed", { response: responseText, modifiedFiles: Array.from(modifiedFiles) });

    // Ensure the message is sent before returning
    await new Promise(resolve => setTimeout(resolve, 100));
  } catch (err: any) {
    console.error("WebSocket [Server] agent_chat error:", err);
    sendLog(`Agent error: ${err.message}`);
    safeSend(ws, {
      type: "agent_chat_error",
      tabId,
      runId,
      conversationId,
      error: err.message
    });
    recordEvent("run.failed", { error: err.message });
  } finally {
    await delegationManager.cancelRun(runId, "Parent run finished.");
    activeDelegationManagers.delete(tabId);
    activeDelegationManagers.delete(runId);
    socketRunIds.delete(tabId);
    socketRunIds.delete(runId);
    if (activityHeartbeat) clearInterval(activityHeartbeat);
    // Clean up MCP server connections
    for (const dispose of mcpDisposers) {
      try {
        dispose();
      } catch (err) {
        console.error("Error disposing MCP connection:", err);
      }
    }
    await Promise.allSettled(eventWrites);
  }
}
