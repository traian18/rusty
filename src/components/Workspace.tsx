import React, { useRef, useEffect, useState } from "react";
import { useWorkspaceStore } from "../store";
import { resolveSkill, toSkillData, BUILT_IN_SKILL_IDS } from "../config/skillDefinitions";
import { VfsRegistry, setExecutingNode } from "../services/vfs";
import { notify } from "../notificationStore";
import { onCloseTabRequest } from "../tabs/closeRequests";
import { evaluateClose } from "../tabs/closeGuards";
import type { TabViewContext } from "../tabs/views";
import { TabStrip } from "./workspace/TabStrip";
import { TabOutlet } from "./workspace/TabOutlet";
import { createPortal } from "react-dom";
import { AlertTriangle, X, Save, HelpCircle } from "lucide-react";
import { canvasFileService } from "./tabs/canvas/services/canvasFileService";
import { CommandPermissionPresenter } from "./permissions/CommandPermissionPresenter";
import { commandPermissionService, handleCommandPermissionMessage } from "../services/commandPermissionService";
import { scheduleTreeRefresh } from "./filetree/FileTreePresenter";
import { createAgentHarnessSocket } from "../services/agentHarnessClient";
import { SIDECAR_PORT } from "../config/sidecar";
import { appendBoundedText } from "../services/boundedTextBuffer";
import { invoke } from "@tauri-apps/api/core";
import { resolveExecutionProvider } from "../store/resolveExecutionProvider";

export const Workspace: React.FC = () => {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const [closeIntercept, setCloseIntercept] = useState<{
    tabId: string;
    type: "unsaved" | "running";
    title: string;
  } | null>(null);
  const addLog = useWorkspaceStore((state) => state.addLog);
  const clearLogs = useWorkspaceStore((state) => state.clearLogs);
  const setNodeStatus = useWorkspaceStore((state) => state.setNodeStatus);

  const globalContextSummary = useWorkspaceStore((state) => state.globalContextSummary);

  const socketsRef = useRef<Map<string, WebSocket>>(new Map());

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const nodeId = e.detail?.nodeId as string | undefined;
      if (nodeId) {
        stopExecution(nodeId);
      }
    };
    window.addEventListener("tasknode-stop-request", handler as EventListener);
    return () => window.removeEventListener("tasknode-stop-request", handler as EventListener);
  }, []);

  // WebSocket execution runner
  const executeNode = async (nodeId: string, customPrompt?: string) => {
    const storeState = useWorkspaceStore.getState();
    
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

    let socket: WebSocket;
    try {
      socket = createAgentHarnessSocket();
      socketsRef.current.set(nodeId, socket);
    } catch (err: any) {
      console.error("Failed to construct WebSocket:", err);
      addLog(nodeId, `Fatal: Failed to construct WebSocket: ${err.message}`);
      setNodeStatus(nodeId, "error");
      notify(
        "Sidecar Connection Error",
        `Failed to create WebSocket connection to sidecar: ${err.message || String(err)}. Ensure the agent sidecar is running on port ${SIDECAR_PORT}.`,
        "error"
      );
      return;
    }

    socket.onopen = () => {
      console.log("WebSocket connection opened to sidecar");
      addLog(nodeId, "Connection established. Dispatching task execution details...");
      setExecutingNode(nodeId).catch(err => {
        console.error(`[Workspace] Failed to set current executing node:`, err);
      });

      socket.send(
        JSON.stringify({
          type: "execute_node",
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
        })
      );
    };

    socket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);

        if (handleCommandPermissionMessage(data, socket)) return;
        if (data.type === "command_output" && data.sessionId === nodeId) {
          consoleBuffer = appendBoundedText(consoleBuffer, data.content);
          flushConsole();
          return;
        }
        if (data.type === "command_complete" && data.sessionId === nodeId) {
          scheduleTreeRefresh();
          return;
        }

        if (data.type === "node_status_change") {
          setNodeStatus(data.targetNodeId, data.status);
          if (data.status === "error" && data.message) {
            addLog(nodeId, `MCP error [${data.nodeName || "Node"}]: ${data.message}`);
          }
          return;
        }

        if (data.type === "log" && data.nodeId === nodeId) {
          addLog(nodeId, data.message);
          consoleBuffer = appendBoundedText(consoleBuffer, `${data.message}\n`);
          flushConsole();
          return;
        }

        if (data.type === "token" && data.nodeId === nodeId) {
          consoleBuffer = appendBoundedText(consoleBuffer, data.content);
          flushConsole();
          return;
        }

        if (data.type === "subagent_update" && (data.nodeId === nodeId || data.tabId === nodeId) && data.subagent) {
          window.dispatchEvent(new CustomEvent("rusty-subagent-update", { detail: { nodeId, subagent: data.subagent } }));
          return;
        }

        if (data.type === "usage_update" && data.nodeId === nodeId) {
          window.dispatchEvent(new CustomEvent("rusty-node-usage", { detail: { nodeId, usage: data.usage } }));
          return;
        }

        if (data.type === "read_file") {
          try {
            console.log(`WebSocket [read_file] intercept for: ${data.path}`);
            const content: string = currentExecutionVfsFiles.has(data.path)
              ? currentExecutionVfsFiles.get(data.path)!
              : connectedUpstreamVfsFiles.has(data.path)
                ? connectedUpstreamVfsFiles.get(data.path)!
                : await invoke<string>("read_file_disk", { path: data.path });
            socket.send(
              JSON.stringify({ type: "read_file_response", requestId: data.requestId, content })
            );
          } catch (err: any) {
            console.error("WebSocket [read_file] intercept error:", err);
            socket.send(
              JSON.stringify({
                type: "read_file_response",
                requestId: data.requestId,
                error: err.message,
              })
            );
          }
          return;
        }

        if (data.type === "write_file") {
          try {
            console.log(`WebSocket [write_file] intercept for: ${data.path}`);
            if (!currentExecutionOriginalFiles.has(data.path)) {
              // Use the upstream task's VFS state as the baseline so the diff
              // shows only what THIS task changed, not inherited upstream changes.
              if (connectedUpstreamVfsFiles.has(data.path)) {
                currentExecutionOriginalFiles.set(data.path, connectedUpstreamVfsFiles.get(data.path)!);
              } else {
                try {
                  const original = await invoke<string>("read_file_disk", { path: data.path });
                  currentExecutionOriginalFiles.set(data.path, original);
                } catch {
                  currentExecutionOriginalFiles.set(data.path, "");
                }
              }
            }
            await vfs.writeFile(data.path, data.content, nodeId);
            currentExecutionVfsFiles.set(data.path, data.content);
            socket.send(JSON.stringify({ type: "write_file_response", requestId: data.requestId }));
          } catch (err: any) {
            console.error("WebSocket [write_file] intercept error:", err);
            socket.send(
              JSON.stringify({
                type: "write_file_response",
                requestId: data.requestId,
                error: err.message,
              })
            );
          }
          return;
        }

        if (data.type === "execution_complete" && data.nodeId === nodeId) {
          const modified = data.result?.modified || [];
          const responseText = data.result?.response || "Task completed successfully.";
          console.log("WebSocket [execution_complete] modified files:", modified);
          addLog(
            nodeId,
            `AI task execution successfully completed. Modified: ${modified.join(", ") || "none"}`
          );

          // Add assistant message to history
          const assistantMsg = {
            id: `msg_${Date.now()}`,
            role: "assistant" as const,
            content: responseText,
            timestamp: new Date().toLocaleTimeString()
          };
          store.addGlobalChatMessage(nodeId, assistantMsg);
          if (consoleFlushTimeout) clearTimeout(consoleFlushTimeout);
          useWorkspaceStore.getState().updateGlobalChatMessage(nodeId, consoleMessageId, "");

          const uniqueModified: string[] = Array.from(new Set(modified)) as string[];
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
          socket.close();

          const cleanUpVfsAndTracker = async () => {
            // Finalize VFS: overwrite tracker and remove stale files
            try {
              await vfs.finalizeExecution(nodeId, uniqueModified, initialNodeFiles);
            } catch (err) {
              console.error("Failed to finalize VFS after execution:", err);
            }

            // Auto-save the canvas tab to reflect changes
            if (targetTabId) {
              try {
                const { canvasFileService } = await import("./tabs/canvas/services/canvasFileService");
                await canvasFileService.autoSaveCanvas(targetTabId);
              } catch (err) {
                console.error("Failed to auto-save canvas after VFS sync:", err);
              }
            }
          };

          cleanUpVfsAndTracker();
        }

        if (data.type === "execution_error" && data.nodeId === nodeId) {
          console.error("WebSocket [execution_error]:", data.error);
          addLog(nodeId, `AI Execution Error: ${data.error}`);

          // Add assistant error message to history
          const assistantMsg = {
            id: `msg_${Date.now()}`,
            role: "assistant" as const,
            content: `Execution failed: ${data.error}`,
            timestamp: new Date().toLocaleTimeString()
          };
          store.addGlobalChatMessage(nodeId, assistantMsg);
          if (consoleFlushTimeout) clearTimeout(consoleFlushTimeout);
          useWorkspaceStore.getState().updateGlobalChatMessage(nodeId, consoleMessageId, "");

          setNodeStatus(nodeId, "error");
          socket.close();
          notify("Execution Error", `The sidecar returned an execution error: ${data.error}`, "error");
        }
      } catch (err: any) {
        console.error("WebSocket onmessage processing error:", err);
        addLog(
          nodeId,
          `Client Error: failed to parse/execute sidecar message: ${err.message}`
        );
        notify(
          "Sidecar Communication Error",
          `Error processing message from sidecar: ${err.message || String(err)}`,
          "error"
        );
      }
    };

    socket.onerror = (err) => {
      console.error("Sidecar connection failed:", err);
      addLog(
        nodeId,
        `Fatal: Agent sidecar connection closed unexpectedly. Ensure Express server is running on port ${SIDECAR_PORT}.`
      );
      setNodeStatus(nodeId, "error");
      notify(
        "Sidecar Connection Failed",
        `Connection to agent sidecar closed unexpectedly. Ensure Express server is running on port ${SIDECAR_PORT}.`,
        "error"
      );
    };

    socket.onclose = (event) => {
      commandPermissionService.removeForSocket(socket);
      console.log(`[Workspace] WebSocket closed (code: ${event.code}, reason: "${event.reason}", clean: ${event.wasClean})`);
      addLog(nodeId, `WebSocket connection closed (code: ${event.code}, reason: "${event.reason || "none"}", clean: ${event.wasClean})`);
      socketsRef.current.delete(nodeId);
      const currentStatus = useWorkspaceStore.getState().nodeStatus[nodeId];
      if (currentStatus === "running") {
        setNodeStatus(nodeId, "error");
        notify(
          "Connection Lost",
          `The sidecar connection was closed abnormally (code: ${event.code}). Please retry the execution.`,
          "error"
        );
      }
      if (socketsRef.current.size === 0) {
        setExecutingNode(null).catch(err => {
          console.error(`[Workspace] Failed to clear current executing node:`, err);
        });
      }
    };
  };

  const stopExecution = (nodeId: string) => {
    console.log(`[Workspace] Stopping execution for node: ${nodeId}`);
    const socket = socketsRef.current.get(nodeId);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "agent_chat_stop", tabId: nodeId }));
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "User requested stop");
    }
    socketsRef.current.delete(nodeId);
    setNodeStatus(nodeId, "idle");
    addLog(nodeId, "Execution stopped by user.");
    if (socketsRef.current.size === 0) {
      setExecutingNode(null).catch(err => {
        console.error(`[Workspace] Failed to clear current executing node on stop:`, err);
      });
    }
  };

  // The guard itself is a pure function over store state (src/tabs/closeGuards);
  // this only decides whether to close immediately or raise a confirmation.
  const handleCloseTab = (tabId: string) => {
    const guard = evaluateClose(useWorkspaceStore.getState(), tabId);
    if (guard.kind === "allow") {
      useWorkspaceStore.getState().closeTab(tabId);
      return;
    }
    setCloseIntercept({ tabId, type: guard.reason, title: guard.title });
  };

  // Every close affordance routes through here, so the unsaved/running guards
  // apply uniformly. Before this channel existed, the close-active-tab
  // keyboard shortcut in App.tsx called the raw store action and skipped them.
  // Safe to subscribe once: handleCloseTab closes over nothing but
  // `getState()` and the stable `setCloseIntercept` setter.
  useEffect(() => onCloseTabRequest((tabId) => handleCloseTab(tabId)), []);

  const handleConfirmCloseRunning = async () => {
    if (!closeIntercept) return;
    const { tabId } = closeIntercept;

    // Stop all running nodes in this tab
    const context = useWorkspaceStore.getState().canvasContexts[tabId];
    if (context) {
      Object.keys(context.nodeStatus || {}).forEach((nodeId) => {
        if (context.nodeStatus[nodeId] === "running") {
          stopExecution(nodeId);
        }
      });
    }

    // Save the clean "idle" status back to disk if this tab was already saved before
    if (context?.hasBeenSaved) {
      try {
        await canvasFileService.saveCanvas(tabId, closeIntercept.title);
      } catch (err) {
        console.error("[Workspace] Failed to save canvas status to disk on close:", err);
      }
    }

    // Re-evaluate rather than hand-rolling the unsaved check a second time.
    // The old second check dereferenced `context` unguarded, so a canvas whose
    // context had vanished mid-close threw here.
    const guard = evaluateClose(useWorkspaceStore.getState(), tabId);
    if (guard.kind === "confirm") {
      setCloseIntercept({ tabId, type: guard.reason, title: guard.title });
      return;
    }
    setCloseIntercept(null);
    useWorkspaceStore.getState().closeTab(tabId);
  };

  const handleSaveAndClose = async (saveTitle: string) => {
    if (!closeIntercept) return;
    const { tabId } = closeIntercept;

    if (!saveTitle.trim()) {
      notify("Invalid input", "Please enter a valid title", "info");
      return;
    }

    try {
      const filePath = await canvasFileService.saveCanvas(tabId, saveTitle);
      useWorkspaceStore.getState().updateTab(tabId, { title: saveTitle });
      useWorkspaceStore.getState().updateCanvasContext(tabId, { hasBeenSaved: true });
      setCloseIntercept(null);
      useWorkspaceStore.getState().closeTab(tabId);
      notify("Saved", `Pipeline saved to: ${filePath}`, "success");
    } catch (e: any) {
      notify("Save failed", `Error saving pipeline: ${e.message || e}`, "error");
    }
  };

  const handleDiscardAndClose = () => {
    if (!closeIntercept) return;
    setCloseIntercept(null);
    useWorkspaceStore.getState().closeTab(closeIntercept.tabId);
  };

  const tabViewContext: TabViewContext = { executeNode, stopExecution };

  // workspace-container (GPU compositing) dropped from the div below:
  // MainWorkspace.module.css's .workspace wrapper -- this div's parent
  // since PR 2 commit 8 -- now composes the same treatment one level up,
  // superseding it (REFACTOR_PLAN.md PR 2 commit 15).
  return (
    <div className="flex-1 flex h-full min-w-0 overflow-hidden relative bg-[var(--bg-editor)]">
      <CommandPermissionPresenter />
      <div className="flex flex-col h-full w-full min-w-0 overflow-hidden">
        <TabStrip />
        <TabOutlet context={tabViewContext} />
      </div>

      {closeIntercept && closeIntercept.type === "running" && createPortal(
        <div className="fixed inset-0 bg-[var(--color-surface-overlay)] backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-xl w-full max-w-md shadow-2xl overflow-hidden font-mono">
            <div className="px-4 py-3 bg-[var(--bg-header)] border-b border-[var(--border-color)] flex items-center justify-between">
              <span className="text-[var(--text-light)] text-sm font-bold flex items-center space-x-2">
                <AlertTriangle size={16} className="text-[var(--color-status-warning)] animate-pulse" />
                <span>Active Processes Running</span>
              </span>
              <button
                onClick={() => setCloseIntercept(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 flex flex-col space-y-3">
              <p className="text-xs text-[var(--text-normal)] leading-relaxed">
                The Rusty tab <code className="text-[var(--color-status-warning)] font-bold">"{closeIntercept.title}"</code> has active background processes running.
              </p>
              <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                Closing this tab will stop all running agents and cancel ongoing operations. Are you sure you want to proceed?
              </p>
            </div>
            <div className="px-4 py-3 bg-[var(--bg-header)] border-t border-[var(--border-color)] flex items-center justify-end space-x-2">
              <button
                onClick={() => setCloseIntercept(null)}
                className="px-3.5 py-1.5 border border-[var(--border-color)] hover:bg-[var(--bg-canvas)] text-[var(--text-muted)] hover:text-[var(--text-light)] rounded-lg text-xs font-semibold cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmCloseRunning}
                className="px-4 py-1.5 bg-[var(--color-status-danger-solid)] hover:bg-[var(--color-status-danger-solid)] text-[var(--color-status-danger-solid-foreground)] rounded-lg text-xs font-semibold cursor-pointer transition-colors shadow-md"
              >
                Stop Agents & Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {closeIntercept && closeIntercept.type === "unsaved" && createPortal(
        <UnsavedChangesModal
          title={closeIntercept.title}
          onSave={handleSaveAndClose}
          onDiscard={handleDiscardAndClose}
          onCancel={() => setCloseIntercept(null)}
        />,
        document.body
      )}
    </div>
  );
};

const UnsavedChangesModal: React.FC<{
  title: string;
  onSave: (saveTitle: string) => void;
  onDiscard: () => void;
  onCancel: () => void;
}> = ({ title, onSave, onDiscard, onCancel }) => {
  const [saveTitle, setSaveTitle] = useState(title);

  return (
    <div className="fixed inset-0 bg-[var(--color-surface-overlay)] backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-xl w-full max-w-md shadow-2xl overflow-hidden font-mono">
        <div className="px-4 py-3 bg-[var(--bg-header)] border-b border-[var(--border-color)] flex items-center justify-between">
          <span className="text-[var(--text-light)] text-sm font-bold flex items-center space-x-2">
            <HelpCircle size={16} className="text-[var(--color-status-info)]" />
            <span>Unsaved Rusty Canvas</span>
          </span>
          <button
            onClick={onCancel}
            className="text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 flex flex-col space-y-4">
          <p className="text-xs text-[var(--text-normal)] leading-relaxed">
            You have unsaved changes in <code className="text-[var(--color-status-info)] font-bold">"{title}"</code>. Enter a title to save your canvas before closing:
          </p>
          <div className="flex flex-col space-y-1">
            <label htmlFor="modal-rusty-title-input" className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-semibold font-sans">Rusty Title</label>
            <input
              id="modal-rusty-title-input"
              type="text"
              value={saveTitle}
              onChange={(e) => setSaveTitle(e.target.value)}
              placeholder="e.g. my_pipeline"
              className="w-full bg-[var(--bg-canvas)] border border-[var(--border-color)] focus:border-[var(--accent-color)] text-[var(--text-light)] rounded-lg px-3 py-2 text-sm outline-none transition-colors"
            />
          </div>
        </div>
        <div className="px-4 py-3 bg-[var(--bg-header)] border-t border-[var(--border-color)] flex items-center justify-between">
          <button
            onClick={onDiscard}
            className="px-3 py-1.5 border border-[var(--color-status-danger-border)] hover:bg-[var(--color-status-danger-bg)] text-[var(--color-status-danger)] rounded-lg text-xs font-semibold cursor-pointer transition-colors"
          >
            Discard Changes
          </button>
          <div className="flex items-center space-x-2">
            <button
              onClick={onCancel}
              className="px-3.5 py-1.5 border border-[var(--border-color)] hover:bg-[var(--bg-canvas)] text-[var(--text-muted)] hover:text-[var(--text-light)] rounded-lg text-xs font-semibold cursor-pointer transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onSave(saveTitle)}
              className="px-4 py-1.5 bg-[var(--color-status-success-solid)] hover:bg-[var(--color-status-success-solid)] text-[var(--color-status-success-solid-foreground)] rounded-lg text-xs font-semibold cursor-pointer transition-colors shadow-md flex items-center space-x-1"
            >
              <Save size={13} />
              <span>Save & Close</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
