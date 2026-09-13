import React, { useEffect, useState } from "react";
import { useWorkspaceStore } from "../store";
import { onCloseTabRequest } from "../tabs/closeRequests";
import { evaluateClose } from "../tabs/closeGuards";
import type { TabViewContext } from "../tabs/views";
import { TabStrip } from "./workspace/TabStrip";
import { TabOutlet } from "./workspace/TabOutlet";
import { createPortal } from "react-dom";
import { AlertTriangle, X, Save, HelpCircle } from "lucide-react";
import { canvasFileService } from "./tabs/canvas/services/canvasFileService";
import { CommandPermissionPresenter } from "./permissions/CommandPermissionPresenter";
import { notify } from "../notificationStore";
import * as agentRunCoordinator from "../services/agentRunCoordinator";

export const Workspace: React.FC = () => {
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

    // Stop all running nodes in this tab
    agentRunCoordinator.stopAllRunningNodesInTab(tabId);
    const context = useWorkspaceStore.getState().canvasContexts[tabId];

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

  const tabViewContext: TabViewContext = {
    executeNode: agentRunCoordinator.executeNode,
    stopExecution: agentRunCoordinator.stopExecution,
  };

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
