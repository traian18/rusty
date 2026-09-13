import React from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";

interface RunningTabCloseModalProps {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation shown when closing a tab with active background work
 * (REFACTOR_PLAN.md PR 7 commit 3, moved out of Workspace.tsx's inline
 * JSX). Generic across tab types now that Agent and Task tabs can also
 * trigger this reason (commit 2) -- not canvas-specific wording anymore.
 */
export const RunningTabCloseModal: React.FC<RunningTabCloseModalProps> = ({ title, onConfirm, onCancel }) =>
  createPortal(
    <div className="fixed inset-0 bg-[var(--color-surface-overlay)] backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-xl w-full max-w-md shadow-2xl overflow-hidden font-mono">
        <div className="px-4 py-3 bg-[var(--bg-header)] border-b border-[var(--border-color)] flex items-center justify-between">
          <span className="text-[var(--text-light)] text-sm font-bold flex items-center space-x-2">
            <AlertTriangle size={16} className="text-[var(--color-status-warning)] animate-pulse" />
            <span>Active Processes Running</span>
          </span>
          <button
            onClick={onCancel}
            className="text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 flex flex-col space-y-3">
          <p className="text-xs text-[var(--text-normal)] leading-relaxed">
            <code className="text-[var(--color-status-warning)] font-bold">"{title}"</code> has active background processes running.
          </p>
          <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
            Closing this tab will stop all running agents and cancel ongoing operations. Are you sure you want to proceed?
          </p>
        </div>
        <div className="px-4 py-3 bg-[var(--bg-header)] border-t border-[var(--border-color)] flex items-center justify-end space-x-2">
          <button
            onClick={onCancel}
            className="px-3.5 py-1.5 border border-[var(--border-color)] hover:bg-[var(--bg-canvas)] text-[var(--text-muted)] hover:text-[var(--text-light)] rounded-lg text-xs font-semibold cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 bg-[var(--color-status-danger-solid)] hover:bg-[var(--color-status-danger-solid)] text-[var(--color-status-danger-solid-foreground)] rounded-lg text-xs font-semibold cursor-pointer transition-colors shadow-md"
          >
            Stop Agents & Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
