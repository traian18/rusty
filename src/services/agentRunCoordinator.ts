/**
 * Owns canvas/task node execution runs (REFACTOR_PLAN.md PR 7 commit 1),
 * extracted out of Workspace.tsx's own `executeNode`/`stopExecution`/
 * `socketsRef`. A module-level singleton, not a React hook or component --
 * this is the ARCHITECTURE.md-documented violation ("components own agent
 * WebSockets directly... instead of going through a shared client")
 * finally resolved for canvas/task execution specifically. Workspace.tsx
 * never actually unmounts in practice (App -> AppShell -> MainWorkspace ->
 * Workspace, all unconditional), so this was not a live functional bug --
 * it's a cleanliness fix, moving run ownership into the same layer as
 * every other service in this codebase, not out of a component that
 * happened to never unmount.
 *
 * Everything here reads store state via `useWorkspaceStore.getState()`
 * rather than component-scope hooks -- the original `executeNode` already
 * did this for almost everything (`rootPath`/`globalContextSummary` were
 * the only two component-hook reads left; both now come from the same
 * `getState()` snapshot every other read in this function already uses).
 */

import { useWorkspaceStore } from "../store";
import { resolveSkill, toSkillData, BUILT_IN_SKILL_IDS } from "../config/skillDefinitions";
import { VfsRegistry, setExecutingNode } from "../services/vfs";
import { notify } from "../notificationStore";
import { scheduleTreeRefresh } from "../components/filetree/FileTreePresenter";
import { nodeExecutionService, NodeExecutionRun } from "./nodeExecutionService";
import { SIDECAR_PORT } from "../config/sidecar";
import { appendBoundedText } from "./boundedTextBuffer";
import { invoke } from "@tauri-apps/api/core";
import { resolveExecutionProvider } from "../store/resolveExecutionProvider";

const runs = new Map<string, NodeExecutionRun>();

export async function executeNode(nodeId: string, customPrompt?: string): Promise<void> {
  const storeState = useWorkspaceStore.getState();
  const { addLog, clearLogs, setNodeStatus } = storeState;

  // Find the canvas context containing this node
  let targetTabId = "";
  let node: any = null;
  if (storeState.canvasContexts) {
    for (const tId in storeState.canvasContexts) {
      const ctx = storeState.canvasContexts[tId];
      const found = ctx.nodes.find((n) => n.id === nodeId);
      if (found) {
        targetTabId = tId;
        node = found;
        break;
      }
    }
  }

  // Fallback to top-level if not found
  if (!node) {
    node = storeState.nodes.find((n) => n.id === nodeId);
  }

  if (!node || node.type !== "taskNode") return;

  const activeModel = storeState.activeModel;
  const customProviders = storeState.customProviders;
  const activeCustomProviderId = storeState.activeCustomProviderId;
  const nodeModel = (node.data as any).model || activeModel;
  const rootPath = storeState.rootPath;
  const globalContextSummary = storeState.globalContextSummary;

  // Resolved -- and, since REFACTOR_PLAN.md PR 3c, gated -- before any VFS
  // prep or socket work: a blocked execution should touch nothing.
  // Previously hand-rolled a `nodeModel.split("/")[0]` provider lookup
  // here (the one execution site that never adopted
  // providerHasModelReference); resolveExecutionProvider replaces it and
  // adds the check every other execution site already needed.
  const resolution = resolveExecutionProvider(
    customProviders,
    storeState.providerStatus,
    activeCustomProviderId,
    nodeModel,
  );
  if (!resolution.ok) {
    notify("Cannot run this node", resolution.message, "error");
    setNodeStatus(nodeId, "error");
    return;
  }
  const provider = resolution.provider;

  // Prepare the VFS for this node's execution (query current files, then clear them)
  const vfs = VfsRegistry.getOrCreate(targetTabId);
  let initialNodeFiles: string[] = [];
  try {
    initialNodeFiles = await vfs.prepareForExecution(nodeId);
    storeState.updateTaskNode(nodeId, {
      modifiedFiles: [],
      originalFileContents: {},
      generatedFileContents: {},
    });
  } catch (err) {
    console.error("Failed to prepare VFS for execution:", err);
  }

  // Resolve context using targetTabId
  const tabCtx = targetTabId ? storeState.canvasContexts[targetTabId] : null;
  const currentNodes = tabCtx ? tabCtx.nodes : storeState.nodes;
  const currentEdges = tabCtx ? tabCtx.edges : storeState.edges;

  // Resolve skill — fall back to BUILD so a TaskNode is
  // never sent to the sidecar with a null skill.
  const nodeSkillId = (node.data as any).skillId;
  const selectedSkill = resolveSkill(storeState.skills, nodeSkillId || BUILT_IN_SKILL_IDS.BUILD);
  const skillData = toSkillData(selectedSkill);

  const connectedEdges = currentEdges.filter((edge) => edge.target === nodeId);
  const inputFiles = connectedEdges
    .map((edge) => currentNodes.find((n) => n.id === edge.source))
    .filter((n): n is Exclude<typeof n, undefined> => n !== undefined && n.type === "contextNode" && !!n.data.path)
    .map((n) => ({
      path: n.data.path as string,
      name: n.data.fileName as string,
      isDir: !!n.data.isDir,
    }));

  // Gather text descriptions from connected context nodes
  const contextDescriptions = connectedEdges
    .map((edge) => currentNodes.find((n) => n.id === edge.source))
    .filter((n): n is Exclude<typeof n, undefined> => n !== undefined && n.type === "contextNode")
    .map((n) => {
      const parts: string[] = [];
      if (n.data.name) parts.push(`[${n.data.name}]`);
      if (n.data.description) parts.push(n.data.description as string);
      if (n.data.path) parts.push(`File: ${n.data.path}`);
      return parts.join(" — ");
    })
    .filter((s) => s.length > 0);

  // Gather MCP context from connected MCP nodes (server config + fetch description)
  const mcpServersMap = useWorkspaceStore.getState().mcpServers;
  const mcpContext = connectedEdges
    .map((edge) => currentNodes.find((n) => n.id === edge.source))
    .filter((n): n is Exclude<typeof n, undefined> => n !== undefined && n.type === "mcpNode" && !!n.data.mcpServerName)
    .map((n) => {
      const server = mcpServersMap[n.data.mcpServerName as string];
      if (!server) return null;
      return {
        server,
        nodeId: n.id as string | undefined,
        description: (n.data.description as string) || "",
        nodeName: (n.data.name as string) || "MCP Context",
      };
    })
    .filter((c): c is Exclude<typeof c, null> => c !== null);

  // Also include MCP servers declared in the selected skill
  if (selectedSkill && Array.isArray(selectedSkill.mcpServers)) {
    for (const name of selectedSkill.mcpServers) {
      if (!mcpContext.some((c) => c.server.name === name)) {
        const server = mcpServersMap[name];
        if (server) {
          mcpContext.push({
            server,
            nodeId: undefined,
            description: "",
            nodeName: server.displayName || server.name,
          });
        }
      }
    }
  }

  // Also surface MCP fetch intents in the context descriptions sent to the LLM.
  const mcpDescriptions = mcpContext.map(
    (c) => `[MCP: ${c.server.displayName || c.server.name}] ${c.description || "Fetch relevant information from this MCP server."}`
  );

  // Gather context from upstream task nodes connected via task-out -> task-in edges.
  // These are previously-executed tasks whose generated code this task should build
  // upon. We read the actual file contents they produced from the VFS so the agent
  // sees the prior work directly instead of re-implementing from scratch.
  const upstreamNodeStatus = tabCtx?.nodeStatus || {};
  const upstreamTaskNodes = connectedEdges
    .filter((edge) => edge.sourceHandle === "task-out" && edge.targetHandle === "task-in")
    .map((edge) => currentNodes.find((n) => n.id === edge.source))
    .filter((n): n is Exclude<typeof n, undefined> => n !== undefined && n.type === "taskNode" && upstreamNodeStatus[n.id] === "success");

  const upstreamTaskContext: {
    taskId: string;
    taskName: string;
    prompt: string;
    files: { path: string; content: string }[];
  }[] = [];

  for (const tNode of upstreamTaskNodes) {
    const tData = tNode.data as any;
    const modifiedPaths: string[] = Array.isArray(tData.modifiedFiles) ? tData.modifiedFiles : [];
    const files: { path: string; content: string }[] = [];
    for (const filePath of modifiedPaths) {
      try {
        const content = await vfs.readFile(filePath);
        files.push({ path: filePath, content: content || "" });
      } catch (err: any) {
        console.warn(`[executeNode] could not read upstream file ${filePath}:`, err);
      }
    }
    upstreamTaskContext.push({
      taskId: tNode.id,
      taskName: tData.name || "AI Executor Node",
      prompt: tData.prompt || "",
      files,
    });
  }

  // A task may only see pending VFS code from directly connected upstream
  // tasks. All other reads must reflect the physical workspace. Files written
  // during this execution are added as they are created so the task can read
  // back its own pending changes.
  const connectedUpstreamVfsFiles = new Map(
    upstreamTaskContext.flatMap((task) =>
      task.files.map((file) => [file.path, file.content] as const)
    )
  );
  const currentExecutionVfsFiles = new Map<string, string>();
  const currentExecutionOriginalFiles = new Map<string, string>();

  console.log("WebSocket [executeNode] starting task execution", { nodeId, inputFiles, mcpContext: mcpContext.length, upstreamTasks: upstreamTaskContext.length });

  clearLogs(nodeId);
  setNodeStatus(nodeId, "running");

  // Set connected MCP nodes status to running
  mcpContext.forEach((ctx) => {
    if (ctx.nodeId) {
      setNodeStatus(ctx.nodeId, "running");
    }
  });

  addLog(nodeId, `Connecting to local agent sidecar...`);
  addLog(
    nodeId,
    `Detected ${inputFiles.length} connected context file(s): ${
      inputFiles.map((f) => f.name).join(", ") || "none"
    }`
  );
  if (upstreamTaskContext.length > 0) {
    const totalFiles = upstreamTaskContext.reduce((sum, t) => sum + t.files.length, 0);
    addLog(
      nodeId,
      `Inheriting context from ${upstreamTaskContext.length} upstream task(s): ${
        upstreamTaskContext.map((t) => t.taskName).join(", ")
      } (${totalFiles} generated file(s))`
    );
  }

  // Setup chat messages for prompt chat
  const store = useWorkspaceStore.getState();
  let currentInstructions = node.data.prompt || "";
  let chatHistoryToSend: any[] = [];

  if (customPrompt) {
    // Refinement message from Prompt Chat
    const userMsg = {
      id: `msg_${Date.now()}`,
      role: "user" as const,
      content: customPrompt,
      timestamp: new Date().toLocaleTimeString()
    };
    store.addGlobalChatMessage(nodeId, userMsg);
    chatHistoryToSend = store.getGlobalChatHistory(nodeId)
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.content }));
    currentInstructions = `${customPrompt}\n\nIMPORTANT: The workspace files for this task have been cleared/reset. Please redo the entire implementation from scratch based on the full conversation history and this new request, writing all necessary files as complete new files in the VFS.`;
  } else {
    // Initial "Run Executor" procedure call
    store.clearGlobalChatHistory(nodeId);

    let formattedPrompt = "";
    if (globalContextSummary) {
      formattedPrompt += `<general context>\n${globalContextSummary}\n</general context>\n`;
    }
    formattedPrompt += `<TaskNodeContent>\n${node.data.prompt || ""}\n</TaskNodeContent>\n`;
    if (contextDescriptions.length > 0 || mcpDescriptions.length > 0) {
      formattedPrompt += `<Context>\n${[...contextDescriptions, ...mcpDescriptions].join("\n")}\n</Context>`;
    }
    if (upstreamTaskContext.length > 0) {
      const upstreamBlocks = upstreamTaskContext.map((t) => {
        const fileSections = t.files
          .map((f) => `  [File: ${f.path}]\n${f.content}`)
          .join("\n\n");
        return `[Upstream Task: ${t.taskName}]\nInstructions: ${t.prompt || "(none)"}\nGenerated code:\n${fileSections || "(no files captured)"}`;
      });
      formattedPrompt += `<UpstreamTasks>\nThe following tasks ran before this one and produced code that this task should build upon.\n${upstreamBlocks.join("\n\n")}\n</UpstreamTasks>\n`;
    }

    const userMsg = {
      id: `msg_${Date.now()}`,
      role: "user" as const,
      content: formattedPrompt,
      timestamp: new Date().toLocaleTimeString()
    };
    store.addGlobalChatMessage(nodeId, userMsg);
    chatHistoryToSend = [{ role: "user", content: formattedPrompt }];
    currentInstructions = formattedPrompt;
  }

  const consoleMessageId = `console_${nodeId}_${Date.now()}`;
  window.dispatchEvent(new CustomEvent("rusty-subagents-reset", { detail: { nodeId } }));
  store.addGlobalChatMessage(nodeId, {
    id: consoleMessageId,
    role: "console",
    content: "",
    timestamp: new Date().toLocaleTimeString(),
  });
  let consoleBuffer = "";
  let consoleFlushTimeout: ReturnType<typeof setTimeout> | null = null;
  const flushConsole = () => {
    if (consoleFlushTimeout) return;
    consoleFlushTimeout = setTimeout(() => {
      consoleFlushTimeout = null;
      useWorkspaceStore.getState().updateGlobalChatMessage(nodeId, consoleMessageId, consoleBuffer);
    }, 150);
  };

  const finishRun = () => {
    runs.delete(nodeId);
    if (runs.size === 0) {
      setExecutingNode(null).catch(err => {
        console.error(`[agentRunCoordinator] Failed to clear current executing node:`, err);
      });
    }
  };

  let connectedToSidecar = false;
  const run = nodeExecutionService.execute(
    {
      nodeId,
      instructions: currentInstructions,
      model: nodeModel,
      workspaceRoot: rootPath,
      inputFiles,
      globalContext: globalContextSummary || "",
      contextDescriptions,
      mcpContext,
      upstreamTaskContext,
      chatHistory: chatHistoryToSend,
      customProvider: provider,
      skill: skillData,
      lspSettings: { ...useWorkspaceStore.getState().lspSettings, enabled: false },
    },
    {
      onConnected: () => {
        connectedToSidecar = true;
        addLog(nodeId, "Connection established. Dispatching task execution details...");
        setExecutingNode(nodeId).catch(err => {
          console.error(`[agentRunCoordinator] Failed to set current executing node:`, err);
        });
      },
      onCommandOutput: (content) => {
        consoleBuffer = appendBoundedText(consoleBuffer, content);
        flushConsole();
      },
      onCommandComplete: () => {
        scheduleTreeRefresh();
      },
      onNodeStatusChange: (targetNodeId, status, message, nodeName) => {
        setNodeStatus(targetNodeId, status as any);
        if (status === "error" && message) {
          addLog(nodeId, `MCP error [${nodeName || "Node"}]: ${message}`);
        }
      },
      onLog: (message) => {
        addLog(nodeId, message);
        consoleBuffer = appendBoundedText(consoleBuffer, `${message}\n`);
        flushConsole();
      },
      onToken: (content) => {
        consoleBuffer = appendBoundedText(consoleBuffer, content);
        flushConsole();
      },
      onSubagentUpdate: (subagent) => {
        if (!subagent) return;
        window.dispatchEvent(new CustomEvent("rusty-subagent-update", { detail: { nodeId, subagent } }));
      },
      onUsage: (usage) => {
        window.dispatchEvent(new CustomEvent("rusty-node-usage", { detail: { nodeId, usage } }));
      },
      onReadFile: async (path) => {
        console.log(`[nodeExecutionService] read_file intercept for: ${path}`);
        if (currentExecutionVfsFiles.has(path)) return currentExecutionVfsFiles.get(path)!;
        if (connectedUpstreamVfsFiles.has(path)) return connectedUpstreamVfsFiles.get(path)!;
        return invoke<string>("read_file_disk", { path });
      },
      onWriteFile: async (path, content) => {
        console.log(`[nodeExecutionService] write_file intercept for: ${path}`);
        if (!currentExecutionOriginalFiles.has(path)) {
          // Use the upstream task's VFS state as the baseline so the diff
          // shows only what THIS task changed, not inherited upstream changes.
          if (connectedUpstreamVfsFiles.has(path)) {
            currentExecutionOriginalFiles.set(path, connectedUpstreamVfsFiles.get(path)!);
          } else {
            try {
              const original = await invoke<string>("read_file_disk", { path });
              currentExecutionOriginalFiles.set(path, original);
            } catch {
              currentExecutionOriginalFiles.set(path, "");
            }
          }
        }
        await vfs.writeFile(path, content, nodeId);
        currentExecutionVfsFiles.set(path, content);
      },
      onComplete: ({ modified, response: responseText }) => {
        console.log("[nodeExecutionService] execution_complete modified files:", modified);
        addLog(
          nodeId,
          `AI task execution successfully completed. Modified: ${modified.join(", ") || "none"}`
        );

        const assistantMsg = {
          id: `msg_${Date.now()}`,
          role: "assistant" as const,
          content: responseText,
          timestamp: new Date().toLocaleTimeString()
        };
        store.addGlobalChatMessage(nodeId, assistantMsg);
        if (consoleFlushTimeout) clearTimeout(consoleFlushTimeout);
        useWorkspaceStore.getState().updateGlobalChatMessage(nodeId, consoleMessageId, "");

        const uniqueModified: string[] = Array.from(new Set(modified));
        const originalFileContents = Object.fromEntries(
          uniqueModified.map((filePath) => [filePath, currentExecutionOriginalFiles.get(filePath) || ""])
        );
        const generatedFileContents = Object.fromEntries(
          uniqueModified
            .filter((filePath) => currentExecutionVfsFiles.has(filePath))
            .map((filePath) => [filePath, currentExecutionVfsFiles.get(filePath)!])
        );
        useWorkspaceStore.getState().updateTaskNode(nodeId, {
          modifiedFiles: uniqueModified,
          originalFileContents,
          generatedFileContents,
        });
        setNodeStatus(nodeId, "success");
        finishRun();

        const cleanUpVfsAndTracker = async () => {
          try {
            await vfs.finalizeExecution(nodeId, uniqueModified, initialNodeFiles);
          } catch (err) {
            console.error("Failed to finalize VFS after execution:", err);
          }
          if (targetTabId) {
            try {
              const { canvasFileService } = await import("../components/tabs/canvas/services/canvasFileService");
              await canvasFileService.autoSaveCanvas(targetTabId);
            } catch (err) {
              console.error("Failed to auto-save canvas after VFS sync:", err);
            }
          }
        };

        cleanUpVfsAndTracker();
      },
      onError: (message) => {
        if (!connectedToSidecar) {
          // startRun never resolved -- this is a connection failure, not an
          // execution error the sidecar reported (this module never had a
          // socket to construct in the first place now; agentHarnessClient
          // owns the one shared connection instead).
          console.error("[nodeExecutionService] failed to connect:", message);
          addLog(nodeId, `Fatal: Failed to connect to agent sidecar: ${message}`);
          setNodeStatus(nodeId, "error");
          finishRun();
          notify(
            "Sidecar Connection Error",
            `Could not connect to the agent sidecar: ${message}. Ensure the agent sidecar is running on port ${SIDECAR_PORT}.`,
            "error"
          );
          return;
        }

        console.error("[nodeExecutionService] execution_error:", message);
        addLog(nodeId, `AI Execution Error: ${message}`);

        const assistantMsg = {
          id: `msg_${Date.now()}`,
          role: "assistant" as const,
          content: `Execution failed: ${message}`,
          timestamp: new Date().toLocaleTimeString()
        };
        store.addGlobalChatMessage(nodeId, assistantMsg);
        if (consoleFlushTimeout) clearTimeout(consoleFlushTimeout);
        useWorkspaceStore.getState().updateGlobalChatMessage(nodeId, consoleMessageId, "");

        setNodeStatus(nodeId, "error");
        finishRun();
        notify("Execution Error", `The sidecar returned an execution error: ${message}`, "error");
      },
    }
  );
  runs.set(nodeId, run);
}

export function stopExecution(nodeId: string): void {
  console.log(`[agentRunCoordinator] Stopping execution for node: ${nodeId}`);
  const run = runs.get(nodeId);
  run?.cancel();
  runs.delete(nodeId);
  const { setNodeStatus, addLog } = useWorkspaceStore.getState();
  setNodeStatus(nodeId, "idle");
  addLog(nodeId, "Execution stopped by user.");
  if (runs.size === 0) {
    setExecutingNode(null).catch(err => {
      console.error(`[agentRunCoordinator] Failed to clear current executing node on stop:`, err);
    });
  }
}

/** True if any node in this canvas tab (by tab id) has an active run --
    used by the close-intercept controller (PR 7 commit 3) to decide
    whether closing a canvas tab needs to stop anything. */
export function hasRunningNodesInTab(tabId: string): boolean {
  const context = useWorkspaceStore.getState().canvasContexts[tabId];
  if (!context) return false;
  return Object.keys(context.nodeStatus || {}).some(
    (nodeId) => context.nodeStatus[nodeId] === "running" && runs.has(nodeId),
  );
}

/** Stops every running node in this canvas tab -- the same loop
    Workspace.tsx's close-intercept handler used to do inline. */
export function stopAllRunningNodesInTab(tabId: string): void {
  const context = useWorkspaceStore.getState().canvasContexts[tabId];
  if (!context) return;
  Object.keys(context.nodeStatus || {}).forEach((nodeId) => {
    if (context.nodeStatus[nodeId] === "running") {
      stopExecution(nodeId);
    }
  });
}

// Module-level, one-time setup: the coordinator survives for the app's
// entire session (it's imported once, like every other service singleton
// in this codebase), so a plain top-level listener -- never torn down --
// is the correct lifecycle here, not a React effect tied to whichever
// component happens to render first.
if (typeof window !== "undefined") {
  window.addEventListener("tasknode-stop-request", ((e: CustomEvent) => {
    const nodeId = e.detail?.nodeId as string | undefined;
    if (nodeId) stopExecution(nodeId);
  }) as EventListener);
}
