import React, { useState } from "react";
import { createPortal } from "react-dom";
import { HelpCircle, Save, X } from "lucide-react";

interface UnsavedCanvasModalProps {
  title: string;
  onSave: (saveTitle: string) => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/** Moved out of Workspace.tsx's inline JSX (REFACTOR_PLAN.md PR 7 commit 3),
    otherwise unchanged -- only "unsaved" reason today's `canvas` policy can
    produce, so this stays canvas-specific (renamed from
    `UnsavedChangesModal`). */
export const UnsavedCanvasModal: React.FC<UnsavedCanvasModalProps> = ({ title, onSave, onDiscard, onCancel }) => {
  const [saveTitle, setSaveTitle] = useState(title);

  return createPortal(
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
    </div>,
    document.body,
  );
};
