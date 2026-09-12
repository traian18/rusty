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
import { createAgentHarnessSocket } from "../../services/agentHarnessClient";
import { SIDECAR_PORT } from "../../config/sidecar";
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

    let socket: WebSocket;
    try {
      socket = createAgentHarnessSocket();
    } catch (err: any) {
      console.error("Failed to construct Edge WebSocket:", err);
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Connection failed: ${err.message || String(err)}` },
      ]);
      setIsResolving(false);
      notify(
        "Sidecar Connection Error",
        `Failed to create WebSocket connection to sidecar: ${err.message || String(err)}. Ensure the agent sidecar is running on port ${SIDECAR_PORT}.`,
        "error"
      );
      return;
    }

    socket.onopen = () => {
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
        socket.close();
        return;
      }

      socket.send(
        JSON.stringify({
          type: "reconciliate_edge",
          edgeId: edgeId,
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
        })
      );
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "read_file") {
          VfsRegistry.getOrCreate(tabId).readFile(msg.path)
            .then((content: any) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(
                  JSON.stringify({
                    type: "read_file_response",
                    requestId: msg.requestId,
                    content,
                  })
                );
              }
            })
            .catch((err: any) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(
                  JSON.stringify({
                    type: "read_file_response",
                    requestId: msg.requestId,
                    error: err.message || String(err),
                  })
                );
              }
            });
          return;
        }

        if (msg.type === "write_file") {
          VfsRegistry.getOrCreate(tabId).writeFile(msg.path, msg.content)
            .then(() => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(
                  JSON.stringify({ type: "write_file_response", requestId: msg.requestId })
                );
              }
              if (tabId) {
                import("../tabs/canvas/services/canvasFileService").then(({ canvasFileService }) => {
                  canvasFileService.autoSaveCanvas(tabId);
                }).catch((err) => {
                  console.error("Failed to auto-save canvas on write_file in edge websocket:", err);
                });
              }
            })
            .catch((err: any) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(
                  JSON.stringify({
                    type: "write_file_response",
                    requestId: msg.requestId,
                    error: err.message || String(err),
                  })
                );
              }
            });
          return;
        }

        if (msg.type === "usage_update" && msg.nodeId === edgeId) {
          setRunUsage(msg.usage);
          return;
        }

        if (msg.type === "reconciliation_complete") {
          setChatMessages((prev) => [
            ...prev,
            { role: "assistant", content: msg.response || "Analysis complete." },
          ]);
          setIsResolving(false);
          if (diffFile) loadDiffContent(diffFile);
          socket.close();
        }

        if (msg.type === "reconciliation_error") {
          setChatMessages((prev) => [
            ...prev,
            { role: "assistant", content: `Error: ${msg.error}` },
          ]);
          setIsResolving(false);
          socket.close();
          notify("Reconciliation Error", `Reconciliation failed with error: ${msg.error}`, "error");
        }
      } catch (err: any) {
        console.error("EdgeInspector parse error:", err);
        notify("Sidecar Communication Error", `Error processing message from sidecar: ${err.message || String(err)}`, "error");
      }
    };

    socket.onerror = (error) => {
      console.error(`[EdgeInspectorPane] WebSocket error:`, error);
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Failed to connect to sidecar. Ensure the sidecar server is running." },
      ]);
      setIsResolving(false);
      notify(
        "Sidecar Connection Failed",
        `Connection to agent sidecar closed unexpectedly. Ensure agent sidecar is running on port ${SIDECAR_PORT}.`,
        "error"
      );
    };

    socket.onclose = (event) => {
      console.log(`[EdgeInspectorPane] WebSocket closed (code: ${event.code}, reason: "${event.reason}", clean: ${event.wasClean})`);
      if (isResolving) {
        setChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Connection closed unexpectedly (WebSocket code: ${event.code}).` }
        ]);
        setIsResolving(false);
        notify(
          "Connection Lost",
          `The sidecar connection was closed abnormally (code: ${event.code}).`,
          "error"
        );
      }
    };
  };

  return {
    chatMessages,
    chatInput,
    setChatInput,
    isResolving,
    runUsage,
    chatEndRef,
    handleSendChat
  };
};
