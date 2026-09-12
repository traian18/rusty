/**
 * useEdgeWebSocket Hook
 * 
 * Manages WebSocket communication with the agent sidecar during reconciliation chats.
 * It handles message sending/receiving, file reads/writes requested by the agent,
 * state changes, and logs chat history.
 */

import { useState, useRef, useEffect } from "react";
import { useWorkspaceStore } from "../../store";
import { VfsRegistry } from "../../services/vfs";
import { notify } from "../../notificationStore";
import { resolveExecutionProvider } from "../../store/resolveExecutionProvider";
import { edgeReconciliationService, EdgeReconciliationRun } from "../../services/edgeReconciliationService";
import type { TokenUsageLike } from "../ui/TokenBadge/TokenBadge";

export const useEdgeWebSocket = (
  edgeId: string | null,
  sourceNode: any,
  targetNode: any,
  sourceModifiedFiles: string[],
  diffFile: string,
  loadDiffContent: (path: string) => Promise<void>,
  tabId?: string
) => {
  const [chatMessages, setChatMessages] = useState<{ role: string; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const [runUsage, setRunUsage] = useState<TokenUsageLike | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const activeRunRef = useRef<EdgeReconciliationRun | null>(null);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Set initial chat messages when edgeId changes
  useEffect(() => {
    if (!edgeId || !sourceNode || !targetNode) return;

    const sourceName = (sourceNode.data as any).name || sourceNode.id;
    const targetName = (targetNode.data as any).name || targetNode.id;
    const files = sourceModifiedFiles.join(", ") || "none";

    setChatMessages([
      {
        role: "system",
        content: `I'm analyzing the connection between "${sourceName}" → "${targetName}". The source task modified: ${files}. I'll help resolve any conflicts between these changes and the target task's requirements.`,
      },
    ]);
  }, [edgeId, sourceNode?.id, targetNode?.id, sourceModifiedFiles]);

  const handleSendChat = () => {
    if (!chatInput.trim() || isResolving || !edgeId) return;

    const userMsg = { role: "user", content: chatInput.trim() };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput("");
    setIsResolving(true);
    setRunUsage(null);

    const rootPath = useWorkspaceStore.getState().rootPath;
    const providers = useWorkspaceStore.getState().customProviders;
    const activeProviderId = useWorkspaceStore.getState().activeCustomProviderId;
    const providerStatus = useWorkspaceStore.getState().providerStatus;
    const activeModel = useWorkspaceStore.getState().activeModel;
    const resolution = resolveExecutionProvider(providers, providerStatus, activeProviderId, activeModel);
    if (!resolution.ok) {
      setChatMessages((prev) => [...prev, { role: "assistant", content: resolution.message }]);
      setIsResolving(false);
      notify("Cannot reconcile", resolution.message, "error");
      return;
    }

    const run = edgeReconciliationService.send(
      {
        edgeId,
        sourceTaskId: sourceNode?.id,
        targetTaskId: targetNode?.id,
        modifiedFiles: sourceModifiedFiles,
        userMessage: userMsg.content,
        chatHistory: chatMessages.map((m) => ({ role: m.role, content: m.content })),
        workspaceRoot: rootPath,
        model: activeModel,
        sourcePrompt: (sourceNode?.data as any)?.prompt || "",
        targetPrompt: (targetNode?.data as any)?.prompt || "",
        customProvider: resolution.provider,
      },
      {
        onUsage: (usage) => {
          setRunUsage(usage as TokenUsageLike);
        },
        onReadFile: (path) => VfsRegistry.getOrCreate(tabId).readFile(path),
        onWriteFile: async (path, content) => {
          await VfsRegistry.getOrCreate(tabId).writeFile(path, content);
          if (tabId) {
            try {
              const { canvasFileService } = await import("../tabs/canvas/services/canvasFileService");
              await canvasFileService.autoSaveCanvas(tabId);
            } catch (err) {
              console.error("Failed to auto-save canvas on write_file in edge websocket:", err);
            }
          }
        },
        onComplete: (response) => {
          setChatMessages((prev) => [...prev, { role: "assistant", content: response }]);
          setIsResolving(false);
          activeRunRef.current = null;
          if (diffFile) loadDiffContent(diffFile);
        },
        onError: (message) => {
          setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${message}` }]);
          setIsResolving(false);
          activeRunRef.current = null;
          notify("Reconciliation Error", `Reconciliation failed with error: ${message}`, "error");
        },
      }
    );
    activeRunRef.current = run;
  };

  const handleStopReconciliation = () => {
    activeRunRef.current?.cancel();
    activeRunRef.current = null;
    setIsResolving(false);
  };

  return {
    chatMessages,
    chatInput,
    setChatInput,
    isResolving,
    runUsage,
    chatEndRef,
    handleSendChat,
    handleStopReconciliation
  };
};
