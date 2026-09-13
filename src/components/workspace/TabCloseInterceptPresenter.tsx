import React, { useEffect, useState } from "react";
import { useWorkspaceStore } from "../../store";
import { onCloseTabRequest } from "../../tabs/closeRequests";
import { evaluateClose } from "../../tabs/closeGuards";
import { requestTabStop } from "../../tabs/tabStopRegistry";
import { notify } from "../../notificationStore";
import { canvasFileService } from "../tabs/canvas/services/canvasFileService";
import * as agentRunCoordinator from "../../services/agentRunCoordinator";
import { RunningTabCloseModal } from "./RunningTabCloseModal";
import { UnsavedCanvasModal } from "./UnsavedCanvasModal";

/**
 * The close-intercept controller (REFACTOR_PLAN.md PR 7 commit 3), moved
 * out of Workspace.tsx -- modeled on the already-self-contained
 * `CommandPermissionPresenter` (no props, owns its own state/subscription,
 * renders its own portals).
 *
 * "Stop whatever this tab is running" now dispatches by tab type instead
 * of always assuming canvas: canvas stops every running node in it (via
 * the coordinator, same as before), task stops its own node, and anything
 * else (agent) goes through the per-tab stop registry (PR 7 commit 2) --
 * this is what actually lets Agent tabs reach this modal at all now that
 * their policy can produce a "running" close guard.
 */
function stopWhatIsRunning(tab: { id: string; type: string; taskNodeId?: string }): void {
  if (tab.type === "canvas") {
    agentRunCoordinator.stopAllRunningNodesInTab(tab.id);
  } else if (tab.type === "task" && tab.taskNodeId) {
    agentRunCoordinator.stopExecution(tab.taskNodeId);
  } else {
    requestTabStop(tab.id);
  }
}

export const TabCloseInterceptPresenter: React.FC = () => {
  const [closeIntercept, setCloseIntercept] = useState<{
    tabId: string;
    type: "unsaved" | "running";
    title: string;
  } | null>(null);

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
    const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab) {
      setCloseIntercept(null);
      return;
    }

    stopWhatIsRunning(tab as { id: string; type: string; taskNodeId?: string });

    // Save the clean "idle" status back to disk if this tab was already
    // saved before -- canvas-specific: agent/task tabs have no on-disk
    // "clean status" concept at all.
    const context = useWorkspaceStore.getState().canvasContexts[tabId];
    if (tab.type === "canvas" && context?.hasBeenSaved) {
      try {
        await canvasFileService.saveCanvas(tabId, closeIntercept.title);
      } catch (err) {
        console.error("[TabCloseInterceptPresenter] Failed to save canvas status to disk on close:", err);
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

  if (!closeIntercept) return null;

  if (closeIntercept.type === "running") {
    return (
      <RunningTabCloseModal
        title={closeIntercept.title}
        onConfirm={handleConfirmCloseRunning}
        onCancel={() => setCloseIntercept(null)}
      />
    );
  }

  return (
    <UnsavedCanvasModal
      title={closeIntercept.title}
      onSave={handleSaveAndClose}
      onDiscard={handleDiscardAndClose}
      onCancel={() => setCloseIntercept(null)}
    />
  );
};
