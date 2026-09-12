/**
 * SidePane.tsx
 *
 * Inspector / chat side pane displayed alongside the Rusty canvas when a node
 * is selected. Provides tabs for describing the node, viewing diffs, chatting
 * with the agent, monitoring console output, and browsing the VFS.
 *
 * Architecture:
 * - The component is a pure orchestrator: it fetches store state via custom
 *   hooks, wires side-effects, and delegates rendering to sub-components.
 * - All side-effect logic (VFS sync, width persistence, keybindings, tab
 *   defaults) lives in extracted hooks under `./hooks/`.
 * - The complex WebSocket-driven explorer hook remains in `useExplorerWebSocket`.
 * - The footer (execute/stop) is extracted to `SidePaneFooter`.
 *
 * External consumers:
 * - `RustyTab.tsx` imports `{ SidePane }` and renders it when a node that
 *   supports a side pane is selected.
 */

import React, { useState, useCallback } from "react";
import { useWorkspaceStore } from "../../store";

// Hooks
import { useResizable } from "./useResizable";
import { useDiffContent } from "./useDiffContent";
import { useExplorerWebSocket } from "./useExplorerWebSocket";
import {
  useSidePaneState,
  useNodeUsage,
  useVfsFileSync,
  useWidthSync,
  useEscapeClose,
  useActiveTabDefault,
  useActiveDiffFile,
  type SidePaneTab,
} from "./hooks";

// Sub-components
import { SidePaneHeader } from "./components/SidePaneHeader";
import { SidePaneTabs } from "./components/SidePaneTabs";
import { SidePaneFooter } from "./components/SidePaneFooter";
import { DescriptionTabContent } from "./components/DescriptionTabContent";
import { DiffTabContent } from "./components/DiffTabContent";
import { ConsoleTabContent } from "./components/ConsoleTabContent";
import { ExplorerChatContent } from "./components/ExplorerChatContent";
import { PromptChatContent } from "./components/PromptChatContent";
import { VfsExplorer } from "./components/VfsExplorer";

// Services
import { canvasFileService } from "../tabs/canvas/services/canvasFileService";
import { notify } from "../../notificationStore";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SidePaneProps {
  /** Called when the pane should close (e.g. Escape key or close button). */
  onClose: () => void;
  /** Called when the user clicks the execute button on a task node. */
  onExecuteNode: (nodeId: string, customPrompt?: string) => void;
  /** Called when the user clicks the stop button on a running task node. */
  onStopExecution: (nodeId: string) => void;
  /** The current canvas tab ID (used for VFS scoping). */
  tabId?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

/**
 * SidePane — inspector panel for the selected canvas node.
 *
 * Orchestrates store state selection, side-effects, and conditional rendering
 * of tab content. Each responsibility is extracted to a dedicated hook or
 * sub-component.
 */
export const SidePane: React.FC<SidePaneProps> = ({
  onClose,
  onExecuteNode,
  onStopExecution,
  tabId,
}) => {
  /* ---- Store-derived state ---- */
  const {
    selectedNodeId,
    selectedNode,
    nodeStatus,
    selectedChatMessageCount,
    customProviders,
    activeCustomProviderId,
    modifiedFiles,
    originalFileContents,
    generatedFileContents,
    storageKey,
  } = useSidePaneState();

  /* ---- Local UI state ---- */
  const [activeTab, setActiveTab] = useState<SidePaneTab>("description");
  const [activeDiffFile, setActiveDiffFile] = useState<string>("");
  const [isMaximized, setIsMaximized] = useState(false);

  /* ---- Side-effects ---- */
  useVfsFileSync(tabId, selectedNodeId, selectedNode);
  useEscapeClose(onClose);
  useActiveTabDefault(selectedNode, setActiveTab);
  useActiveDiffFile(selectedNode, modifiedFiles, activeDiffFile, setActiveDiffFile);

  /* ---- Resize / width hooks ---- */
  const { width, setWidth, containerRef, startResizing } = useResizable(
    500,
    storageKey
  );
  useWidthSync(storageKey, setWidth, containerRef);

  /* ---- Explorer WebSocket hook ---- */
  const explorer = useExplorerWebSocket(selectedNode);

  /* ---- Token usage ---- */
  const nodeUsage = useNodeUsage(selectedNodeId);

  /* ---- Diff content ---- */
  const { originalCode, modifiedCode, isLoading: isDiffLoading } =
    useDiffContent(
      selectedNodeId,
      activeDiffFile,
      nodeStatus,
      tabId,
      originalFileContents[activeDiffFile],
      generatedFileContents[activeDiffFile]
    );

  /* ---- Handlers ---- */
  const handleToggleMaximize = useCallback(() => {
    setIsMaximized((prev) => !prev);
  }, []);

  const handleGenerateTasksClick = useCallback(() => {
    setActiveTab("chat");
    explorer.handleOpenTaskGeneration();
  }, [explorer]);

  const handleTaskGenerationModelChange = useCallback(
    (model: string) => {
      if (!selectedNode) return;
      useWorkspaceStore
        .getState()
        .updateTaskNode(selectedNode.id, { taskGenerationModel: model });
    },
    [selectedNode]
  );

  const handleCreateTaskNodes = useCallback(
    async (tasks: any[], contexts: any[]) => {
      if (!tabId || !selectedNodeId) return;

      const created = useWorkspaceStore
        .getState()
        .addTaskNodesBatch(tabId, selectedNodeId, tasks, contexts);

      if (created.length > 0) {
        await canvasFileService.autoSaveCanvas(tabId);
        notify(
          "Generated Nodes Created",
          `Added ${created.length} task node${
            created.length === 1 ? "" : "s"
          }${
            contexts.length
              ? ` and ${contexts.length} code context node${
                  contexts.length === 1 ? "" : "s"
                }`
              : ""
          }.`,
          "success"
        );
      }
    },
    [tabId, selectedNodeId]
  );

  const handleExecuteNode = useCallback(() => {
    if (!selectedNode) return;
    onExecuteNode(selectedNode.id);
  }, [selectedNode, onExecuteNode]);

  const handleStopExecution = useCallback(() => {
    if (!selectedNode) return;
    onStopExecution(selectedNode.id);
  }, [selectedNode, onStopExecution]);

  /* ---- Early exit: nothing selected ---- */
  if (!selectedNode) return null;

  /* ---- Render ---- */
  return (
    <div
      ref={containerRef}
      style={{ width: isMaximized ? "100%" : `${width}px` }}
      className={`border-l border-[var(--border-color)] bg-[var(--bg-app)]/95 flex flex-col h-full text-[var(--text-normal)] font-sans shadow-2xl z-[40] max-w-full ${
        isMaximized ? "absolute inset-0" : "absolute right-0 top-0 bottom-0"
      }`}
    >
      {/* ---- Resize Handle ---- */}
      <ResizeHandle isMaximized={isMaximized} onMouseDown={startResizing} />

      {/* ---- Header ---- */}
      <SidePaneHeader
        selectedNode={selectedNode}
        onClose={onClose}
        isMaximized={isMaximized}
        onToggleMaximize={handleToggleMaximize}
        onGenerateTasks={handleGenerateTasksClick}
        onStopGenerateTasks={explorer.handleStopTaskGeneration}
        onSummarize={explorer.handleExplorerSummarize}
        isGeneratingTasks={explorer.isGeneratingTasks}
        isSummarizing={explorer.isSummarizing}
        disableGlobalActions={
          nodeStatus === "running" || selectedChatMessageCount === 0
        }
        taskGenerationModel={explorer.taskGenerationModel}
        taskGenerationModels={explorer.allAvailableModels}
        taskGenerationUnauthenticatedProviders={explorer.unauthenticatedProviders}
        onTaskGenerationModelChange={handleTaskGenerationModelChange}
      />

      {/* ---- Tabs ---- */}
      <SidePaneTabs
        selectedNode={selectedNode}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        nodeStatus={nodeStatus}
      />

      {/* ---- Tab Content ---- */}
      <div className="flex-1 overflow-hidden relative bg-[var(--bg-app)]">
        <TabContent
          activeTab={activeTab}
          selectedNode={selectedNode}
          selectedNodeId={selectedNodeId}
          tabId={tabId}
          modifiedFiles={modifiedFiles}
          activeDiffFile={activeDiffFile}
          setActiveDiffFile={setActiveDiffFile}
          originalCode={originalCode}
          modifiedCode={modifiedCode}
          isDiffLoading={isDiffLoading}
          nodeStatus={nodeStatus}
          explorer={explorer}
          width={width}
          onCreateTaskNodes={handleCreateTaskNodes}
        />
      </div>

      {/* ---- Footer (task node only, not during chat) ---- */}
      {selectedNode.type === "taskNode" && activeTab !== "chat" && (
        <SidePaneFooter
          selectedNode={selectedNode}
          nodeStatus={nodeStatus}
          nodeUsage={nodeUsage}
          customProviders={customProviders}
          activeCustomProviderId={activeCustomProviderId}
          onExecute={handleExecuteNode}
          onStop={handleStopExecution}
        />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Sub-Components (extracted for clarity)                             */
/* ------------------------------------------------------------------ */

/**
 * Vertical resize handle on the left edge of the pane.
 *
 * Hidden when the pane is maximized (the resize action is disabled).
 */
const ResizeHandle: React.FC<{
  isMaximized: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}> = ({ isMaximized, onMouseDown }) => {
  if (isMaximized) return null;

  return (
    <div
      onMouseDown={onMouseDown}
      className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[var(--color-status-danger-bg)] active:bg-[var(--color-status-danger-solid)] transition-colors z-50"
      style={{ transform: "translateX(-50%)" }}
    />
  );
};

/**
 * Renders the active tab body content based on the current tab and node type.
 *
 * Each conditional branch checks both the active tab and whether the selected
 * node type supports that tab.
 */
const TabContent: React.FC<{
  activeTab: SidePaneTab;
  selectedNode: any;
  selectedNodeId: string | null;
  tabId: string | undefined;
  modifiedFiles: string[];
  activeDiffFile: string;
  setActiveDiffFile: (file: string) => void;
  originalCode: string;
  modifiedCode: string;
  isDiffLoading: boolean;
  nodeStatus: string;
  explorer: ReturnType<typeof useExplorerWebSocket>;
  width: number;
  onCreateTaskNodes: (tasks: any[], contexts: any[]) => Promise<void>;
}> = (props) => {
  const {
    activeTab,
    selectedNode,
    selectedNodeId,
    tabId,
    modifiedFiles,
    activeDiffFile,
    setActiveDiffFile,
    originalCode,
    modifiedCode,
    isDiffLoading,
    nodeStatus,
    explorer,
    width,
    onCreateTaskNodes,
  } = props;

  /* Description tab — task nodes only */
  if (activeTab === "description" && selectedNode.type === "taskNode") {
    return <DescriptionTabContent selectedNode={selectedNode} tabId={tabId} />;
  }

  /* Diff tab — hidden for global chat nodes */
  if (activeTab === "diff" && selectedNode.type !== "globalChatNode") {
    return (
      <DiffTabContent
        selectedNode={selectedNode}
        modifiedFiles={modifiedFiles}
        activeDiffFile={activeDiffFile}
        setActiveDiffFile={setActiveDiffFile}
        originalCode={originalCode}
        modifiedCode={modifiedCode}
        isDiffLoading={isDiffLoading}
        tabId={tabId}
      />
    );
  }

  /* Console tab — hidden for context nodes */
  if (
    activeTab === "console" &&
    selectedNodeId &&
    selectedNode.type !== "contextNode"
  ) {
    return (
      <ConsoleTabContent selectedNodeId={selectedNodeId} tabId={tabId} />
    );
  }

  /* Chat tab — different content for global chat vs other nodes */
  if (activeTab === "chat") {
    return selectedNode.type === "globalChatNode"
      ? buildGlobalChatContent(selectedNode, nodeStatus, explorer, onCreateTaskNodes)
      : buildPromptChatContent(selectedNode, nodeStatus, explorer);
  }

  /* VFS explorer tab — task and global chat nodes */
  if (activeTab === "vfs") {
    return (
      <div className="h-full" style={{ width: `${width - 8}px` }}>
        <VfsExplorer tabId={tabId} />
      </div>
    );
  }

  return null;
};

/* ------------------------------------------------------------------ */
/*  Render Helpers (pure functions, no hooks)                          */
/* ------------------------------------------------------------------ */

/**
 * Assembles the explorer chat content for global chat nodes.
 */
function buildGlobalChatContent(
  selectedNode: any,
  nodeStatus: string,
  explorer: ReturnType<typeof useExplorerWebSocket>,
  onCreateTaskNodes: (tasks: any[], contexts: any[]) => Promise<void>
): React.ReactNode {
  return (
    <ExplorerChatContent
      selectedNode={selectedNode}
      nodeStatus={nodeStatus}
      explorerInput={explorer.explorerInput}
      setExplorerInput={explorer.setExplorerInput}
      handleExplorerSendMessage={explorer.handleExplorerSendMessage}
      generatedTaskDraft={explorer.generatedTaskDraft}
      setGeneratedTaskDraft={explorer.setGeneratedTaskDraft}
      generatedContextDraft={explorer.generatedContextDraft}
      setGeneratedContextDraft={explorer.setGeneratedContextDraft}
      isTaskGenerationPromptOpen={explorer.isTaskGenerationPromptOpen}
      setIsTaskGenerationPromptOpen={explorer.setIsTaskGenerationPromptOpen}
      taskGenerationInstructions={explorer.taskGenerationInstructions}
      setTaskGenerationInstructions={explorer.setTaskGenerationInstructions}
      taskGenerationFailure={explorer.taskGenerationFailure}
      taskGenerationModel={explorer.taskGenerationModel}
      isGeneratingTasks={explorer.isGeneratingTasks}
      handleGenerateTaskDraft={explorer.handleGenerateTaskDraft}
      onCreateTaskNodes={onCreateTaskNodes}
      handleStopExplorer={explorer.handleStopExplorer}
      streamingMessageId={explorer.streamingMessageId}
      exploreModel={explorer.exploreModel}
      summarizeModel={explorer.summarizeModel}
      allAvailableModels={explorer.allAvailableModels}
      unauthenticatedProviders={explorer.unauthenticatedProviders}
      subagents={explorer.subagents}
      agentQuestion={explorer.agentQuestion}
      handleAgentQuestionAnswer={explorer.handleAgentQuestionAnswer}
    />
  );
}

/**
 * Assembles the prompt chat content for non-global-chat nodes (task, context).
 */
function buildPromptChatContent(
  selectedNode: any,
  nodeStatus: string,
  explorer: ReturnType<typeof useExplorerWebSocket>
): React.ReactNode {
  return (
    <PromptChatContent
      selectedNode={selectedNode}
      nodeStatus={nodeStatus}
      explorerInput={explorer.explorerInput}
      setExplorerInput={explorer.setExplorerInput}
      handleExplorerSendMessage={explorer.handleExplorerSendMessage}
      handleStopExplorer={explorer.handleStopExplorer}
      streamingMessageId={explorer.streamingMessageId}
      subagents={explorer.subagents}
      agentQuestion={explorer.agentQuestion}
      handleAgentQuestionAnswer={explorer.handleAgentQuestionAnswer}
    />
  );
}
