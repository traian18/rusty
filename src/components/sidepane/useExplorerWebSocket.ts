import { useState, useEffect, useRef, useMemo } from "react";
import { useWorkspaceStore } from "../../store";
import { VfsRegistry } from "../../services/vfs";
import { notify } from "../../notificationStore";
import type { SubagentActivity } from "../ui/Chat";
import {
  resolveSkill,
  toSkillData,
  BUILT_IN_SKILL_IDS,
  GLOBAL_CHAT_DEFAULT_SKILL_ID,
  GLOBAL_CHAT_SKILL_IDS,
} from "../../config/skillDefinitions";
import type { AgentQuestion } from "../ui/ChatInput";
import { scheduleTreeRefresh } from "../filetree/FileTreePresenter";
import { appendBoundedText } from "../../services/boundedTextBuffer";
import { invoke } from "@tauri-apps/api/core";
import { providerModelVariants, selectableModelProviders } from "../../store/providerHelpers";
import { useSelectableModels } from "../../hooks/useSelectableModels";
import { resolveExecutionProvider } from "../../store/resolveExecutionProvider";
import { agentChatService, AgentChatRun } from "../../services/agentChatService";
import { globalExploreService } from "../../services/globalExploreService";
import { taskGenerationService, TaskGenerationRun } from "../../services/taskGenerationService";
export interface GeneratedTaskDraft {
  key: string;
  title: string;
  description: string;
  dependsOn: string[];
  selected: boolean;
}

export interface GeneratedContextDraft {
  key: string;
  title: string;
  content: string;
  taskKeys: string[];
  selected: boolean;
}

export interface TaskGenerationFailure {
  code?: string;
  message: string;
  attempts?: number;
}

const activeExplorerChatRuns = new Map<string, AgentChatRun>();
const activeExplorerSubagents = new Map<string, SubagentActivity[]>();

interface ActiveTaskGeneration {
  run: TaskGenerationRun;
  requestId: string;
}

interface TaskGenerationViewState {
  promptOpen: boolean;
  instructions: string;
  failure: TaskGenerationFailure | null;
  draft: GeneratedTaskDraft[];
  contextDraft: GeneratedContextDraft[];
}

const TASK_GENERATION_CHANGED_EVENT = "rusty-task-generation-changed";
const activeTaskGenerations = new Map<string, ActiveTaskGeneration>();
const taskGenerationViewStates = new Map<string, TaskGenerationViewState>();

const getTaskGenerationViewState = (nodeId: string): TaskGenerationViewState =>
  taskGenerationViewStates.get(nodeId) || {
    promptOpen: false,
    instructions: "",
    failure: null,
    draft: [],
    contextDraft: [],
  };

const publishTaskGenerationChange = (nodeId: string) => {
  window.dispatchEvent(new CustomEvent(TASK_GENERATION_CHANGED_EVENT, { detail: { nodeId } }));
};

const updateTaskGenerationViewState = (nodeId: string, updates: Partial<TaskGenerationViewState>) => {
  taskGenerationViewStates.set(nodeId, { ...getTaskGenerationViewState(nodeId), ...updates });
  publishTaskGenerationChange(nodeId);
};

const setActiveTaskGeneration = (nodeId: string, generation: ActiveTaskGeneration | null) => {
  if (generation) activeTaskGenerations.set(nodeId, generation);
  else activeTaskGenerations.delete(nodeId);
  publishTaskGenerationChange(nodeId);
};

const finishTaskGeneration = (
  nodeId: string,
  run: TaskGenerationRun,
  updates: Partial<TaskGenerationViewState> = {},
) => {
  const active = activeTaskGenerations.get(nodeId);
  if (active?.run === run) activeTaskGenerations.delete(nodeId);
  taskGenerationViewStates.set(nodeId, { ...getTaskGenerationViewState(nodeId), ...updates });
  publishTaskGenerationChange(nodeId);
};

type IncomingSubagent = SubagentActivity & { previousId?: string; appendLog?: string };

const mergeSubagentUpdate = (nodeId: string, incoming: IncomingSubagent): SubagentActivity[] => {
  const current = activeExplorerSubagents.get(nodeId) || [];
  const index = current.findIndex((agent) =>
    agent.id === incoming.id || (!!incoming.previousId && agent.id === incoming.previousId)
  );
  const incomingLogs = [...(incoming.logs || []), ...(incoming.appendLog ? [incoming.appendLog] : [])];
  const cleanIncoming = { ...incoming };
  delete cleanIncoming.previousId;
  delete cleanIncoming.appendLog;

  let next: SubagentActivity[];
  if (index < 0) {
    next = [...current, { ...cleanIncoming, logs: incomingLogs }];
  } else {
    next = [...current];
    const mergedLogs = [...(next[index].logs || [])];
    for (const line of incomingLogs) {
      if (line && mergedLogs[mergedLogs.length - 1] !== line) mergedLogs.push(line);
    }
    next[index] = { ...next[index], ...cleanIncoming, logs: mergedLogs.slice(-4) };
  }
  activeExplorerSubagents.set(nodeId, next);
  return next;
};

export const useExplorerWebSocket = (selectedNode: any) => {
  const selectedNodeId = selectedNode?.id || null;
  const nodeStatus = useWorkspaceStore((state) => state.nodeStatus[selectedNodeId || ""] || "idle");

  const tabId = useMemo(() => {
    if (!selectedNodeId) return undefined;
    const contexts = useWorkspaceStore.getState().canvasContexts;
    for (const tId in contexts) {
      if (contexts[tId].nodes.some((n) => n.id === selectedNodeId)) {
        return tId;
      }
    }
    return undefined;
  }, [selectedNodeId]);

  const [explorerInput, setExplorerInput] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isGeneratingTasks, setIsGeneratingTasks] = useState(false);
  const [isTaskGenerationPromptOpen, setIsTaskGenerationPromptOpen] = useState(false);
  const [taskGenerationInstructions, setTaskGenerationInstructions] = useState("");
  const [taskGenerationFailure, setTaskGenerationFailure] = useState<TaskGenerationFailure | null>(null);
  const [generatedTaskDraft, setGeneratedTaskDraft] = useState<GeneratedTaskDraft[]>([]);
  const [generatedContextDraft, setGeneratedContextDraft] = useState<GeneratedContextDraft[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [subagents, setSubagents] = useState<SubagentActivity[]>([]);
  const [agentQuestion, setAgentQuestion] = useState<AgentQuestion | null>(null);
  const explorerRunRef = useRef<AgentChatRun | null>(null);
  const taskGenerationRunRef = useRef<TaskGenerationRun | null>(null);
  const taskGenerationRequestIdRef = useRef<string | null>(null);
  const consoleMessageIdRef = useRef<string | null>(null);
  const consoleBufferRef = useRef<string>("");
  const consoleFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addGlobalChatMessage = useWorkspaceStore((state) => state.addGlobalChatMessage);
  const updateGlobalChatMessage = useWorkspaceStore((state) => state.updateGlobalChatMessage);
  const setGlobalContextSummary = useWorkspaceStore((state) => state.setGlobalContextSummary);
  const updateNode = useWorkspaceStore((state) => state.updateTaskNode);
  const addLog = useWorkspaceStore((state) => state.addLog);
  const setNodeStatus = useWorkspaceStore((state) => state.setNodeStatus);

  const activeModel = useWorkspaceStore((state) => state.activeModel);
  const providers = useWorkspaceStore((state) => state.customProviders);
  const activeCustomProviderId = useWorkspaceStore((state) => state.activeCustomProviderId);
  const providerStatus = useWorkspaceStore((state) => state.providerStatus);
  const filteredProviders = selectableModelProviders(providers, providerStatus, activeCustomProviderId);
  const activeProvider = filteredProviders.find((p) => p.id === activeCustomProviderId);
  const availableModels = activeProvider
    ? activeProvider.models.filter((model) => model.supported !== false).flatMap(providerModelVariants)
    : [];
  const { options: allAvailableModels, unauthenticatedProviders } = useSelectableModels(
    providers,
    providerStatus,
    activeCustomProviderId,
  );

  const exploreModel = (selectedNode?.data?.exploreModel as string) || activeModel;
  const summarizeModel = (selectedNode?.data?.summarizeModel as string) || activeModel;
  const taskGenerationModel = (selectedNode?.data?.taskGenerationModel as string) || exploreModel || activeModel;

  useEffect(() => {
    if (selectedNodeId) {
      const existing = activeExplorerChatRuns.get(selectedNodeId);
      if (existing) {
        explorerRunRef.current = existing;
      }
      const history = useWorkspaceStore.getState().globalChatHistory[selectedNodeId] || [];
      const activeConsole = [...history].reverse().find((message) => message.role === "console");
      setStreamingMessageId(useWorkspaceStore.getState().nodeStatus[selectedNodeId] === "running" ? activeConsole?.id || null : null);
      setSubagents(activeExplorerSubagents.get(selectedNodeId) || []);
    } else {
      setSubagents([]);
    }
    setAgentQuestion(null);
  }, [selectedNodeId]);

  useEffect(() => {
    const syncTaskGeneration = () => {
      if (!selectedNodeId) {
        taskGenerationRunRef.current = null;
        taskGenerationRequestIdRef.current = null;
        setIsGeneratingTasks(false);
        setIsTaskGenerationPromptOpen(false);
        setTaskGenerationInstructions("");
        setTaskGenerationFailure(null);
        setGeneratedTaskDraft([]);
        setGeneratedContextDraft([]);
        return;
      }

      const active = activeTaskGenerations.get(selectedNodeId);
      const isActive = !!active;
      taskGenerationRunRef.current = isActive ? active!.run : null;
      taskGenerationRequestIdRef.current = isActive ? active!.requestId : null;
      setIsGeneratingTasks(isActive);

      const viewState = getTaskGenerationViewState(selectedNodeId);
      setIsTaskGenerationPromptOpen(viewState.promptOpen);
      setTaskGenerationInstructions(viewState.instructions);
      setTaskGenerationFailure(viewState.failure);
      setGeneratedTaskDraft(viewState.draft);
      setGeneratedContextDraft(viewState.contextDraft);
    };

    const handleTaskGenerationChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId: string }>).detail;
      if (detail?.nodeId === selectedNodeId) syncTaskGeneration();
    };

    syncTaskGeneration();
    window.addEventListener(TASK_GENERATION_CHANGED_EVENT, handleTaskGenerationChanged);
    return () => window.removeEventListener(TASK_GENERATION_CHANGED_EVENT, handleTaskGenerationChanged);
  }, [selectedNodeId]);

  useEffect(() => {
    const handleSubagentUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId: string; subagent: SubagentActivity }>).detail;
      if (detail?.nodeId !== selectedNodeId || !detail.subagent?.id) return;
      setSubagents(mergeSubagentUpdate(selectedNodeId, detail.subagent as IncomingSubagent));
    };
    window.addEventListener("rusty-subagent-update", handleSubagentUpdate);
    const handleExplorerSubagentsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId: string }>).detail;
      if (detail?.nodeId === selectedNodeId) {
        setSubagents(activeExplorerSubagents.get(selectedNodeId) || []);
      }
    };
    window.addEventListener("rusty-explorer-subagents-changed", handleExplorerSubagentsChanged);
    const handleSubagentsReset = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId: string }>).detail;
      if (detail?.nodeId === selectedNodeId) {
        activeExplorerSubagents.set(selectedNodeId, []);
        setSubagents([]);
      }
    };
    window.addEventListener("rusty-subagents-reset", handleSubagentsReset);
    return () => {
      window.removeEventListener("rusty-subagent-update", handleSubagentUpdate);
      window.removeEventListener("rusty-explorer-subagents-changed", handleExplorerSubagentsChanged);
      window.removeEventListener("rusty-subagents-reset", handleSubagentsReset);
    };
  }, [selectedNodeId]);

  useEffect(() => {
    return () => {
      // Explorer and task-generation sockets are intentionally module-scoped and
      // remain open when the side pane unmounts. Reopening the pane reattaches its UI.
    };
  }, []);

  const flushConsoleBuffer = () => {
    if (consoleMessageIdRef.current && consoleBufferRef.current) {
      updateGlobalChatMessage(selectedNodeId || "", consoleMessageIdRef.current, consoleBufferRef.current);
    }
  };

  const scheduleConsoleFlush = () => {
    if (consoleFlushTimeoutRef.current) return;
    consoleFlushTimeoutRef.current = setTimeout(() => {
      consoleFlushTimeoutRef.current = null;
      flushConsoleBuffer();
    }, 150);
  };

  const handleExplorerSendMessage = () => {
    if (!selectedNodeId) return;
    if (!explorerInput.trim() || nodeStatus === "running") return;

    const userMessage = {
      role: "user" as const,
      content: explorerInput.trim(),
      timestamp: new Date().toLocaleTimeString()
    };

    addGlobalChatMessage(selectedNodeId, userMessage);

    const consoleMessageId = `console_${Date.now()}`;
    consoleMessageIdRef.current = consoleMessageId;
    consoleBufferRef.current = "";
    addGlobalChatMessage(selectedNodeId, {
      id: consoleMessageId,
      role: "console",
      content: "",
      timestamp: new Date().toLocaleTimeString(),
    });
    setStreamingMessageId(consoleMessageId);
    activeExplorerSubagents.set(selectedNodeId, []);
    setSubagents([]);

    setExplorerInput("");
    setNodeStatus(selectedNodeId, "running");
    addLog(selectedNodeId, `User prompt: ${userMessage.content}`);

    const rootPath = useWorkspaceStore.getState().rootPath;
    const currentProviders = useWorkspaceStore.getState().customProviders;
    const currentActiveProviderId = useWorkspaceStore.getState().activeCustomProviderId;
    const currentProviderStatus = useWorkspaceStore.getState().providerStatus;
    const currentActiveModel = useWorkspaceStore.getState().activeModel;
    const currentExploreModel = selectedNode?.data?.exploreModel || selectedNode?.data?.model || currentActiveModel;
    const resolution = resolveExecutionProvider(
      currentProviders,
      currentProviderStatus,
      currentActiveProviderId,
      currentExploreModel,
    );
    if (!resolution.ok) {
      notify("Cannot start exploration", resolution.message, "error");
      setNodeStatus(selectedNodeId, "idle");
      return;
    }
    const prov = resolution.provider;
    const chatHistory = useWorkspaceStore.getState().globalChatHistory[selectedNodeId] || [];

    const isTaskNodeChat = selectedNode?.type === "taskNode";

    // TaskNode chat honors the skill selected in its pane. Other node-chat
    // surfaces keep the planning-only behavior, including for older canvases.
    const skills = useWorkspaceStore.getState().skills;
    const requestedSkillId = selectedNode?.data?.skillId as string | undefined;
    const nodeSkillId = isTaskNodeChat
      ? requestedSkillId || BUILT_IN_SKILL_IDS.BUILD
      : requestedSkillId && GLOBAL_CHAT_SKILL_IDS.includes(requestedSkillId)
        ? requestedSkillId
        : GLOBAL_CHAT_DEFAULT_SKILL_ID;
    const resolvedSkill = resolveSkill(skills, nodeSkillId);
    const skillData = toSkillData(resolvedSkill);

    // Build MCP server list from:
    //  1. The active skill's mcpServers (by name → resolved from the store)
    //  2. Any explicit MCP server override selected directly on the node
    const mcpServerName = selectedNode?.data?.mcpServerName as string | undefined;
    const mcpServersMap = useWorkspaceStore.getState().mcpServers;
    const mcpServerNames = Array.from(new Set([
      ...(resolvedSkill?.mcpServers || []),
      ...(mcpServerName ? [mcpServerName] : [])
    ]));
    const mcpServers = mcpServerNames
      .map((name) => mcpServersMap[name])
      .filter((srv): srv is Exclude<typeof srv, undefined> => !!srv);

    const run = agentChatService.send(
      {
        tabId: selectedNodeId,
        message: userMessage.content,
        workspaceRoot: rootPath,
        model: currentExploreModel,
        chatHistory: chatHistory
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content })),
        mcpServers,
        customProvider: prov,
        skill: skillData,
        planOnly: !isTaskNodeChat,
        vfsOnly: isTaskNodeChat,
        lspSettings: { ...useWorkspaceStore.getState().lspSettings, enabled: false },
      },
      {
        onConnected: () => {
          addLog(selectedNodeId, "Connected to agent sidecar for global exploration...");
        },
        onCommandOutput: (content) => {
          consoleBufferRef.current = appendBoundedText(consoleBufferRef.current, content);
          scheduleConsoleFlush();
        },
        onCommandComplete: () => {
          scheduleTreeRefresh();
        },
        onLog: (message) => {
          addLog(selectedNodeId, message);
          consoleBufferRef.current = appendBoundedText(consoleBufferRef.current, `${message}\n`);
          scheduleConsoleFlush();
        },
        onSubagentUpdate: (subagent) => {
          if (!(subagent as IncomingSubagent)?.id) return;
          setSubagents(mergeSubagentUpdate(selectedNodeId, subagent as IncomingSubagent));
          window.dispatchEvent(new CustomEvent("rusty-explorer-subagents-changed", { detail: { nodeId: selectedNodeId } }));
        },
        onAgentQuestion: (question) => {
          setAgentQuestion(question);
        },
        onReadFile: async (path) => {
          console.log(`[SidePane] Tool request: read_file ${path}`);
          if (selectedNode?.type === "taskNode" && tabId) {
            const canvasContext = useWorkspaceStore.getState().canvasContexts[tabId];
            const currentNode = canvasContext?.nodes.find((node) => node.id === selectedNodeId);
            const ownFiles = (currentNode?.data?.generatedFileContents as Record<string, string>) || {};
            const connectedUpstreamFiles = new Map<string, string>();
            for (const edge of canvasContext?.edges || []) {
              if (
                edge.target !== selectedNodeId ||
                edge.sourceHandle !== "task-out" ||
                edge.targetHandle !== "task-in"
              ) continue;
              const upstreamNode = canvasContext?.nodes.find((node) => node.id === edge.source);
              const upstreamFiles = (upstreamNode?.data?.generatedFileContents as Record<string, string>) || {};
              Object.entries(upstreamFiles).forEach(([filePath, fileContent]) => {
                connectedUpstreamFiles.set(filePath, fileContent);
              });
            }
            return ownFiles[path] !== undefined
              ? ownFiles[path]
              : connectedUpstreamFiles.has(path)
                ? connectedUpstreamFiles.get(path)!
                : await invoke<string>("read_file_disk", { path });
          }
          return VfsRegistry.getOrCreate(tabId).readFile(path);
        },
        onWriteFile: async (path, content) => {
          if (selectedNode?.type === "globalChatNode") {
            const error = "Global Chat is planning-only and cannot write files to the VFS. Use write_plan for plans.";
            addLog(selectedNodeId, error);
            throw new Error(error);
          }
          const store = useWorkspaceStore.getState();
          const currentNode = tabId
            ? store.canvasContexts[tabId]?.nodes.find((node) => node.id === selectedNodeId)
            : undefined;
          const originalFileContents = (currentNode?.data?.originalFileContents as Record<string, string>) || {};
          const generatedFileContents = (currentNode?.data?.generatedFileContents as Record<string, string>) || {};
          let original = originalFileContents[path];
          if (selectedNode?.type === "taskNode" && original === undefined) {
            try {
              original = await invoke<string>("read_file_disk", { path });
            } catch {
              original = "";
            }
          }

          await VfsRegistry.getOrCreate(tabId).writeFile(path, content, selectedNodeId || undefined);
          if (selectedNode?.type === "taskNode" && selectedNodeId) {
            store.updateTaskNode(selectedNodeId, {
              modifiedFiles: Array.from(new Set([
                ...(((currentNode?.data?.modifiedFiles as string[]) || [])),
                path,
              ])),
              originalFileContents: { ...originalFileContents, [path]: original || "" },
              generatedFileContents: { ...generatedFileContents, [path]: content },
            });
          }
        },
        onWritePlan: async (filename, content) => {
          if (selectedNode?.type !== "globalChatNode") {
            throw new Error("The write_plan tool is only available to Global Chat.");
          }
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.md$/.test(filename)) {
            throw new Error("Plan filename must be a Markdown filename using only letters, numbers, hyphens, or underscores.");
          }
          const planRoot = useWorkspaceStore.getState().rootPath?.replace(/[\\/]+$/, "");
          if (!planRoot) throw new Error("No project root is open.");
          const separator = planRoot.includes("\\") ? "\\" : "/";
          const planPath = `${planRoot}${separator}plans${separator}${filename}`;
          await invoke("write_file_disk", { path: planPath, content, tabId });
          scheduleTreeRefresh();
          addLog(selectedNodeId, `Saved plan to ${planPath}`);
          return planPath;
        },
        onComplete: ({ response: responseText }) => {
          console.log(`[SidePane] Exploration complete! Response length: ${responseText.length}`);
          const assistantMsg = {
            id: `msg_${Date.now()}`,
            role: "assistant" as const,
            content: responseText,
            timestamp: new Date().toLocaleTimeString()
          };
          addGlobalChatMessage(selectedNodeId, assistantMsg);

          if (consoleFlushTimeoutRef.current) {
            clearTimeout(consoleFlushTimeoutRef.current);
            consoleFlushTimeoutRef.current = null;
          }
          if (consoleMessageIdRef.current) {
            updateGlobalChatMessage(selectedNodeId, consoleMessageIdRef.current, "");
          }
          setStreamingMessageId(null);

          setNodeStatus(selectedNodeId, "success");
          addLog(selectedNodeId, "Global exploration completed successfully.");
          activeExplorerChatRuns.delete(selectedNodeId);
          explorerRunRef.current = null;
        },
        onError: (message) => {
          console.log(`[SidePane] Exploration error: ${message}`);
          const errorMsg = {
            id: `msg_${Date.now()}`,
            role: "assistant" as const,
            content: `Error: ${message}`,
            timestamp: new Date().toLocaleTimeString()
          };
          addGlobalChatMessage(selectedNodeId, errorMsg);
          if (consoleFlushTimeoutRef.current) {
            clearTimeout(consoleFlushTimeoutRef.current);
            consoleFlushTimeoutRef.current = null;
          }
          if (consoleMessageIdRef.current) {
            updateGlobalChatMessage(selectedNodeId, consoleMessageIdRef.current, "");
          }
          setStreamingMessageId(null);
          setNodeStatus(selectedNodeId, "error");
          addLog(selectedNodeId, `Global exploration error: ${message}`);
          activeExplorerChatRuns.delete(selectedNodeId);
          explorerRunRef.current = null;
          notify("Exploration Error", `Exploration failed with error: ${message}`, "error");
        },
      }
    );
    explorerRunRef.current = run;
    activeExplorerChatRuns.set(selectedNodeId, run);
  };

  const handleStopExplorer = () => {
    const run = selectedNodeId ? activeExplorerChatRuns.get(selectedNodeId) : explorerRunRef.current;
    run?.cancel();
    if (selectedNodeId) {
      activeExplorerChatRuns.delete(selectedNodeId);
    }
    explorerRunRef.current = null;
    setStreamingMessageId(null);
    setNodeStatus(selectedNodeId || "", "idle");
  };

  const handleAgentQuestionAnswer = (answer: string) => {
    const run = selectedNodeId ? activeExplorerChatRuns.get(selectedNodeId) : explorerRunRef.current;
    if (!agentQuestion || !run) return;
    run.answerQuestion(agentQuestion.requestId, answer);
    addLog(selectedNodeId || "", `User answer: ${answer}`);
    setAgentQuestion(null);
  };

  const handleExplorerSummarize = () => {
    if (!selectedNodeId) return;
    const chatHistory = useWorkspaceStore.getState().globalChatHistory[selectedNodeId] || [];
    if (chatHistory.length === 0) {
      notify("Summarize", "No conversation to summarize.", "info");
      return;
    }
    if (nodeStatus === "running" || isSummarizing) return;

    setIsSummarizing(true);
    setNodeStatus(selectedNodeId, "running");
    addLog(selectedNodeId, "Summarizing conversation (focused on recent discussion)...");

    // Focus on the most recent portion of the discussion. The user typically
    // iterates over many topics and acts on the latest one, so the summary
    // should capture the current intent rather than earlier tangents.
    const RECENT_WINDOW = 8;
    const recentMessages = chatHistory.slice(-RECENT_WINDOW);
    const totalCount = chatHistory.length;
    const truncatedCount = Math.max(0, totalCount - recentMessages.length);
    const conversationText = recentMessages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const rootPath = useWorkspaceStore.getState().rootPath;
    const currentProviders = useWorkspaceStore.getState().customProviders;
    const currentActiveProviderId = useWorkspaceStore.getState().activeCustomProviderId;
    const currentProviderStatus = useWorkspaceStore.getState().providerStatus;
    const currentActiveModel = useWorkspaceStore.getState().activeModel;
    const currentSummarizeModel = selectedNode?.data?.summarizeModel || currentActiveModel;
    const resolution = resolveExecutionProvider(
      currentProviders,
      currentProviderStatus,
      currentActiveProviderId,
      currentSummarizeModel,
    );
    if (!resolution.ok) {
      notify("Cannot summarize", resolution.message, "error");
      setNodeStatus(selectedNodeId, "idle");
      setIsSummarizing(false);
      return;
    }
    const prov = resolution.provider;

    // Always use task-auditor skill for summarization on this node type.
    const skills = useWorkspaceStore.getState().skills;
    const auditorSkill = resolveSkill(skills, BUILT_IN_SKILL_IDS.TASK_AUDITOR);
    const skillData = toSkillData(auditorSkill);

    const truncationNote = truncatedCount > 0
      ? `\n\nNote: This conversation had ${totalCount} total messages; only the last ${recentMessages.length} are included because the user iterates over many topics and the current focus is the most recent discussion.`
      : "";

    // Not tracked on explorerRunRef/activeExplorerChatRuns: those are typed to
    // agent_chat's AgentChatRun (send-message flow) specifically, and (as
    // before this migration) summarize has no external stop affordance --
    // the previous code's assignment of this to the same ref as the chat
    // socket was dead weight, since handleStopExplorer only ever sent an
    // agent_chat_stop, which a global_explore-capability run never understood.
    globalExploreService.explore(
      {
        nodeId: selectedNodeId,
        prompt: `Please summarize the recent portion of the following conversation concisely. The user typically discusses many topics in sequence but only acts on the latest one, so focus the summary on the most recent exchange: what the user wants, what was decided or agreed, and the immediate next steps.${truncationNote}\n\n${conversationText}`,
        workspaceRoot: rootPath,
        model: currentSummarizeModel,
        chatHistory: [],
        customProvider: prov,
        skill: skillData,
      },
      {
        onLog: (message) => {
          addLog(selectedNodeId, message);
        },
        onReadFile: (path) => VfsRegistry.getOrCreate(tabId).readFile(path),
        onComplete: (summary) => {
          setGlobalContextSummary(summary);
          updateNode(selectedNodeId, { summary });
          setNodeStatus(selectedNodeId, "success");
          addLog(selectedNodeId, `Conversation summarized (${summary.length} chars).`);
          setIsSummarizing(false);
        },
        onError: (message) => {
          setNodeStatus(selectedNodeId, "error");
          addLog(selectedNodeId, `Summarize error: ${message}`);
          setIsSummarizing(false);
          notify("Summarize Error", `Summarization failed with error: ${message}`, "error");
        },
      }
    );
  };

  const handleOpenTaskGeneration = () => {
    if (!selectedNodeId || isGeneratingTasks || activeTaskGenerations.has(selectedNodeId) || nodeStatus === "running") return;
    const history = useWorkspaceStore.getState().globalChatHistory[selectedNodeId] || [];
    if (!history.some((message) => message.role === "user" || message.role === "assistant")) {
      notify("Generate Tasks", "Discuss the story before generating task nodes.", "info");
      return;
    }
    updateTaskGenerationViewState(selectedNodeId, { failure: null, promptOpen: true });
  };

  const handleGenerateTaskDraft = () => {
    if (!selectedNodeId || isGeneratingTasks || nodeStatus === "running") return;
    const taskNodeId = selectedNodeId;
    if (activeTaskGenerations.has(taskNodeId)) return;
    const history = useWorkspaceStore.getState().globalChatHistory[taskNodeId] || [];
    const chatHistory = history
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content }));
    if (!chatHistory.length) {
      notify("Generate Tasks", "Discuss the story before generating task nodes.", "info");
      return;
    }

    const additionalInstructions = getTaskGenerationViewState(taskNodeId).instructions.trim();
    const requestId = `tasks_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const state = useWorkspaceStore.getState();
    const resolution = resolveExecutionProvider(
      state.customProviders,
      state.providerStatus,
      state.activeCustomProviderId,
      taskGenerationModel,
    );
    if (!resolution.ok) {
      updateTaskGenerationViewState(taskNodeId, {
        failure: { message: resolution.message },
        promptOpen: true,
      });
      notify("Cannot generate tasks", resolution.message, "error");
      return;
    }

    taskGenerationViewStates.set(taskNodeId, {
      ...getTaskGenerationViewState(taskNodeId),
      promptOpen: false,
      failure: null,
      draft: [],
      contextDraft: [],
    });

    const run = taskGenerationService.generate(
      {
        nodeId: taskNodeId,
        requestId,
        model: taskGenerationModel,
        chatHistory,
        additionalInstructions,
        workspaceRoot: state.rootPath,
        customProvider: resolution.provider,
      },
      {
        onLog: (message) => {
          addLog(taskNodeId, message);
        },
        onComplete: ({ tasks, contexts }) => {
          const draft = tasks.map((task: any, index: number) => ({
            key: String(task.key || `task-${index + 1}`),
            title: String(task.title || ""),
            description: String(task.description || ""),
            dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
            selected: true,
          }));
          const contextDraft = contexts.map((context: any, index: number) => ({
            key: String(context.key || `context-${index + 1}`),
            title: String(context.title || `Code context ${index + 1}`),
            content: String(context.content || ""),
            taskKeys: Array.isArray(context.taskKeys) ? context.taskKeys.map(String) : [],
            selected: true,
          }));
          finishTaskGeneration(taskNodeId, run, {
            draft,
            contextDraft,
            instructions: "",
            failure: null,
            promptOpen: false,
          });
        },
        onStopped: () => {
          finishTaskGeneration(taskNodeId, run);
        },
        onError: (failure) => {
          finishTaskGeneration(taskNodeId, run, { failure, promptOpen: true });
          if (failure.code === "INVALID_TASK_JSON") {
            notify(
              "Switch Task Generation Model",
              "Task generation returned invalid JSON twice. The selected model may be too small to complete this task reliably. Choose a more capable model in the task-generation panel, then retry.",
              "error"
            );
          } else {
            notify("Task Generation Failed", failure.message, "error");
          }
        },
      }
    );
    setActiveTaskGeneration(taskNodeId, { run, requestId });
    taskGenerationRunRef.current = run;
    taskGenerationRequestIdRef.current = requestId;
  };

  const handleStopTaskGeneration = () => {
    if (!selectedNodeId) return;
    const active = activeTaskGenerations.get(selectedNodeId);
    const run = active?.run || taskGenerationRunRef.current;
    run?.cancel();
    if (run) finishTaskGeneration(selectedNodeId, run);
    taskGenerationRunRef.current = null;
    taskGenerationRequestIdRef.current = null;
  };

  const updateGeneratedTaskDraft: typeof setGeneratedTaskDraft = (action) => {
    if (!selectedNodeId) return;
    const current = getTaskGenerationViewState(selectedNodeId).draft;
    const draft = typeof action === "function" ? action(current) : action;
    updateTaskGenerationViewState(selectedNodeId, { draft });
  };

  const updateGeneratedContextDraft: typeof setGeneratedContextDraft = (action) => {
    if (!selectedNodeId) return;
    const current = getTaskGenerationViewState(selectedNodeId).contextDraft;
    const contextDraft = typeof action === "function" ? action(current) : action;
    updateTaskGenerationViewState(selectedNodeId, { contextDraft });
  };

  const updateTaskGenerationPromptOpen = (promptOpen: boolean) => {
    if (selectedNodeId) updateTaskGenerationViewState(selectedNodeId, { promptOpen });
  };

  const updateTaskGenerationInstructions = (instructions: string) => {
    if (selectedNodeId) updateTaskGenerationViewState(selectedNodeId, { instructions });
  };

  return {
    explorerInput,
    setExplorerInput,
    isSummarizing,
    isGeneratingTasks,
    generatedTaskDraft,
    setGeneratedTaskDraft: updateGeneratedTaskDraft,
    generatedContextDraft,
    setGeneratedContextDraft: updateGeneratedContextDraft,
    isTaskGenerationPromptOpen,
    setIsTaskGenerationPromptOpen: updateTaskGenerationPromptOpen,
    taskGenerationInstructions,
    setTaskGenerationInstructions: updateTaskGenerationInstructions,
    taskGenerationFailure,
    showSettings,
    setShowSettings,
    handleExplorerSendMessage,
    handleExplorerSummarize,
    handleOpenTaskGeneration,
    handleGenerateTaskDraft,
    handleStopTaskGeneration,
    handleStopExplorer,
    handleAgentQuestionAnswer,
    streamingMessageId,
    subagents,
    agentQuestion,
    exploreModel,
    summarizeModel,
    taskGenerationModel,
    providers: filteredProviders,
    activeCustomProviderId,
    availableModels,
    allAvailableModels,
    unauthenticatedProviders
  };
};
