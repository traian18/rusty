/**
 * RustyTab.tsx
 *
 * Main Rusty canvas tab component. Provides a React Flow canvas for building
 * and visualizing Rusty pipelines with nodes (task, context, MCP, sticky,
 * boundary, global chat) and edges.
 *
 * Architecture:
 * - `RustyTab` is the entry point that wraps the content in a ReactFlowProvider.
 * - `RustyTabContent` orchestrates store access, event handlers, effects, and
 *   rendering, delegating to extracted helper functions and sub-components.
 *
 * External consumers:
 * - `Workspace.tsx` imports `{ RustyTab }` and renders it with `tab`,
 *   `onExecuteNode`, and `onStopExecution` props.
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { ReactFlow, Background, BackgroundVariant, ReactFlowProvider, useViewport } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Maximize, Link2 } from "lucide-react";

import { useWorkspaceStore } from "../../../store";
import { notify } from "../../../notificationStore";
import type { TabOfType } from "../../../tabs/types";
import { SidePane } from "../../sidepane/SidePane";
import { ReconciliationGraphPane } from "../../sidepane/ReconciliationGraphPane";
import { ContextNode } from "../../nodes/ContextNode";
import { TaskNode } from "../../nodes/TaskNode";
import { GlobalChatNode } from "../../nodes/globalChat/GlobalChatNode";
import { McpNode } from "../../nodes/McpNode";
import { StickyNode } from "../../nodes/sticky";
import { BoundaryNode } from "../../nodes/boundary";
import { VFS_CHANGED_EVENT, type VfsChangedDetail } from "../../../services/vfs";
import { CanvasTabContext } from "./CanvasTabContext";
import { canvasFileService } from "./services/canvasFileService";
import { getNodeConfig } from "../../nodes/RustyNodeConfig";
import { reconciliationService, withoutReconciliationFiles } from "../../../services/reconciliationService";
import { buildReconciliationTaskFileRecords, normalizeReconciliationPath } from "../../../services/reconciliationPaths";
import {
  CANVAS_NODE_FOCUS_EVENT,
  type CanvasNodeFocusDetail,
} from "../../../services/canvasNodeNavigation";

import { isValidConnection, getPossibleConnection } from "./helpers/connectionHelpers";
import { buildFlowNodes } from "./helpers/canvasHelpers";
import { reconcileAndApplyChanges, type TaskNodeRecord } from "./helpers/reconciliationHelpers";
import { RustyTabToolbar } from "./components/RustyTabToolbar";
import { RustyTabContextMenu, type ContextMenuPosition } from "./components/RustyTabContextMenu";
import { RustyTabSaveModal } from "./components/RustyTabSaveModal";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const nodeTypes = {
  contextNode: ContextNode,
  taskNode: TaskNode,
  globalChatNode: GlobalChatNode,
  mcpNode: McpNode,
  stickyNode: StickyNode,
  boundaryNode: BoundaryNode,
};

const edgeTypes = {};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface RustyTabProps {
  tab: TabOfType<"canvas">;
  onExecuteNode: (nodeId: string) => void;
  onStopExecution: (nodeId: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Entry Point                                                        */
/* ------------------------------------------------------------------ */

/**
 * Wraps the Rusty canvas content in a ReactFlowProvider so that
 * React Flow hooks (e.g., `useViewport`) are available to children.
 */
export const RustyTab: React.FC<RustyTabProps> = (props) => {
  return (
    <ReactFlowProvider>
      <RustyTabContent {...props} />
    </ReactFlowProvider>
  );
};

/* ------------------------------------------------------------------ */
/*  Main Content                                                       */
/* ------------------------------------------------------------------ */

/**
 * Core canvas component. Handles all Rusty tab behaviour:
 * store integration, event handling, effects, and rendering.
 */
const RustyTabContent: React.FC<RustyTabProps> = ({ tab, onExecuteNode, onStopExecution }) => {
  /* ---- Store state ---- */
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const context = useWorkspaceStore(
    (state) => state.canvasContexts[tab.id]
  ) || {
    nodes: [],
    edges: [],
    nodeStatus: {},
    edgeReconciliationStatus: {},
    isPipelineApplied: false,
  };

  const nodes = context.nodes || [];
  const edges = context.edges || [];
  const isPipelineApplied = !!context.isPipelineApplied;
  const isReconciliationRunning =
    context.nodeStatus?.[`__reconciliation__:${tab.id}`] === "running";
  const hasGlobalChatNode = nodes.some(
    (node: { type?: string }) => node.type === "globalChatNode"
  );

  const selectedNodeId = useWorkspaceStore((state) => state.selectedNodeId);
  const setSelectedNodeId = useWorkspaceStore((state) => state.setSelectedNodeId);
  const setSelectedEdgeId = useWorkspaceStore((state) => state.setSelectedEdgeId);
  const updateCanvasContext = useWorkspaceStore((state) => state.updateCanvasContext);

  /* ---- Store action creators ---- */
  const storeActions = useStoreActions();

  /* ---- Local state ---- */
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveTitle, setSaveTitle] = useState(tab.title);
  const [showReconciliationGraphPane, setShowReconciliationGraphPane] = useState(false);
  const [hasOpenedReconciliationGraphPane, setHasOpenedReconciliationGraphPane] = useState(false);
  const [rfInstance, setRfInstance] = useState<any>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);

  const connectionStartRef = useRef<any>(null);
  const initRef = useRef(false);

  /* ---- Context node visibility state ---- */
  const contextNodesHidden = context.contextNodesHidden ?? false;
  const contextRevealedTasks = context.contextRevealedTasks ?? [];

  /** Toggles context node visibility mode. */
  const handleToggleContextNodesHidden = useCallback(() => {
    updateCanvasContext(tab.id, { contextNodesHidden: !contextNodesHidden });
  }, [updateCanvasContext, tab.id, contextNodesHidden]);

  /* ---- Derived data ---- */
  const flowNodes = useMemo(() => {
    const built = buildFlowNodes(nodes);
    if (!contextNodesHidden) return built;
    // When context nodes are hidden, only keep context nodes that are
    // connected to a task in the revealed-tasks set.
    const revealedContextIds = new Set<string>();
    if (contextRevealedTasks.length > 0) {
      edges.forEach((edge: { source: string; target: string; targetHandle?: string | null }) => {
        if (
          contextRevealedTasks.includes(edge.target) &&
          edge.targetHandle?.startsWith("context-in")
        ) {
          revealedContextIds.add(edge.source);
        }
      });
    }
    return built.filter((node: { type?: string; id: string }) => {
      if (node.type === "contextNode" && !revealedContextIds.has(node.id)) {
        return false;
      }
      return true;
    });
  }, [nodes, edges, contextNodesHidden, contextRevealedTasks]);

  const selectedNodes = useMemo(
    () => flowNodes.filter((n: { selected?: boolean }) => n.selected),
    [flowNodes]
  );

  const boundaryNodes = useMemo(
    () => nodes.filter((node: { type?: string }) => node.type === "boundaryNode"),
    [nodes]
  );

  const globalChatNode = useMemo(
    () => nodes.find((node: { type?: string }) => node.type === "globalChatNode"),
    [nodes]
  );

  /* ================================================================ */
  /*  React Flow Event Handlers                                        */
  /* ================================================================ */

  const onNodesChange = useCallback(
    (changes: any[]) => {
      useWorkspaceStore.getState().onNodesChangeForTab(tab.id, changes);
    },
    [tab.id]
  );

  const onEdgesChange = useCallback(
    (changes: any[]) => {
      useWorkspaceStore.getState().onEdgesChangeForTab(tab.id, changes);
    },
    [tab.id]
  );

  const onConnect = useCallback(
    (connection: any) => {
      useWorkspaceStore.getState().onConnectForTab(tab.id, connection);
    },
    [tab.id]
  );

  const onConnectStart = useCallback(
    (_: any, { nodeId, handleId, handleType }: any) => {
      connectionStartRef.current = { nodeId, handleId, handleType };
    },
    []
  );

  const onConnectEnd = useCallback(
    (event: any) => {
      if (!connectionStartRef.current) return;

      const target = event.target as Element;
      const isPane =
        target.classList.contains("react-flow__pane") ||
        target.closest(".react-flow__pane");

      if (isPane && rfInstance) {
        const { nodeId, handleId } = connectionStartRef.current;
        const startNode = nodes.find((n: { id: string }) => n.id === nodeId);

        if (
          startNode &&
          startNode.type === "taskNode" &&
          handleId?.startsWith("context-in")
        ) {
          const clientX = event.clientX || (event.touches?.[0]?.clientX);
          const clientY = event.clientY || (event.touches?.[0]?.clientY);

          if (clientX !== undefined && clientY !== undefined) {
            const projected = rfInstance.screenToFlowPosition({
              x: clientX,
              y: clientY,
            });
            useWorkspaceStore
              .getState()
              .addAndConnectContextNode(
                projected.x,
                projected.y,
                nodeId,
                handleId,
                tab.id
              );
          }
        }
      }

      connectionStartRef.current = null;
    },
    [nodes, rfInstance, tab.id]
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, _node: any) => {
      setSelectedEdgeId(null);
    },
    [setSelectedEdgeId]
  );

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: any) => {
      const currentSelectedId = useWorkspaceStore.getState().selectedNodeId;
      const selectedNodeInThisCanvas = nodes.find(
        (n: { id: string }) => n.id === currentSelectedId
      );
      if (
        !selectedNodeInThisCanvas ||
        selectedNodeInThisCanvas.type !== "globalChatNode"
      ) {
        setSelectedNodeId(null);
      }
      setSelectedEdgeId(edge.id);
    },
    [setSelectedNodeId, setSelectedEdgeId, nodes]
  );

  const onPaneClick = useCallback(() => {
    setSelectedEdgeId(null);
    const currentSelectedId = useWorkspaceStore.getState().selectedNodeId;
    if (!currentSelectedId) {
      setContextMenu(null);
      return;
    }
    const selectedNodeInThisCanvas = nodes.find(
      (n: { id: string }) => n.id === currentSelectedId
    );
    if (!selectedNodeInThisCanvas) {
      setContextMenu(null);
      return;
    }
    if (selectedNodeInThisCanvas.type === "globalChatNode") {
      return;
    }
    setSelectedNodeId(null);
    setContextMenu(null);
  }, [setSelectedNodeId, setSelectedEdgeId, nodes]);

  const onPaneContextMenu = useCallback(
    (event: any) => {
      event.preventDefault();
      const bounds = document
        .getElementById(`rf-canvas-${tab.id}`)
        ?.getBoundingClientRect();
      if (bounds) {
        setContextMenu({
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
          screenX: event.clientX,
          screenY: event.clientY,
        });
      }
    },
    [tab.id]
  );

  const onNodeContextMenu = useCallback(
    (event: any, node: any) => {
      if (node.type !== "boundaryNode") return;
      event.preventDefault();
      const bounds = document
        .getElementById(`rf-canvas-${tab.id}`)
        ?.getBoundingClientRect();
      if (bounds) {
        setContextMenu({
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
          screenX: event.clientX,
          screenY: event.clientY,
        });
      }
    },
    [tab.id]
  );

  const onPaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return;

      const bounds = document
        .getElementById(`rf-canvas-${tab.id}`)
        ?.getBoundingClientRect();
      if (!bounds || !rfInstance) return;

      const position = rfInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      storeActions.addTaskNode(position.x - 75, position.y - 30, tab.id);
    },
    [rfInstance, storeActions, tab.id]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const rawData = event.dataTransfer.getData("text/plain");
      if (!rawData) return;

      try {
        const dragData = JSON.parse(rawData);
        if (!dragData || !dragData.path || !dragData.name) return;

        let position = { x: event.clientX, y: event.clientY };
        if (rfInstance) {
          position = rfInstance.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          });
        } else {
          const bounds = document
            .getElementById(`rf-canvas-${tab.id}`)
            ?.getBoundingClientRect();
          if (bounds) {
            position = {
              x: event.clientX - bounds.left,
              y: event.clientY - bounds.top,
            };
          }
        }

        storeActions.addContextNode(
          position.x - 75,
          position.y - 30,
          {
            path: dragData.path,
            name: dragData.name,
            isDir: dragData.isDir,
          },
          tab.id
        );
      } catch (err) {
        console.log("App canvas drop: Not a JSON string.", err);
      }
    },
    [storeActions, rfInstance, tab.id]
  );

  const onInit = useCallback((instance: any) => {
    setRfInstance(instance);
    if (!initRef.current) {
      initRef.current = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          instance.fitView({ maxZoom: 1.2 });
        });
      });
    }
  }, []);

  /* ---- Connection helpers (derived from selected nodes) ---- */

  const possibleConnection = useMemo(() => {
    if (selectedNodes.length !== 2) return null;
    return getPossibleConnection(selectedNodes[0], selectedNodes[1], nodes, edges);
  }, [selectedNodes, nodes, edges]);

  const handleConnectSelected = useCallback(() => {
    if (possibleConnection) {
      useWorkspaceStore.getState().onConnectForTab(tab.id, possibleConnection);
    }
  }, [possibleConnection, tab.id]);

  /* ---- Validation (delegates to pure helper) ---- */

  const handleIsValidConnection = useCallback(
    (connection: any) => isValidConnection(connection, nodes),
    [nodes]
  );

  /* ================================================================ */
  /*  Business Logic Handlers                                          */
  /* ================================================================ */

  /** Opens the reconciliation graph pane. */
  const handleReconcileCode = useCallback(() => {
    setHasOpenedReconciliationGraphPane(true);
    setShowReconciliationGraphPane(true);
  }, []);

  /** Applies VFS changes to disk via the reconciliation pipeline. */
  const handleApplyChanges = useCallback(async () => {
    const result = await reconcileAndApplyChanges(
      tab.id,
      rootPath,
      isReconciliationRunning,
      context.reconciliationSnapshot,
      buildTaskNodeRecords(nodes)
    );

    if (!result.success) {
      notify("Info", result.message, result.notificationType);

      // If the failure is due to unreconciled or stale files, open the
      // reconciliation pane to guide the user.
      if (
        result.message.includes("Reconciliation Required") ||
        result.message.includes("Reconciliation Out of Date")
      ) {
        handleReconcileCode();
      }
      return;
    }

    // Success: update store state and auto-save
    useWorkspaceStore
      .getState()
      .updateCanvasContext(tab.id, { isPipelineApplied: true });
    void canvasFileService.autoSaveCanvas(tab.id);

    notify("Applied", result.message, "success");

    // Refresh file tree and git status
    if (rootPath) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const tree: any[] = await invoke("get_directory_structure", {
          rootDir: rootPath,
        });
        useWorkspaceStore.getState().setFileTree(tree);
        await useWorkspaceStore.getState().loadGitStatus();
      } catch (e: any) {
        console.error("[RustyTab] Failed to refresh file tree after apply:", e);
      }
    }
  }, [tab.id, rootPath, isReconciliationRunning, context.reconciliationSnapshot, nodes, handleReconcileCode]);

  /** Opens the save modal. */
  const handleSavePipeline = useCallback(() => {
    setShowSaveModal(true);
  }, []);

  /** Confirms the save action from the modal. */
  const confirmSavePipeline = useCallback(async () => {
    if (!saveTitle.trim()) {
      notify("Invalid input", "Please enter a valid title", "info");
      return;
    }
    try {
      const filePath = await canvasFileService.saveCanvas(tab.id, saveTitle);
      useWorkspaceStore.getState().updateTab(tab.id, { title: saveTitle });
      useWorkspaceStore
        .getState()
        .updateCanvasContext(tab.id, { hasBeenSaved: true });
      setShowSaveModal(false);
      notify("Saved", `Pipeline saved to: ${filePath}`, "success");
    } catch (e: any) {
      notify("Save failed", `Error saving pipeline: ${e.message || e}`, "error");
    }
  }, [saveTitle, tab.id]);

  /* ---- Node creation from context menu ---- */

  const handleAddNodeFromContextMenu = useCallback(
    (type: "task" | "context" | "sticky" | "boundary") => {
      if (!contextMenu || !rfInstance) return;

      const flowPosition = rfInstance.screenToFlowPosition({
        x: contextMenu.screenX,
        y: contextMenu.screenY,
      });

      switch (type) {
        case "task":
          storeActions.addTaskNode(flowPosition.x - 75, flowPosition.y - 30, tab.id);
          break;
        case "context":
          storeActions.addContextNode(flowPosition.x - 75, flowPosition.y - 30, undefined, tab.id);
          break;
        case "sticky":
          storeActions.addStickyNode(flowPosition.x - 100, flowPosition.y - 75, tab.id);
          break;
        case "boundary":
          storeActions.addBoundaryNode(flowPosition.x - 150, flowPosition.y - 100, tab.id);
          break;
      }
      setContextMenu(null);
    },
    [contextMenu, rfInstance, storeActions, tab.id]
  );

  /* ================================================================ */
  /*  Effects                                                           */
  /* ================================================================ */

  /* ---- Invalidate reconciliation on TaskNode VFS writes ---- */
  useEffect(() => {
    return registerVfsInvalidationEffect(tab.id, rootPath);
  }, [rootPath, tab.id]);

  /* ---- Audit reconciliation ledger on mount / nodes change ---- */
  useEffect(() => {
    return registerReconciliationAuditEffect(tab.id, rootPath, context, nodes);
    // Intentionally re-run when reconciliationSnapshot or nodes change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.reconciliationSnapshot, nodes, rootPath, tab.id]);

  /* ---- Handle canvas node focus events ---- */
  useEffect(() => {
    return registerNodeFocusEffect(tab.id, nodes, rfInstance);
  }, [nodes, rfInstance, tab.id]);

  /* ---- Global click closes context menu ---- */
  useEffect(() => {
    const handleGlobalClick = () => {
      setContextMenu(null);
    };
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, []);

  /* ---- Auto-save on data changes ---- */
  useEffect(() => {
    if (!context.hasBeenSaved) return;

    const timer = setTimeout(() => {
      console.log(`[RustyTab] Auto-saving canvas tab: ${tab.id}`);
      canvasFileService.autoSaveCanvas(tab.id);
    }, 1500);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, context.globalChatHistory, context.hasBeenSaved, tab.id]);

  /* ---- Undo / Redo keyboard shortcuts ---- */
  useEffect(() => {
    return registerUndoRedoShortcut(tab.id);
  }, [tab.id]);

  /* ================================================================ */
  /*  Side Pane Visibility                                             */
  /* ================================================================ */

  const selectedNode = useMemo(
    () => flowNodes.find((n: { id: string }) => n.id === selectedNodeId),
    [flowNodes, selectedNodeId]
  );

  const showSidePane = useMemo(() => {
    if (!selectedNodeId || !selectedNode) return false;
    if (selectedNode.type === "globalChatNode") return true;
    return (
      selectedNodes.length === 1 &&
      selectedNodes[0].id === selectedNodeId &&
      getNodeConfig(selectedNode.type || "").hasSidepane
    );
  }, [selectedNodeId, selectedNode, selectedNodes]);

  /* ================================================================ */
  /*  Render                                                            */
  /* ================================================================ */

  return (
    <CanvasTabContext.Provider value={{ tabId: tab.id }}>
      <div className="w-full h-full flex flex-row relative terminal-theme-tab">
        {/* ---- Canvas Area ---- */}
        <div
          className="flex-1 min-h-0 relative bg-[var(--bg-canvas)]"
          id={`rf-canvas-${tab.id}`}
          onDragOver={onDragOver}
        >
          {/* Toolbar */}
          <RustyTabToolbar
            tabId={tab.id}
            boundaryNodes={boundaryNodes}
            globalChatNode={globalChatNode}
            hasGlobalChatNode={hasGlobalChatNode}
            isReconciliationRunning={isReconciliationRunning}
            isPipelineApplied={isPipelineApplied}
            rfInstance={rfInstance}
            contextNodesHidden={contextNodesHidden}
            onToggleContextNodesHidden={handleToggleContextNodesHidden}
            onAddTaskNode={(x, y) => storeActions.addTaskNode(x, y, tab.id)}
            onAddContextNode={(x, y) =>
              storeActions.addContextNode(x, y, undefined, tab.id)
            }
            onAddMcpNode={(x, y) => storeActions.addMcpNode(x, y, tab.id)}
            onAddStickyNode={(x, y) => storeActions.addStickyNode(x, y, tab.id)}
            onAddBoundaryNode={(x, y) =>
              storeActions.addBoundaryNode(x, y, tab.id)
            }
            onAddGlobalChatNode={(x, y) =>
              storeActions.addGlobalChatNode(x, y, tab.id)
            }
            onReconcileCode={handleReconcileCode}
            onSavePipeline={handleSavePipeline}
            onApplyChanges={handleApplyChanges}
          />

          {/* Bottom Left Controls */}
          <div className="absolute bottom-4 left-4 z-10 flex items-center space-x-2">
            <button
              onClick={() => rfInstance?.fitView()}
              className="bg-[var(--bg-sidebar)]/80 border border-[var(--border-color)] hover:bg-[var(--bg-header)] text-[var(--text-normal)] text-xs font-mono font-bold px-3 py-1.5 rounded-lg flex items-center space-x-1.5 transition-all shadow-md cursor-pointer hover:border-[var(--border-active)]"
            >
              <Maximize size={13} className="text-[var(--accent-color)]" />
              <span>Center</span>
            </button>
          </div>

          {/* Context Menu */}
          {contextMenu && (
            <RustyTabContextMenu
              position={contextMenu}
              rfInstance={rfInstance}
              tabId={tab.id}
              hasGlobalChatNode={hasGlobalChatNode}
              onClose={() => setContextMenu(null)}
              onAddNode={handleAddNodeFromContextMenu}
              onAddMcpNode={(x, y) =>
                storeActions.addMcpNode(x, y, tab.id)
              }
              onAddGlobalChatNode={(x, y) =>
                storeActions.addGlobalChatNode(x, y, tab.id)
              }
            />
          )}

          {/* React Flow Board */}
          <div
            className="absolute inset-0"
            onDoubleClick={onPaneDoubleClick}
            onDragOver={onDragOver}
          >
            <ReactFlow
              style={{ width: "100%", height: "100%" }}
              nodes={flowNodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={onPaneClick}
              onPaneContextMenu={onPaneContextMenu}
              onNodeContextMenu={onNodeContextMenu}
              onInit={onInit}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onConnectStart={onConnectStart}
              onConnectEnd={onConnectEnd}
              isValidConnection={handleIsValidConnection}
              proOptions={{ hideAttribution: true }}
              maxZoom={1.2}
              minZoom={0.2}
              elevateNodesOnSelect={false}
              multiSelectionKeyCode={["Meta", "Control"]}
            >
              <Background
                color="var(--color-border-default)"
                gap={16}
                size={1}
                variant={BackgroundVariant.Dots}
              />
            </ReactFlow>
          </div>

          {/* Floating Connect Button */}
          {possibleConnection && selectedNodes.length === 2 && (
            <FloatingConnectButton
              nodeA={selectedNodes[0]}
              nodeB={selectedNodes[1]}
              onConnect={handleConnectSelected}
            />
          )}
        </div>

        {/* ---- Side Panes ---- */}
        {showSidePane && (
          <SidePane
            onClose={() => setSelectedNodeId(null)}
            onExecuteNode={onExecuteNode}
            onStopExecution={onStopExecution}
            tabId={tab.id}
          />
        )}

        {hasOpenedReconciliationGraphPane && (
          <ReconciliationGraphPane
            onClose={() => setShowReconciliationGraphPane(false)}
            tabId={tab.id}
            isOpen={showReconciliationGraphPane}
          />
        )}

        {/* Save Modal */}
        {showSaveModal && (
          <RustyTabSaveModal
            saveTitle={saveTitle}
            onTitleChange={setSaveTitle}
            onCancel={() => setShowSaveModal(false)}
            onConfirm={confirmSavePipeline}
          />
        )}
      </div>
    </CanvasTabContext.Provider>
  );
};

/* ================================================================ */
/*  Extracted Standalone Effects (registered via useEffect)          */
/* ================================================================ */

/**
 * Listens for VFS changes from TaskNode writes and removes affected
 * files from the reconciliation ledger so they can be re-reconciled.
 */
function registerVfsInvalidationEffect(
  tabId: string,
  rootPath: string
): () => void {
  const handleTaskVfsChange = (event: Event) => {
    const detail = (event as CustomEvent<VfsChangedDetail>).detail;
    if (
      !detail ||
      detail.tabId !== tabId ||
      !detail.nodeId ||
      detail.nodeId.startsWith("__reconciliation_node__:")
    )
      return;

    const currentContext = useWorkspaceStore.getState().canvasContexts[tabId];
    if (
      !currentContext?.nodes.some(
        (node: { type?: string; id: string }) =>
          node.type === "taskNode" && node.id === detail.nodeId
      )
    )
      return;

    const ledger = currentContext.reconciliationSnapshot?.ledger || {};
    const affected = (detail.paths || [])
      .map((filePath: string) => {
        try {
          return normalizeReconciliationPath(rootPath, filePath);
        } catch {
          return filePath;
        }
      })
      .filter(
        (filePath: string) =>
          !!ledger[filePath] ||
          currentContext.reconciliationSnapshot?.files?.includes(filePath)
      );

    if (affected.length === 0) return;

    void (async () => {
      await reconciliationService.removeFiles(tabId, affected);
      const latestContext =
        useWorkspaceStore.getState().canvasContexts[tabId];
      useWorkspaceStore
        .getState()
        .updateCanvasContext(tabId, {
          reconciliationSnapshot: withoutReconciliationFiles(
            latestContext?.reconciliationSnapshot,
            affected
          ),
          isPipelineApplied: false,
        });
      await canvasFileService.autoSaveCanvas(tabId);
    })().catch((err) =>
      console.error("[RustyTab] Failed to invalidate reconciled files:", err)
    );
  };

  window.addEventListener(VFS_CHANGED_EVENT, handleTaskVfsChange);
  return () => window.removeEventListener(VFS_CHANGED_EVENT, handleTaskVfsChange);
}

/**
 * Audits the reconciliation ledger on canvas mount and when TaskNode
 * state changes, removing stale entries whose source signature no
 * longer matches the current generated content.
 */
function registerReconciliationAuditEffect(
  tabId: string,
  rootPath: string,
  context: any,
  nodes: any[]
): () => void {
  const snapshot = context.reconciliationSnapshot;
  if (!snapshot || snapshot.files.length === 0) return () => {};

  const taskFileRecords = buildReconciliationTaskFileRecords(
    rootPath,
    nodes
      .filter((node: { type?: string }) => node.type === "taskNode")
      .map((node: { id: string; data?: { modifiedFiles?: string[]; generatedFileContents?: Record<string, string> } }) => ({
        id: node.id,
        modifiedFiles: Array.isArray(node.data?.modifiedFiles)
          ? (node.data.modifiedFiles as string[])
          : [],
        generatedFileContents:
          (node.data?.generatedFileContents as Record<string, string>) || {},
      })),
    snapshot.files
  );

  const ledger = snapshot.ledger || {};
  const invalidFiles = snapshot.files.filter(
    (filePath: string) =>
      !ledger[filePath] ||
      !taskFileRecords[filePath] ||
      ledger[filePath].sourceSignature !== taskFileRecords[filePath].sourceSignature
  );

  if (invalidFiles.length === 0) return () => {};

  void (async () => {
    await reconciliationService.removeFiles(tabId, invalidFiles);
    const latest =
      useWorkspaceStore.getState().canvasContexts[tabId]
        ?.reconciliationSnapshot;
    useWorkspaceStore
      .getState()
      .updateCanvasContext(tabId, {
        reconciliationSnapshot: withoutReconciliationFiles(latest, invalidFiles),
        isPipelineApplied: false,
      });
    await canvasFileService.autoSaveCanvas(tabId);
  })().catch((err) =>
    console.error("[RustyTab] Failed to audit reconciliation ledger:", err)
  );

  return () => {};
}

/**
 * Listens for CANVAS_NODE_FOCUS_EVENT and animates the viewport to
 * center on the target node.
 */
function registerNodeFocusEffect(
  tabId: string,
  nodes: any[],
  rfInstance: any
): () => void {
  const handleNodeFocus = (event: Event) => {
    const detail = (event as CustomEvent<CanvasNodeFocusDetail>).detail;
    if (detail?.tabId !== tabId || !rfInstance) return;
    const targetNode = nodes.find((node: { id: string }) => node.id === detail.nodeId);
    if (!targetNode) return;
    void rfInstance.fitView({
      nodes: [targetNode],
      padding: targetNode.type === "boundaryNode" ? 0.18 : 0.4,
      minZoom: 0.15,
      maxZoom: 1.2,
      duration: 450,
    });
  };

  window.addEventListener(CANVAS_NODE_FOCUS_EVENT, handleNodeFocus);
  return () =>
    window.removeEventListener(CANVAS_NODE_FOCUS_EVENT, handleNodeFocus);
}

/**
 * Registers keyboard shortcuts for undo (Cmd+Z / Ctrl+Z) and redo
 * (Cmd+Shift+Z / Ctrl+Shift+Z) on the canvas.
 */
function registerUndoRedoShortcut(tabId: string): () => void {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!e.metaKey && !e.ctrlKey) return;
    if (e.key !== "z" && e.key !== "Z") return;

    // Don't intercept when typing in input fields
    const active = document.activeElement as HTMLElement | null;
    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable)
    )
      return;

    e.preventDefault();
    if (e.shiftKey) {
      useWorkspaceStore.getState().redoCanvasTab(tabId);
    } else {
      useWorkspaceStore.getState().undoCanvasTab(tabId);
    }
  };

  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
}

/* ================================================================ */
/*  Extracted Helper Functions                                       */
/* ================================================================ */

/**
 * Builds a list of TaskNodeRecord objects from the canvas nodes array,
 * suitable for passing to reconciliation helpers.
 */
function buildTaskNodeRecords(nodes: any[]): TaskNodeRecord[] {
  return nodes
    .filter((node: { type?: string }) => node.type === "taskNode")
    .map((node: { id: string; data?: { modifiedFiles?: string[]; generatedFileContents?: Record<string, string> } }) => ({
      id: node.id,
      modifiedFiles: Array.isArray(node.data?.modifiedFiles)
        ? (node.data.modifiedFiles as string[])
        : [],
      generatedFileContents:
        (node.data?.generatedFileContents as Record<string, string>) || {},
    }));
}

/**
 * Extracts store action creators into a single memoized object so they
 * can be passed to child components without repetitive selectors.
 */
function useStoreActions() {
  const addContextNode = useWorkspaceStore((state) => state.addContextNode);
  const addTaskNode = useWorkspaceStore((state) => state.addTaskNode);
  const addGlobalChatNode = useWorkspaceStore((state) => state.addGlobalChatNode);
  const addMcpNode = useWorkspaceStore((state) => state.addMcpNode);
  const addStickyNode = useWorkspaceStore((state) => state.addStickyNode);
  const addBoundaryNode = useWorkspaceStore((state) => state.addBoundaryNode);

  return useMemo(
    () => ({
      addContextNode,
      addTaskNode,
      addGlobalChatNode,
      addMcpNode,
      addStickyNode,
      addBoundaryNode,
    }),
    [
      addContextNode,
      addTaskNode,
      addGlobalChatNode,
      addMcpNode,
      addStickyNode,
      addBoundaryNode,
    ]
  );
}

/* ================================================================ */
/*  Floating Connect Button                                          */
/* ================================================================ */

/**
 * A floating button that appears between two selected nodes, allowing
 * the user to create a connection with a single click.
 *
 * Uses `useViewport` to position itself accurately in screen space.
 */
const FloatingConnectButton: React.FC<{
  nodeA: any;
  nodeB: any;
  onConnect: () => void;
}> = ({ nodeA, nodeB, onConnect }) => {
  const { x: viewportX, y: viewportY, zoom } = useViewport();

  const centerA = getNodeCenterLocal(nodeA);
  const centerB = getNodeCenterLocal(nodeB);
  const midX = (centerA.x + centerB.x) / 2;
  const midY = (centerA.y + centerB.y) / 2;

  const left = midX * zoom + viewportX;
  const top = midY * zoom + viewportY;

  return (
    <button
      onClick={onConnect}
      style={{
        position: "absolute",
        left: `${left}px`,
        top: `${top}px`,
        transform: "translate(-50%, -50%)",
        zIndex: 1000,
      }}
      className="bg-[var(--accent-color)] hover:bg-[var(--accent-color)]/90 text-[var(--color-primary-foreground)] rounded-full p-3 shadow-2xl border border-[var(--border-color)] cursor-pointer flex items-center justify-center transition-all hover:scale-110 active:scale-95 duration-200"
      title="Connect nodes"
    >
      <Link2 size={18} />
    </button>
  );
};

/**
 * Computes the visual center of a node, using measured dimensions
 * or sensible defaults for each node type.
 */
function getNodeCenterLocal(node: any): { x: number; y: number } {
  const defaults: Record<string, { width: number; height: number }> = {
    taskNode: { width: 320, height: 120 },
    default: { width: 288, height: 120 },
  };
  const typeDefaults = defaults[node.type] || defaults.default;
  const width = node.measured?.width ?? typeDefaults.width;
  const height = node.measured?.height ?? typeDefaults.height;
  return {
    x: node.position.x + width / 2,
    y: node.position.y + height / 2,
  };
}
