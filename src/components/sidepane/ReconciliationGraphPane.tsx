import React, { useState, useEffect, useRef, useMemo } from "react";
import { GitMerge, Play, Loader2, FileCode, MessageSquare, X, Send, AlertTriangle, Maximize2, Minimize2, Terminal, Octagon, RotateCcw, Folder, Trash2, CheckCircle2, CircleDashed, Hammer, XCircle } from "lucide-react";
import { useWorkspaceStore } from "../../store";
import { VfsRegistry, VFS_CHANGED_EVENT, type VfsChangedDetail } from "../../services/vfs";
import { notify } from "../../notificationStore";
import { PRDiffView } from "./components/PRDiffView";
import type { TaskVersion } from "./components/PRDiffView";
import { useResizable } from "./useResizable";
import { CustomSelect } from "../CustomSelect";
import { queryDuplicateTrackedFiles } from "../../services/vfs/orchestrators/queryOrchestrator";
import { processResponse } from "../../services/responseProcessingService";
import { ConsoleTabContent } from "./components/ConsoleTabContent";
import { AgentActivityCard } from "../ui/SubagentActivityPanel";
import { useConfirm } from "../useConfirm";
import { reconciliationService, withoutReconciliationFiles } from "../../services/reconciliationService";
import { buildReconciliationTaskFileRecords, normalizeReconciliationPath } from "../../services/reconciliationPaths";
import { useSelectableModels } from "../../hooks/useSelectableModels";
import { resolveExecutionProvider } from "../../store/resolveExecutionProvider";
import { VfsExplorer } from "./components/VfsExplorer";
import type { ReconciliationLedgerEntry, ReconciliationSnapshot } from "../../store/types";
import { invoke } from "@tauri-apps/api/core";
import { createAgentHarnessSocket } from "../../services/agentHarnessClient";
import { TokenBadge, TokenUsageLike } from "../ui/TokenBadge/TokenBadge";


interface ReconciliationGraphPaneProps {
  onClose: () => void;
  tabId: string;
  isOpen?: boolean;
}

const getReconciliationStreamId = (tabId: string) => `__reconciliation__:${tabId}`;
const EMPTY_RECONCILIATION_LOGS: string[] = [];

export const ReconciliationGraphPane: React.FC<ReconciliationGraphPaneProps> = ({ onClose, tabId, isOpen = true }) => {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const activeModel = useWorkspaceStore((state) => state.activeModel);
  const customProviders = useWorkspaceStore((state) => state.customProviders);
  const activeCustomProviderId = useWorkspaceStore((state) => state.activeCustomProviderId);
  const providerStatus = useWorkspaceStore((state) => state.providerStatus);

  // Resize hook
  const { width, containerRef, startResizing } = useResizable(500, "reconciliation_graph_pane_width");

  // States
  const [selectedModel, setSelectedModel] = useState(activeModel || "");
  const [activeTab, setActiveTab] = useState<"overview" | "chat" | "console" | "files" | "vfs">("overview");
  const [isReconciling, setIsReconciling] = useState(false);
  const [runUsage, setRunUsage] = useState<TokenUsageLike | null>(null);
  const [chatMessages, setChatMessages] = useState<{ role: string; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isMaximized, setIsMaximized] = useState(false);
  const [duplicateFiles, setDuplicateFiles] = useState<Record<string, string[]>>({});
  const [isResetting, setIsResetting] = useState(false);
  const [reconciledFiles, setReconciledFiles] = useState<string[]>([]);
  const [reconciliationRevision, setReconciliationRevision] = useState(0);
  const [chatFilePath, setChatFilePath] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [buildCommand, setBuildCommand] = useState(() => localStorage.getItem(`rusty_build_command_${tabId}`) || "");
  const testSocketRef = useRef<WebSocket | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const { confirm, ConfirmModalComponent } = useConfirm();
  const reconciliationStreamId = getReconciliationStreamId(tabId);
  const reconciliationNodeId = reconciliationService.getNodeId(tabId);
  const reconciliationSnapshot = useWorkspaceStore(
    (state) => state.canvasContexts[tabId]?.reconciliationSnapshot
  );
  const reconciliationLogs = useWorkspaceStore(
    (state) => state.canvasContexts[tabId]?.nodeLogs[reconciliationStreamId] ?? EMPTY_RECONCILIATION_LOGS
  );
  const addConsoleLog = (message: string) => useWorkspaceStore.getState().addLog(reconciliationStreamId, message);
  const clearConsoleLog = () => useWorkspaceStore.getState().clearLogs(reconciliationStreamId);
  const setConsoleStatus = (status: "idle" | "running" | "success" | "error") => {
    useWorkspaceStore.getState().setNodeStatus(reconciliationStreamId, status);
  };

  // Resolve canvas context task nodes
  const canvasNodes = useWorkspaceStore((state) => state.canvasContexts[tabId]?.nodes || []);
  const taskNodes = useMemo(() => canvasNodes.filter((n) => n.type === "taskNode"), [canvasNodes]);
  const globalChatHistory = useWorkspaceStore((state) => state.canvasContexts[tabId]?.globalChatHistory || {});

  const formattedNodes = useMemo(() => {
    return taskNodes.map((node) => ({
      id: node.id,
      name: node.data?.name || "Unnamed Task",
      prompt: node.data?.prompt || "",
      chatHistory: globalChatHistory[node.id] || [],
      modifiedFiles: (node.data?.modifiedFiles as string[]) || [],
      originalFileContents: (node.data?.originalFileContents as Record<string, string>) || {},
      generatedFileContents: (node.data?.generatedFileContents as Record<string, string>) || {},
    }));
  }, [taskNodes, globalChatHistory]);

  const taskFileRecords = useMemo(() => {
    return buildReconciliationTaskFileRecords(rootPath, formattedNodes, reconciliationSnapshot?.files || []);
  }, [formattedNodes, reconciliationSnapshot?.files, rootPath]);

  const taskModifiedFiles = useMemo(
    () => Object.keys(taskFileRecords),
    [taskFileRecords],
  );

  // Per-file task versions used by PRDiffView for attribution decorations
  const taskVersionsPerFile = useMemo<Record<string, TaskVersion[]>>(() => {
    const result: Record<string, TaskVersion[]> = {};
    for (const [filePath, entry] of Object.entries(
      reconciliationSnapshot?.ledger || {}
    )) {
      if (entry.status !== "reconciled" || !entry.taskIds?.length) continue;
      const versions = formattedNodes
        .filter((n) => entry.taskIds.includes(n.id))
        .flatMap((n) => {
          const contentEntry = Object.entries(n.generatedFileContents).find(
            ([candidate]) => {
              try {
                return normalizeReconciliationPath(rootPath, candidate) === filePath;
              } catch {
                return candidate === filePath;
              }
            }
          );
          if (!contentEntry?.[1]) return [];
          return [{ taskId: n.id, taskName: String(n.name || n.id), content: contentEntry[1] }];
        });
      if (versions.length) result[filePath] = versions;
    }
    return result;
  }, [reconciliationSnapshot?.ledger, formattedNodes, rootPath]);

  const reconciliationLedger = useMemo<Record<string, ReconciliationLedgerEntry>>(() => {
    if (reconciliationSnapshot?.ledger) return reconciliationSnapshot.ledger;
    return Object.fromEntries((reconciliationSnapshot?.files || []).map((filePath) => [filePath, {
      path: filePath,
      status: "reconciled" as const,
      sourceSignature: taskFileRecords[filePath]?.sourceSignature || "legacy",
      taskIds: taskFileRecords[filePath]?.taskIds || [],
      updatedAt: reconciliationSnapshot?.updatedAt || new Date(0).toISOString(),
    }]));
  }, [reconciliationSnapshot, taskFileRecords]);

  const pendingDuplicateFiles = useMemo(() => Object.fromEntries(
    Object.entries(duplicateFiles).filter(([filePath]) => {
      const entry = reconciliationLedger[filePath];
      return entry?.status !== "reconciled" || entry.sourceSignature !== taskFileRecords[filePath]?.sourceSignature;
    }),
  ), [duplicateFiles, reconciliationLedger, taskFileRecords]);

  useEffect(() => {
    const collisionPaths = Object.keys(duplicateFiles);
    if (!chatFilePath || !duplicateFiles[chatFilePath]) {
      setChatFilePath(collisionPaths[0] || "");
    }
  }, [chatFilePath, duplicateFiles]);

  // Load duplicates from VFS
  const loadDuplicates = async () => {
    try {
      const dups = await queryDuplicateTrackedFiles(tabId, rootPath);
      setDuplicateFiles(dups);
    } catch (err) {
      console.error("[ReconciliationGraphPane] Failed to query duplicates:", err);
    }
  };

  useEffect(() => {
    loadDuplicates();
  }, [rootPath, tabId, taskModifiedFiles.join(",")]);

  // Sync scroll on chat messages update
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const saveChatHistory = (messages: { role: string; content: string }[]) => {
    const canvasContext = useWorkspaceStore.getState().canvasContexts[tabId];
    if (canvasContext) {
      const globalChat = canvasContext.globalChatHistory || {};
      const formatMessages = messages.map((m, idx) => ({
        id: `recon-${idx}`,
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
        timestamp: new Date().toISOString()
      }));
      useWorkspaceStore.getState().updateCanvasContext(tabId, {
        globalChatHistory: {
          ...globalChat,
          "__reconciliation__": formatMessages
        }
      });
      import("../tabs/canvas/services/canvasFileService").then(({ canvasFileService }) => {
        canvasFileService.autoSaveCanvas(tabId);
      }).catch(err => console.error("Failed to auto-save canvas:", err));
    }
  };

  const appendChatMessage = (message: { role: string; content: string }) => {
    setChatMessages((prev) => {
      const updated = [...prev, message];
      saveChatHistory(updated);
      return updated;
    });
  };

  const ensureReconciliationSnapshot = async (
    filePaths: string[],
    records = taskFileRecords,
  ): Promise<boolean> => {
    const existing = useWorkspaceStore.getState().canvasContexts[tabId]?.reconciliationSnapshot;
    try {
      const vfs = VfsRegistry.getOrCreate(tabId);
      const originalFileContents = { ...(existing?.originalFileContents || {}) };
      for (const filePath of filePaths) {
        if (originalFileContents[filePath] !== undefined) continue;
        originalFileContents[filePath] = await vfs.readFile(records[filePath]?.sourcePath || filePath);
      }

      useWorkspaceStore.getState().updateCanvasContext(tabId, {
        reconciliationSnapshot: {
          files: existing?.files || [],
          originalFileContents,
          generatedFileContents: existing?.generatedFileContents || {},
          ledger: existing?.ledger || reconciliationLedger,
          updatedAt: new Date().toISOString(),
          response: existing?.response,
        },
      });
      return true;
    } catch (err: any) {
      console.error("[ReconciliationGraph] Failed to snapshot the pre-reconciliation VFS:", err);
      notify("Reconciliation Not Started", err.message || String(err), "error");
      return false;
    }
  };

  const removeLedgerFiles = async (filePaths: string[]) => {
    if (filePaths.length === 0) return;
    await reconciliationService.removeFiles(tabId, filePaths);
    const snapshot = useWorkspaceStore.getState().canvasContexts[tabId]?.reconciliationSnapshot;
    if (!snapshot) return;
    const removed = new Set(filePaths);
    const ledger = { ...(snapshot.ledger || reconciliationLedger) };
    const generatedFileContents = { ...snapshot.generatedFileContents };
    for (const filePath of removed) {
      delete ledger[filePath];
      delete generatedFileContents[filePath];
    }
    const nextSnapshot: ReconciliationSnapshot = {
      ...snapshot,
      files: snapshot.files.filter((filePath) => !removed.has(filePath)),
      generatedFileContents,
      ledger,
      updatedAt: new Date().toISOString(),
    };
    useWorkspaceStore.getState().updateCanvasContext(tabId, {
      reconciliationSnapshot: nextSnapshot,
      isPipelineApplied: false,
    });
    setReconciledFiles(nextSnapshot.files);
    setReconciliationRevision((revision) => revision + 1);
  };

  const synchronizeLedger = async (currentDuplicates: Record<string, string[]>): Promise<Record<string, string[]>> => {
    const ownerFiles = new Set(await reconciliationService.getFiles(tabId));
    const invalidFiles = Object.values(reconciliationLedger)
      .filter((entry) => (
        !currentDuplicates[entry.path] ||
        entry.sourceSignature !== taskFileRecords[entry.path]?.sourceSignature ||
        (entry.status === "reconciled" && !ownerFiles.has(entry.path))
      ))
      .map((entry) => entry.path);
    if (invalidFiles.length > 0) await removeLedgerFiles(invalidFiles);

    const invalid = new Set(invalidFiles);
    return Object.fromEntries(Object.entries(currentDuplicates).filter(([filePath]) => {
      const entry = invalid.has(filePath) ? undefined : reconciliationLedger[filePath];
      return entry?.status !== "reconciled" || entry.sourceSignature !== taskFileRecords[filePath]?.sourceSignature;
    }));
  };

  const handleResetReconciliation = async () => {
    const snapshot = useWorkspaceStore.getState().canvasContexts[tabId]?.reconciliationSnapshot;
    if (!snapshot || Object.keys(reconciliationLedger).length === 0 || isReconciling || isResetting) return;

    const confirmed = await confirm({
      title: "Reset reconciliation?",
      message: `Restore ${snapshot.files.length} task-owned file${snapshot.files.length === 1 ? "" : "s"} to their pre-reconciliation VFS versions? TaskNode ownership and snapshots will remain intact.`,
      confirmLabel: "Reset",
      kind: "warning",
    });
    if (!confirmed) return;

    setIsResetting(true);
    try {
      const vfs = VfsRegistry.getOrCreate(tabId);
      for (const filePath of snapshot.files) {
        const content = snapshot.originalFileContents[filePath];
        if (content !== undefined) await vfs.writeFile(filePath, content);
      }
      await reconciliationService.setFiles(tabId, []);
      useWorkspaceStore.getState().updateCanvasContext(tabId, {
        reconciliationSnapshot: undefined,
        isPipelineApplied: false,
      });
      setReconciledFiles([]);
      setReconciliationRevision((revision) => revision + 1);
      appendChatMessage({
        role: "system",
        content: "Reconciliation reset. Restored the pre-reconciliation VFS contents; TaskNode files and ownership were left in place.",
      });
      notify("Reconciliation Reset", "Pre-reconciliation VFS contents restored. You can run reconciliation again.", "success");
    } catch (err: any) {
      console.error("[ReconciliationGraph] Reset failed:", err);
      notify("Reset Failed", err.message || String(err), "error");
    } finally {
      setIsResetting(false);
    }
  };

  const handleReconciledFileSaved = async (filePath: string) => {
    const content = await VfsRegistry.getOrCreate(tabId).readFile(filePath);
    const snapshot = useWorkspaceStore.getState().canvasContexts[tabId]?.reconciliationSnapshot;
    if (!snapshot) return;
    useWorkspaceStore.getState().updateCanvasContext(tabId, {
      reconciliationSnapshot: {
        ...snapshot,
        generatedFileContents: { ...snapshot.generatedFileContents, [filePath]: content },
        updatedAt: new Date().toISOString(),
      },
      isPipelineApplied: false,
    });
  };


  const handleRemoveReconciledFile = async (filePath: string) => {
    if (isReconciling || isResetting) return;
    const confirmed = await confirm({
      title: "Remove reconciliation result?",
      message: `${filePath.split(/[\\/]/).pop() || filePath} will return to Pending and must be reconciled again before Apply Rusty. Its TaskNode-owned VFS versions remain available.`,
      confirmLabel: "Remove",
      kind: "warning",
    });
    if (!confirmed) return;
    try {
      await removeLedgerFiles([filePath]);
      notify("Reconciliation Removed", "The file is pending reconciliation again.", "success");
      void import("../tabs/canvas/services/canvasFileService")
        .then(({ canvasFileService }) => canvasFileService.autoSaveCanvas(tabId));
    } catch (err: any) {
      notify("Removal Failed", err.message || String(err), "error");
    }
  };

  const handleStopReconciliation = () => {
    addConsoleLog("Stop requested by user.");
    setConsoleStatus("idle");
    if (socketRef.current) {
      if (socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "agent_chat_stop", tabId: reconciliationStreamId }));
      }
      socketRef.current.close(1000, "User requested stop");
      socketRef.current = null;
    }
    setIsReconciling(false);
    appendChatMessage({ role: "system", content: "Reconciliation stopped by user." });
  };

  useEffect(() => {
    const globalChat = useWorkspaceStore.getState().canvasContexts[tabId]?.globalChatHistory || {};
    const storedMessages = globalChat["__reconciliation__"] || [];
    setChatMessages(storedMessages.map(m => ({ role: m.role, content: m.content })));
    void reconciliationService.getFiles(tabId).then(setReconciledFiles).catch((err) => {
      console.error("[ReconciliationGraph] Failed to load reconciliation-owned files:", err);
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.close(1000, "Pane unmounted");
      }
    };
  }, [tabId]);

  useEffect(() => {
    const handleVfsChanged = (event: Event) => {
      const detail = (event as CustomEvent<VfsChangedDetail>).detail;
      if (detail?.tabId !== tabId) return;
      void reconciliationService.getFiles(tabId).then((files) => {
        setReconciledFiles(files);
        if (detail.nodeId === reconciliationNodeId || detail.operation === "restore") {
          setReconciliationRevision((revision) => revision + 1);
        }
        if (detail.nodeId === reconciliationNodeId && (detail.operation === "remove" || detail.operation === "delete-node")) {
          const snapshot = useWorkspaceStore.getState().canvasContexts[tabId]?.reconciliationSnapshot;
          const missing = (snapshot?.files || []).filter((filePath) => !files.includes(filePath));
          if (missing.length > 0) {
            useWorkspaceStore.getState().updateCanvasContext(tabId, {
              reconciliationSnapshot: withoutReconciliationFiles(snapshot, missing, { preserveOriginal: true }),
              isPipelineApplied: false,
            });
          }
        }
      }).catch((err) => console.error("[ReconciliationGraph] Failed to refresh reconciliation-owned files:", err));
    };
    window.addEventListener(VFS_CHANGED_EVENT, handleVfsChanged);
    return () => window.removeEventListener(VFS_CHANGED_EVENT, handleVfsChanged);
  }, [reconciliationNodeId, tabId]);

  const startReconciliation = async (userMsgText?: string, onlyFilePath?: string) => {
    if (isReconciling || isResetting) return;
    let currentDuplicates: Record<string, string[]>;
    try {
      currentDuplicates = await queryDuplicateTrackedFiles(tabId, rootPath);
      setDuplicateFiles(currentDuplicates);
    } catch (err: any) {
      notify("Reconciliation Not Started", err.message || String(err), "error");
      return;
    }
    const synchronizedFiles = await synchronizeLedger(currentDuplicates);
    const requestedFilePath = onlyFilePath || (userMsgText ? chatFilePath : "");
    // A follow-up is an explicit request to review an already reconciled file
    // again. Normal Reconcile runs continue to process pending files only.
    const filesToReconcile = requestedFilePath
      ? (currentDuplicates[requestedFilePath] ? { [requestedFilePath]: currentDuplicates[requestedFilePath] } : {})
      : synchronizedFiles;
    const pendingPaths = Object.keys(filesToReconcile);
    if (pendingPaths.length === 0) {
      notify(
        "Reconciliation Up to Date",
        currentDuplicates && Object.keys(currentDuplicates).length > 0
          ? "All currently overlapping files are already reconciled."
          : "No files currently require reconciliation.",
        "success",
      );
      return;
    }
    const currentOwnerFiles = await reconciliationService.getFiles(tabId);
    const runTaskFileRecords = buildReconciliationTaskFileRecords(rootPath, formattedNodes, currentOwnerFiles);
    const runFileSources = Object.fromEntries(
      Object.values(runTaskFileRecords).map(({ path, sourcePath }) => [path, sourcePath]),
    );
    if (!(await ensureReconciliationSnapshot(pendingPaths, runTaskFileRecords))) return;
    setIsReconciling(true);
    setRunUsage(null);
    if (!userMsgText) {
      clearConsoleLog();
    }
    setConsoleStatus("running");
    addConsoleLog(userMsgText ? "Sending reconciliation follow-up message..." : "Starting graph reconciliation...");

    let nextMessages = [...chatMessages];
    if (userMsgText) {
      nextMessages.push({ role: "user", content: userMsgText });
      setChatMessages(nextMessages);
      saveChatHistory(nextMessages);
    } else {
      nextMessages = [{ role: "system", content: "Checking duplicate file changes across tasks..." }];
      setChatMessages(nextMessages);
      saveChatHistory(nextMessages);
      setActiveTab("console");
    }

    let socket: WebSocket;
    try {
      socket = createAgentHarnessSocket();
      socketRef.current = socket;
    } catch (err: any) {
      console.error("Failed to construct WebSocket:", err);
      addConsoleLog(`Connection failed: ${err.message || String(err)}`);
      setConsoleStatus("error");
      appendChatMessage({ role: "system", content: `Connection failed: ${err.message || String(err)}` });
      setIsReconciling(false);
      return;
    }

    socket.onopen = () => {
      const resolution = resolveExecutionProvider(customProviders, providerStatus, activeCustomProviderId, selectedModel);
      if (!resolution.ok) {
        addConsoleLog(resolution.message);
        setConsoleStatus("error");
        appendChatMessage({ role: "system", content: resolution.message });
        setIsReconciling(false);
        notify("Cannot reconcile", resolution.message, "error");
        socket.close();
        return;
      }
      const provider = resolution.provider;
      addConsoleLog(userMsgText
        ? `Connected to sidecar. Asking the model to adjust ${pendingPaths[0]}.`
        : `Connected to sidecar. Dispatching ${pendingPaths.length} pending collision case${pendingPaths.length === 1 ? "" : "s"}; completed ledger entries are skipped.`);

      socket.send(
        JSON.stringify({
          type: "reconciliate_graph",
          tabId,
          model: selectedModel,
          nodes: formattedNodes,
          workspaceRoot: rootPath,
          duplicateFiles: filesToReconcile,
          fileSources: runFileSources,
          chatHistory: nextMessages.map(m => ({ role: m.role, content: m.content })),
          userMessage: userMsgText || "",
          customProvider: provider,
        })
      );
    };

    let messageQueue = Promise.resolve();
    socket.onmessage = (event) => {
      // Ledger updates must be committed in wire order. Without this queue,
      // several async per-file messages can read and overwrite the same
      // snapshot concurrently.
      messageQueue = messageQueue.then(async () => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "log") {
          addConsoleLog(msg.message);
          return;
        }

        if (msg.type === "usage_update" && msg.nodeId === reconciliationStreamId) {
          setRunUsage(msg.usage);
          return;
        }

        if (msg.type === "read_file") {
          console.log(`[ReconciliateGraph] Sidecar reading file: ${msg.path}`);
          VfsRegistry.getOrCreate(tabId).readFile(msg.path)
            .then((content) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "read_file_response", requestId: msg.requestId, content }));
              }
            })
            .catch((err) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "read_file_response", requestId: msg.requestId, error: err.message || String(err) }));
              }
            });
          return;
        }

        if (msg.type === "write_file") {
          console.log(`[ReconciliateGraph] Sidecar writing file: ${msg.path}`);
          VfsRegistry.getOrCreate(tabId).writeFile(
            msg.path,
            msg.content,
            reconciliationNodeId
          )
            .then(() => {
              useWorkspaceStore.getState().updateCanvasContext(tabId, { isPipelineApplied: false });
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "write_file_response", requestId: msg.requestId }));
              }
            })
            .catch((err) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "write_file_response", requestId: msg.requestId, error: err.message || String(err) }));
              }
            });
          return;
        }

        if (msg.type === "reconciliation_file_complete") {
          const filePath = String(msg.filePath || "");
          if (!filePath) return;
          const content = await VfsRegistry.getOrCreate(tabId).readFile(filePath);
          const currentSnapshot = useWorkspaceStore.getState().canvasContexts[tabId]?.reconciliationSnapshot;
          if (!currentSnapshot) throw new Error("The reconciliation snapshot is missing.");
          const ledger = { ...(currentSnapshot.ledger || reconciliationLedger) };
          ledger[filePath] = {
            path: filePath,
            status: "reconciled",
            sourceSignature: taskFileRecords[filePath]?.sourceSignature || "unknown",
            taskIds: Array.isArray(msg.taskIds) ? msg.taskIds : taskFileRecords[filePath]?.taskIds || [],
            updatedAt: new Date().toISOString(),
            modified: !!msg.modified,
            method: "model",
            response: msg.response || undefined,
          };
          const files = Array.from(new Set([...currentSnapshot.files, filePath]));
          useWorkspaceStore.getState().updateCanvasContext(tabId, {
            reconciliationSnapshot: {
              ...currentSnapshot,
              files,
              generatedFileContents: {
                ...currentSnapshot.generatedFileContents,
                [filePath]: content,
              },
              ledger,
              updatedAt: new Date().toISOString(),
            },
            isPipelineApplied: false,
          });
          setReconciledFiles(files);
          setReconciliationRevision((revision) => revision + 1);
          addConsoleLog(`Ledger recorded: ${filePath}`);
          void import("../tabs/canvas/services/canvasFileService")
            .then(({ canvasFileService }) => canvasFileService.autoSaveCanvas(tabId));
          return;
        }

        if (msg.type === "reconciliation_file_error") {
          const filePath = String(msg.filePath || "");
          if (!filePath) return;
          await reconciliationService.removeFiles(tabId, [filePath]);
          const currentSnapshot = useWorkspaceStore.getState().canvasContexts[tabId]?.reconciliationSnapshot;
          if (currentSnapshot) {
            const ledger = { ...(currentSnapshot.ledger || reconciliationLedger) };
            ledger[filePath] = {
              path: filePath,
              status: "error",
              sourceSignature: taskFileRecords[filePath]?.sourceSignature || "unknown",
              taskIds: Array.isArray(msg.taskIds) ? msg.taskIds : taskFileRecords[filePath]?.taskIds || [],
              updatedAt: new Date().toISOString(),
              error: msg.error || "Unknown reconciliation error",
            };
            const generatedFileContents = { ...currentSnapshot.generatedFileContents };
            delete generatedFileContents[filePath];
            const files = currentSnapshot.files.filter((candidate) => candidate !== filePath);
            useWorkspaceStore.getState().updateCanvasContext(tabId, {
              reconciliationSnapshot: {
                ...currentSnapshot,
                files,
                generatedFileContents,
                ledger,
                updatedAt: new Date().toISOString(),
              },
              isPipelineApplied: false,
            });
            setReconciledFiles(files);
          }
          addConsoleLog(`Ledger error for ${filePath}: ${msg.error}`);
          void import("../tabs/canvas/services/canvasFileService")
            .then(({ canvasFileService }) => canvasFileService.autoSaveCanvas(tabId));
          return;
        }

        if (msg.type === "reconciliation_graph_complete") {
          const completedThisRun = Array.isArray(msg.reconciledFiles) ? msg.reconciledFiles : [];
          const currentSnapshot = useWorkspaceStore.getState().canvasContexts[tabId]?.reconciliationSnapshot;
          if (currentSnapshot) {
            useWorkspaceStore.getState().updateCanvasContext(tabId, {
              reconciliationSnapshot: {
                ...currentSnapshot,
                response: msg.response || "Reconciliation complete.",
                updatedAt: new Date().toISOString(),
              },
              isPipelineApplied: false,
            });
          }
          const allReconciledFiles = await reconciliationService.getFiles(tabId);
          setReconciledFiles(allReconciledFiles);
          const finalizedCount = allReconciledFiles.length;
          const completedCount = completedThisRun.length;
          const modifiedCount = Array.isArray(msg.modifiedFiles) ? msg.modifiedFiles.length : 0;
          addConsoleLog(
            userMsgText
              ? `Adjustment complete for ${pendingPaths[0]}; ${finalizedCount} total reconciled file${finalizedCount === 1 ? "" : "s"} remain in the ledger.`
              : `Run complete: ${completedCount} pending collision case${completedCount === 1 ? "" : "s"} recorded; ${finalizedCount} total reconciled file${finalizedCount === 1 ? "" : "s"} in the ledger.`,
          );
          setConsoleStatus("success");
          appendChatMessage({ role: "assistant", content: msg.response || "Reconciliation complete." });
          setIsReconciling(false);
          notify(
            userMsgText ? "Reconciliation Adjustment Complete" : "Reconciliation Complete",
            userMsgText
              ? `${pendingPaths[0]?.split(/[\\/]/).pop() || "The selected file"} was reviewed again${modifiedCount > 0 ? " and updated" : ""}. You can continue chatting for more changes.`
              : `${completedCount} pending collision case${completedCount === 1 ? " was" : "s were"} processed${modifiedCount > 0 ? `; ${modifiedCount} required edits` : ""}. Ordinary changed files remain TaskNode-owned.`,
            "success"
          );
          void import("../tabs/canvas/services/canvasFileService")
            .then(({ canvasFileService }) => canvasFileService.autoSaveCanvas(tabId))
            .catch((err) => console.error("Failed to auto-save reconciliation VFS:", err));
          loadDuplicates();
          socket.close();
        }

        if (msg.type === "reconciliation_graph_error") {
          addConsoleLog(`Reconciliation stopped${msg.filePath ? ` at ${msg.filePath}` : ""}: ${msg.error}`);
          setConsoleStatus("error");
          appendChatMessage({ role: "assistant", content: `Error${msg.filePath ? ` in ${msg.filePath}` : ""}: ${msg.error}` });
          setIsReconciling(false);
          notify(
            "Reconciliation Stopped",
            msg.filePath
              ? `${msg.filePath.split(/[\\/]/).pop() || msg.filePath} remains in Error. Run reconciliation again to restart from that file.`
              : `Error aligning: ${msg.error}`,
            "error",
          );
          socket.close();
        }
      } catch (err: any) {
        console.error("[ReconciliationGraph] parse error:", err);
        addConsoleLog(`Message parse error: ${err.message || String(err)}`);
      }
      });
    };

    socket.onerror = (error) => {
      console.error("[ReconciliationGraph] WebSocket error:", error);
      addConsoleLog("WebSocket connection failed.");
      setConsoleStatus("error");
      appendChatMessage({ role: "system", content: "Error: WebSocket connection failed." });
      setIsReconciling(false);
    };

    socket.onclose = () => {
      const currentStatus = useWorkspaceStore.getState().canvasContexts[tabId]?.nodeStatus[reconciliationStreamId];
      if (currentStatus === "running") {
        addConsoleLog("Connection closed before reconciliation completed.");
        setConsoleStatus("error");
      }
      setIsReconciling(false);
    };
  };

  const handleStopTestBuild = () => {
    addConsoleLog("Test build stopped by user.");
    if (testSocketRef.current) {
      if (testSocketRef.current.readyState === WebSocket.OPEN) {
        testSocketRef.current.close(1000, "User requested stop");
      }
      testSocketRef.current = null;
    }
    setIsTesting(false);
  };

  const handleTestBuild = async () => {
    if (isReconciling || isResetting || isTesting) return;
    if (!buildCommand.trim()) {
      notify("Build Command Required", "Enter a build command (e.g. npm run build) before running a test build.", "info");
      return;
    }

    // Collect all files that should be applied: reconciled collisions + ordinary task-owned files
    const allApplyFiles = Array.from(new Set([...reconciledFiles, ...ordinaryChangedFiles]));
    if (!allApplyFiles.length) {
      notify("Nothing to Test", "No task-owned files are available to apply for a test build.", "info");
      return;
    }

    setIsTesting(true);
    setActiveTab("console");
    clearConsoleLog();
    addConsoleLog("Snapshotting disk state before test build...");

    const vfs = VfsRegistry.getOrCreate(tabId);

    // 1. Snapshot current disk content so we can restore afterwards
    const diskSnapshot: Record<string, string> = {};
    for (const filePath of allApplyFiles) {
      try {
        diskSnapshot[filePath] = await invoke<string>("read_file_disk", { path: filePath });
      } catch {
        diskSnapshot[filePath] = ""; // file not on disk yet
      }
    }

    // 2. Apply VFS to disk
    addConsoleLog(`Applying ${allApplyFiles.length} file(s) to disk for test...`);
    try {
      // Sync ordinary task files into VFS before applying
      for (const filePath of ordinaryChangedFiles) {
        const record = taskFileRecords[filePath];
        const sourcePath = record?.sourcePath || filePath;
        const content = record?.taskContent ?? await vfs.readFile(sourcePath);
        if (sourcePath !== filePath || content !== undefined) {
          await vfs.writeFile(filePath, content);
        }
      }
      await vfs.applyToDisk(allApplyFiles);
    } catch (err: any) {
      addConsoleLog(`Failed to apply files to disk: ${err.message}`);
      setIsTesting(false);
      notify("Test Build Failed", `Could not apply files to disk: ${err.message}`, "error");
      return;
    }

    let diskRestored = false;
    const restoreDisk = async (finalFiles?: Record<string, string>) => {
      diskRestored = true;
      // Update VFS and snapshot with model-fixed content (if any)
      if (finalFiles && Object.keys(finalFiles).length > 0) {
        const snapshot = useWorkspaceStore.getState().canvasContexts[tabId]?.reconciliationSnapshot;
        if (snapshot) {
          const updatedGenerated = { ...snapshot.generatedFileContents };
          for (const [filePath, content] of Object.entries(finalFiles)) {
            if (reconciledFiles.includes(filePath)) {
              updatedGenerated[filePath] = content;
              try { await vfs.writeFile(filePath, content, reconciliationNodeId); } catch { /* skip */ }
            }
          }
          useWorkspaceStore.getState().updateCanvasContext(tabId, {
            reconciliationSnapshot: { ...snapshot, generatedFileContents: updatedGenerated, updatedAt: new Date().toISOString() },
            isPipelineApplied: false,
          });
        }
      }
      // Restore disk
      addConsoleLog("Restoring disk to pre-test state...");
      for (const [filePath, content] of Object.entries(diskSnapshot)) {
        try {
          await invoke("write_file_disk", { path: filePath, content });
        } catch (err: any) {
          console.error(`[TestBuild] Failed to restore disk file ${filePath}:`, err);
        }
      }
      addConsoleLog("Disk restored.");
    };

    // 3. Open WebSocket and start test build
    let socket: WebSocket;
    try {
      socket = createAgentHarnessSocket();
      testSocketRef.current = socket;
    } catch (err: any) {
      await restoreDisk();
      setIsTesting(false);
      notify("Test Build Failed", `Connection error: ${err.message}`, "error");
      return;
    }

    const resolution = resolveExecutionProvider(customProviders, providerStatus, activeCustomProviderId, selectedModel);
    if (!resolution.ok) {
      await restoreDisk();
      setIsTesting(false);
      notify("Cannot test build", resolution.message, "error");
      socket.close();
      return;
    }
    const provider = resolution.provider;

    socket.onopen = () => {
      addConsoleLog(`Connected. Running: ${buildCommand}`);
      socket.send(JSON.stringify({
        type: "test_build",
        tabId,
        buildCommand,
        workspaceRoot: rootPath,
        reconciledFiles: allApplyFiles,
        model: selectedModel,
        customProvider: provider,
      }));
    };

    socket.onmessage = (event) => {
      void (async () => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "test_build_log") {
            addConsoleLog(msg.message);
            return;
          }

          if (msg.type === "test_build_iteration") {
            addConsoleLog(`\n=== Build attempt ${msg.attempt}/${msg.maxAttempts} ===`);
            return;
          }

          if (msg.type === "test_build_complete") {
            await restoreDisk(msg.finalFiles);
            setIsTesting(false);
            testSocketRef.current = null;
            socket.close();
            if (msg.success) {
              notify(
                "Test Build Passed",
                `Build succeeded after ${msg.attempts} attempt${msg.attempts === 1 ? "" : "s"}. Disk restored. You can now Apply Rusty to permanently write the working code.`,
                "success",
              );
            } else {
              notify(
                "Test Build Failed",
                `Build did not pass after ${msg.attempts} attempts. Model's best attempt is saved in the VFS. Check console for details.`,
                "error",
              );
            }
            return;
          }

          if (msg.type === "test_build_error") {
            addConsoleLog(`Error: ${msg.error}`);
            await restoreDisk();
            setIsTesting(false);
            testSocketRef.current = null;
            socket.close();
            notify("Test Build Error", msg.error, "error");
            return;
          }
        } catch (err: any) {
          console.error("[TestBuild] Message parse error:", err);
        }
      })();
    };

    socket.onerror = () => {
      addConsoleLog("WebSocket connection failed.");
      void restoreDisk().then(() => setIsTesting(false));
    };

    socket.onclose = () => {
      if (!diskRestored) {
        addConsoleLog("Test build stopped. Restoring disk...");
        void restoreDisk().then(() => {
          addConsoleLog("Disk restored.");
          setIsTesting(false);
          notify("Test Build Stopped", "Disk has been restored to its pre-test state.", "info");
        });
      } else {
        setIsTesting(false);
      }
    };
  };

  const handleSendChat = () => {
    if (!chatInput.trim() || isReconciling || !chatFilePath) return;
    const text = chatInput.trim();
    setChatInput("");
    void startReconciliation(text, chatFilePath);
  };

  // Was: a hand-rolled Set of bare model ids used as both id AND name --
  // the one picker in the app that lost provider disambiguation entirely,
  // and (via its own useMemo) the only one that memoized before this hook
  // existed (REFACTOR_PLAN.md PR 3c).
  const { options: modelOptions, unauthenticatedProviders } = useSelectableModels(
    customProviders,
    providerStatus,
    activeCustomProviderId,
  );

  useEffect(() => {
    if (modelOptions.some((option) => option.id === selectedModel)) return;
    const fallback = modelOptions.some((option) => option.id === activeModel) ? activeModel : modelOptions[0]?.id || "";
    setSelectedModel(fallback);
  }, [activeModel, modelOptions, selectedModel]);

  const duplicateFilesEntries = Object.entries(duplicateFiles);
  const duplicatePathSet = new Set(Object.keys(duplicateFiles));
  const ordinaryChangedFiles = taskModifiedFiles.filter((filePath) => !duplicatePathSet.has(filePath));
  const pendingCount = Object.keys(pendingDuplicateFiles).length;

  // RustyTab keeps this component mounted after its first open. Hiding only
  // removes the visual pane; the socket, per-file checkpoints, and ledger
  // updates continue exactly as they do for an open pane.
  if (!isOpen) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      style={{ width: isMaximized ? "100%" : `${width}px` }}
      className={`border-l border-[var(--border-color)] bg-[var(--bg-app)]/95 flex flex-col h-full text-[var(--text-normal)] font-sans shadow-2xl z-[40] max-w-full ${
        isMaximized ? "absolute inset-0" : "absolute right-0 top-0 bottom-0"
      }`}
    >
      {/* Resizer Handle */}
      {!isMaximized && (
        <div
          onMouseDown={startResizing}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[var(--color-status-danger-bg)] active:bg-[var(--color-status-danger-solid)] transition-colors z-50"
          style={{ transform: "translateX(-50%)" }}
        />
      )}
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] bg-gradient-to-r from-[var(--color-status-danger-bg)] to-transparent flex-shrink-0">
        <div className="flex flex-col">
          <span className="font-mono text-xs text-[var(--color-status-danger)] uppercase tracking-wider flex items-center space-x-1.5">
            <GitMerge size={12} />
            <span>Reconciliation Tool</span>
          </span>
          <span className="font-semibold text-sm truncate">
            Resolving overlapping file modifications
          </span>
        </div>
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2 text-xs">
            <span className="text-[10px] uppercase font-bold text-[var(--text-muted)] tracking-wider">
              Model:
            </span>
            <CustomSelect
              value={selectedModel}
              onChange={(val) => setSelectedModel(val)}
              options={modelOptions}
              placeholder={modelOptions.length === 0 && unauthenticatedProviders.length > 0
                ? `Sign in to ${unauthenticatedProviders.map((p) => p.name).join(", ")}`
                : "Select Model"}
              className="w-40 text-xs font-mono"
              direction="down"
            />
          </div>
          <div className="h-5 w-[1px] bg-[var(--border-color)] flex-shrink-0" />
          <button
            onClick={() => setIsMaximized(!isMaximized)}
            className="text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors p-1 rounded-lg hover:bg-[var(--bg-sidebar)] cursor-pointer"
            title={isMaximized ? "Restore size" : "Maximize to fullscreen"}
          >
            {isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors p-1 rounded-lg hover:bg-[var(--bg-sidebar)] cursor-pointer"
            title="Hide reconciliation pane"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Tabs Menu */}
      <div className="flex overflow-x-auto border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/20 px-2 flex-shrink-0">
        <button
          onClick={() => setActiveTab("overview")}
          className={`flex items-center space-x-1.5 px-3 py-2 text-xs font-mono font-semibold transition-all border-b-2 hover:text-[var(--text-light)] cursor-pointer ${
            activeTab === "overview" ? "border-[var(--color-status-danger-border)] text-[var(--color-status-danger)]" : "border-transparent text-[var(--text-muted)]"
          }`}
        >
          <GitMerge size={13} />
          <span>Overview</span>
        </button>
        <button
          onClick={() => setActiveTab("chat")}
          className={`flex items-center space-x-1.5 px-3 py-2 text-xs font-mono font-semibold transition-all border-b-2 hover:text-[var(--text-light)] cursor-pointer ${
            activeTab === "chat" ? "border-[var(--color-status-danger-border)] text-[var(--color-status-danger)]" : "border-transparent text-[var(--text-muted)]"
          }`}
        >
          <MessageSquare size={13} />
          <span>Adjustment Chat</span>
        </button>
        <button
          onClick={() => setActiveTab("console")}
          className={`flex items-center space-x-1.5 px-3 py-2 text-xs font-mono font-semibold transition-all border-b-2 hover:text-[var(--text-light)] cursor-pointer relative ${
            activeTab === "console" ? "border-[var(--color-status-danger-border)] text-[var(--color-status-danger)]" : "border-transparent text-[var(--text-muted)]"
          }`}
        >
          <Terminal size={13} />
          <span>Console Stream</span>
          {isReconciling && (
            <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[var(--color-status-danger-solid)] animate-ping" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("files")}
          className={`flex items-center space-x-1.5 px-3 py-2 text-xs font-mono font-semibold transition-all border-b-2 hover:text-[var(--text-light)] cursor-pointer ${
            activeTab === "files" ? "border-[var(--color-status-danger-border)] text-[var(--color-status-danger)]" : "border-transparent text-[var(--text-muted)]"
          }`}
        >
          <FileCode size={13} />
          <span>Ledger ({reconciledFiles.length})</span>
        </button>
        <button
          onClick={() => setActiveTab("vfs")}
          className={`flex items-center space-x-1.5 px-3 py-2 text-xs font-mono font-semibold transition-all border-b-2 hover:text-[var(--text-light)] cursor-pointer ${
            activeTab === "vfs" ? "border-[var(--color-status-danger-border)] text-[var(--color-status-danger)]" : "border-transparent text-[var(--text-muted)]"
          }`}
        >
          <Folder size={13} />
          <span>VFS</span>
        </button>
      </div>

      {/* Tab Contents */}
      <div className="flex-1 overflow-hidden relative flex flex-col bg-[var(--bg-app)]">
        {activeTab === "overview" && (
          <div className="flex-1 flex flex-col overflow-hidden p-4">
            {/* Overlapping modifications list */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="grid grid-cols-3 gap-2 mb-3 text-center font-mono">
                <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-sidebar)] px-2 py-2">
                  <div className="text-sm font-bold text-[var(--color-status-danger)]">{duplicateFilesEntries.length}</div>
                  <div className="text-[8px] uppercase text-[var(--text-muted)]">Collisions</div>
                </div>
                <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-sidebar)] px-2 py-2">
                  <div className="text-sm font-bold text-[var(--color-status-warning)]">{pendingCount}</div>
                  <div className="text-[8px] uppercase text-[var(--text-muted)]">Pending</div>
                </div>
                <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-sidebar)] px-2 py-2">
                  <div className="text-sm font-bold text-[var(--color-status-success)]">{ordinaryChangedFiles.length}</div>
                  <div className="text-[8px] uppercase text-[var(--text-muted)]">Ordinary Changes</div>
                </div>
              </div>
              <div className="font-mono text-[10px] text-[var(--text-muted)] uppercase mb-2 font-bold flex items-center space-x-1">
                <AlertTriangle size={12} className="text-[var(--color-status-warning)]" />
                <span>Reconciliation Ledger ({duplicateFilesEntries.length})</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-3 select-none pr-1">
                {duplicateFilesEntries.length === 0 ? (
                  <div className="text-[var(--text-muted)] h-full flex flex-col items-center justify-center text-center px-4">
                    <GitMerge size={24} className="text-[var(--color-status-danger)] mb-2" />
                    <span>No overlapping modifications detected. Ordinary TaskNode-owned changes can be applied without model reconciliation.</span>
                  </div>
                ) : (
                  duplicateFilesEntries.map(([filePath, taskIds]) => {
                    const parts = filePath.split("/");
                    const name = parts[parts.length - 1];
                    const dir = parts.slice(0, -1).join("/");
                    const entry = reconciliationLedger[filePath];
                    const isCurrent = entry?.sourceSignature === taskFileRecords[filePath]?.sourceSignature;
                    const status = entry?.status === "reconciled" && isCurrent
                      ? "reconciled"
                      : entry?.status === "error" && isCurrent
                      ? "error"
                      : "pending";
                    return (
                      <div
                        key={filePath}
                        className="p-3 bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-xl flex flex-col space-y-2 shadow-sm"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex flex-col">
                            <span className="font-semibold text-xs text-[var(--text-light)] truncate max-w-[280px]">
                              {name}
                            </span>
                            {dir && <span className="text-[9px] text-[var(--text-muted)] truncate max-w-[280px]">{dir}</span>}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`border text-[9px] font-mono font-bold px-2 py-0.5 rounded-full uppercase flex items-center gap-1 ${
                              status === "reconciled"
                                ? "bg-[var(--color-status-success-bg)] text-[var(--color-status-success)] border-[var(--color-status-success-border)]"
                                : status === "error"
                                ? "bg-[var(--color-status-danger-bg)] text-[var(--color-status-danger)] border-[var(--color-status-danger-border)]"
                                : "bg-[var(--color-status-warning-bg)] text-[var(--color-status-warning)] border-[var(--color-status-warning-border)]"
                            }`}>
                              {status === "reconciled" ? <CheckCircle2 size={9} /> : status === "pending" ? <CircleDashed size={9} /> : <AlertTriangle size={9} />}
                              <span>{status}</span>
                            </span>
                            {status === "reconciled" && entry?.method === "manual" && (
                              <span className="rounded-full border border-[var(--color-status-warning-border)] bg-[var(--color-status-warning-bg)] px-2 py-0.5 text-[8px] font-mono font-bold uppercase text-[var(--color-status-warning)]">
                                Manual
                              </span>
                            )}
                            {status === "reconciled" && (
                              <button
                                onClick={() => void handleRemoveReconciledFile(filePath)}
                                disabled={isReconciling || isResetting}
                                className="p-1 text-[var(--text-muted)] hover:text-[var(--color-status-danger)] disabled:opacity-40"
                                title="Remove this result from the reconciliation ledger"
                              >
                                <Trash2 size={11} />
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[9px] text-[var(--text-muted)] font-mono">Modified by:</span>
                          {taskIds.map((tid) => {
                            const taskName = String(formattedNodes.find((n) => n.id === tid)?.name || tid);
                            return (
                              <span
                                key={tid}
                                className="bg-[var(--color-status-danger-bg)] text-[var(--color-status-danger)] border border-[var(--color-status-danger-border)] text-[9px] font-mono px-2 py-0.5 rounded-md"
                              >
                                {taskName}
                              </span>
                            );
                          })}
                        </div>
                        {status === "reconciled" && entry?.method === "manual" && entry.response && (
                          <div className="text-[9px] font-mono text-[var(--color-status-warning)]">
                            {entry.response}
                          </div>
                        )}
                        {status === "error" && entry?.error && (
                          <div className="border-t border-[var(--color-status-danger-border)] pt-2 flex items-start justify-between gap-2">
                            <div className="text-[9px] text-[var(--color-status-danger)] font-mono break-words min-w-0">
                              {entry.error}
                            </div>
                            <button
                              onClick={() => void startReconciliation(undefined, filePath)}
                              disabled={isReconciling || isResetting}
                              className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-[var(--color-status-danger-border)] text-[9px] font-mono font-bold text-[var(--color-status-danger)] disabled:opacity-40"
                              title="Retry only this failed file"
                            >
                              <RotateCcw size={9} />
                              <span>Retry</span>
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
              {ordinaryChangedFiles.length > 0 && (
                <div className="mt-3 pt-3 border-t border-[var(--border-color)] flex-shrink-0">
                  <div className="font-mono text-[10px] text-[var(--text-muted)] uppercase mb-2 font-bold flex items-center gap-1">
                    <FileCode size={11} className="text-[var(--color-status-success)]" />
                    <span>Changed — no reconciliation needed ({ordinaryChangedFiles.length})</span>
                  </div>
                  <div className="max-h-24 overflow-y-auto space-y-1 pr-1">
                    {ordinaryChangedFiles.map((filePath) => (
                      <div key={filePath} className="px-2 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-sidebar)] text-[9px] font-mono text-[var(--text-normal)] truncate" title={filePath}>
                        {filePath}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "chat" && (
          <div className="flex-1 flex flex-col overflow-hidden relative">
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/30 px-3 py-2 font-mono">
              <FileCode size={12} className="text-[var(--color-status-warning)]" />
              <span className="flex-shrink-0 text-[9px] font-bold uppercase text-[var(--text-muted)]">Adjust file</span>
              <CustomSelect
                value={chatFilePath}
                onChange={setChatFilePath}
                options={duplicateFilesEntries.map(([filePath]) => ({
                  id: filePath,
                  name: filePath.replace(/\\/g, "/").split("/").pop() || filePath,
                }))}
                placeholder="Select a collision file"
                className="w-64 text-xs"
                direction="down"
              />
              {chatFilePath && reconciliationLedger[chatFilePath]?.status === "reconciled" && (
                <span className="rounded-full border border-[var(--color-status-success-border)] bg-[var(--color-status-success-bg)] px-2 py-0.5 text-[8px] font-bold uppercase text-[var(--color-status-success)]">
                  Reconciled · editable
                </span>
              )}
            </div>
            {/* Chat Messages */}
            <div className="flex-1 p-4 space-y-3 overflow-y-auto text-xs">
              {chatMessages.length === 0 ? (
                <div className="text-[var(--text-muted)] h-full flex flex-col items-center justify-center text-center px-4">
                    <MessageSquare size={24} className="text-[var(--color-status-danger)] mb-2" />
                    <span>Select a collision file and ask the model for a focused adjustment. Completed ledger files can be revised at any time.</span>
                </div>
              ) : (
                chatMessages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`flex flex-col rounded-xl p-3 w-full space-y-1 text-left ${
                      msg.role === "user"
                        ? "bg-[var(--color-status-danger-bg)] border border-[var(--color-status-danger-border)]"
                        : msg.role === "system"
                        ? "bg-[var(--bg-sidebar)]/30 border border-[var(--border-color)]/50 text-[var(--text-muted)] italic"
                        : "bg-[var(--bg-sidebar)] border border-[var(--border-color)]"
                    }`}
                  >
                    <span
                      className={`font-mono text-[9px] uppercase font-bold ${
                        msg.role === "user"
                          ? "text-[var(--color-status-danger)]"
                          : msg.role === "system"
                          ? "text-[var(--text-muted)]"
                          : "text-[var(--color-status-success)]"
                      }`}
                    >
                      {msg.role === "user" ? "You" : msg.role === "system" ? "System Router" : "Reconciliation Agent"}
                    </span>
                    <div className="leading-relaxed whitespace-pre-wrap text-[var(--text-normal)]">
                      {msg.role === "system" ? msg.content : processResponse(msg.content)}
                    </div>
                  </div>
                ))
              )}
              {(isReconciling || reconciliationLogs.length > 0) && (
                <AgentActivityCard
                  content={reconciliationLogs.join("\n")}
                  isStreaming={isReconciling}
                />
              )}
              {isReconciling && (
                <div className="flex items-center gap-2 px-3 py-2 text-[11px] font-mono text-[var(--text-muted)]" aria-live="polite">
                  <Loader2 size={14} className="animate-spin text-[var(--color-status-danger)]" />
                  <span>Reconciliation model is thinking…</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input area */}
            <div className="p-3 border-t border-[var(--border-color)] bg-[var(--bg-sidebar)]/20 space-y-2">
              {runUsage && (
                <div className="flex justify-end">
                  <TokenBadge usage={runUsage} live={isReconciling} />
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendChat();
                }}
                className="flex items-center space-x-2 bg-[var(--bg-app)] border border-[var(--border-color)] p-1.5 rounded-lg focus-within:border-[var(--color-status-danger-border)]"
              >
                <input
                  type="text"
                  placeholder={chatFilePath ? "Ask the model to change this reconciled file..." : "Select a collision file first..."}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  disabled={isReconciling || !chatFilePath}
                  className="flex-1 bg-transparent border-none outline-none text-xs px-2 py-1 focus:ring-0 text-[var(--text-normal)]"
                />
                <button
                  type="submit"
                  disabled={isReconciling || !chatInput.trim() || !chatFilePath}
                  className="bg-[var(--color-status-danger-solid)] hover:bg-[var(--color-status-danger-solid)] disabled:bg-[var(--bg-sidebar)] disabled:text-[var(--text-muted)] text-[var(--color-status-danger-solid-foreground)] text-xs font-mono font-bold px-3 py-1.5 rounded-md flex items-center space-x-1.5 transition-all cursor-pointer"
                >
                  {isReconciling ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                  <span>Send</span>
                </button>
              </form>
            </div>
          </div>
        )}

        {activeTab === "console" && (
          <ConsoleTabContent selectedNodeId={reconciliationStreamId} tabId={tabId} />
        )}

        {activeTab === "files" && (
          <PRDiffView
            tabId={tabId}
            modifiedFiles={reconciledFiles}
            ownerNodeId={reconciliationNodeId}
            persistenceTabId={tabId}
            taskVersionsPerFile={taskVersionsPerFile}
            refreshKey={reconciliationRevision}
            onFileSaved={handleReconciledFileSaved}
          />
        )}

        {activeTab === "vfs" && (
          <VfsExplorer tabId={tabId} />
        )}
      </div>

      {/* Footer Actions */}
      <div className="border-t border-[var(--border-color)] bg-[var(--bg-sidebar)]/20 flex-shrink-0">
        {/* Build command input row */}
        <div className="flex items-center gap-2 px-3 pt-2 pb-1">
          <Hammer size={11} className="text-[var(--text-muted)] flex-shrink-0" />
          <input
            type="text"
            value={buildCommand}
            onChange={(e) => {
              setBuildCommand(e.target.value);
              localStorage.setItem(`rusty_build_command_${tabId}`, e.target.value);
            }}
            placeholder="Build command (e.g. npm run build)"
            disabled={isTesting}
            className="flex-1 bg-[var(--bg-app)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] font-mono text-[var(--text-normal)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-active)] disabled:opacity-50"
          />
          {isTesting ? (
            <button
              onClick={handleStopTestBuild}
              className="flex-shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-mono font-bold bg-[var(--color-status-danger-bg)] border border-[var(--color-status-danger-border)] text-[var(--color-status-danger)] rounded cursor-pointer"
              title="Stop test build"
            >
              <XCircle size={11} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              onClick={() => void handleTestBuild()}
              disabled={isReconciling || isResetting || reconciledFiles.length === 0}
              title={reconciledFiles.length === 0 ? "Reconcile files first" : "Temporarily apply, build, auto-fix if needed, then rollback"}
              className="flex-shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-mono font-bold bg-[var(--bg-sidebar)] border border-[var(--border-color)] text-[var(--text-muted)] hover:border-[var(--color-status-warning-border)] hover:text-[var(--color-status-warning)] disabled:opacity-40 disabled:cursor-not-allowed rounded cursor-pointer transition-colors"
            >
              <Hammer size={11} />
              <span>Test Build</span>
            </button>
          )}
        </div>
        {/* Main action row */}
        <div className="flex items-center justify-between gap-3 px-3 pb-3 pt-1">
          <button
            onClick={() => void handleResetReconciliation()}
            disabled={Object.keys(reconciliationLedger).length === 0 || isReconciling || isResetting}
            title={Object.keys(reconciliationLedger).length > 0 ? "Clear the reconciliation ledger and restore completed collision files" : "No reconciliation to reset"}
            className="border border-[var(--color-status-warning-border)] bg-[var(--color-status-warning-bg)] hover:bg-[var(--color-status-warning-bg)] disabled:opacity-40 disabled:cursor-not-allowed text-[var(--color-status-warning)] text-xs font-mono font-bold px-3 py-2 rounded-lg flex items-center space-x-1.5 transition-all cursor-pointer"
          >
            {isResetting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
            <span>{isResetting ? "Resetting" : "Reset"}</span>
          </button>
          {isReconciling ? (
            <button
              onClick={() => handleStopReconciliation()}
              className="bg-[var(--color-status-danger-solid)] hover:bg-[var(--color-status-danger-solid)] text-[var(--color-status-danger-solid-foreground)] text-xs font-mono font-bold px-4 py-2 rounded-lg flex items-center space-x-1.5 transition-all shadow-md cursor-pointer animate-pulse"
            >
              <Octagon size={13} />
              <span>Stop Execution</span>
            </button>
          ) : (
            <button
              onClick={() => void startReconciliation()}
              disabled={taskModifiedFiles.length === 0 || isResetting || isTesting}
              className="bg-[var(--color-status-danger-solid)] hover:bg-[var(--color-status-danger-solid)] disabled:opacity-50 disabled:cursor-not-allowed text-[var(--color-status-danger-solid-foreground)] text-xs font-mono font-bold px-4 py-2 rounded-lg flex items-center space-x-1.5 transition-all shadow-md cursor-pointer"
            >
              <Play size={13} />
              <span>{pendingCount > 0 ? `Reconcile ${pendingCount} Pending` : "Check Reconciliation"}</span>
            </button>
          )}
        </div>
      </div>
      {ConfirmModalComponent}
    </div>
  );
};
