import React from "react";
import { X, Maximize2, Minimize2, Sparkles, ListPlus, Octagon } from "lucide-react";
import { CustomSelect } from "../../CustomSelect";
import type { CustomProvider } from "../../../store";

interface SidePaneHeaderProps {
  selectedNode: any;
  onClose: () => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  onGenerateTasks?: () => void;
  onStopGenerateTasks?: () => void;
  onSummarize?: () => void;
  isGeneratingTasks?: boolean;
  isSummarizing?: boolean;
  disableGlobalActions?: boolean;
  taskGenerationModel?: string;
  taskGenerationModels?: { id: string; name: string }[];
  /** Managed providers excluded from taskGenerationModels because their
      registry status isn't 'ready' -- lets the picker's placeholder name
      who needs sign-in instead of just reading "Task model" with an
      empty list (REFACTOR_PLAN.md PR 3c). */
  taskGenerationUnauthenticatedProviders?: CustomProvider[];
  onTaskGenerationModelChange?: (model: string) => void;
}

export const SidePaneHeader: React.FC<SidePaneHeaderProps> = ({
  selectedNode,
  onClose,
  isMaximized,
  onToggleMaximize,
  onGenerateTasks,
  onStopGenerateTasks,
  onSummarize,
  isGeneratingTasks,
  isSummarizing,
  disableGlobalActions,
  taskGenerationModel,
  taskGenerationModels = [],
  taskGenerationUnauthenticatedProviders = [],
  onTaskGenerationModelChange,
}) => {
  const taskModelPlaceholder = taskGenerationModels.length === 0 && taskGenerationUnauthenticatedProviders.length > 0
    ? `Sign in to ${taskGenerationUnauthenticatedProviders.map((p) => p.name).join(", ")}`
    : "Task model";
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/40 select-none flex-shrink-0">
      <div className="flex flex-col">
        <span className="font-mono text-xs text-[var(--text-muted)] uppercase tracking-wider">
          {selectedNode.type === "globalChatNode" ? "Workspace Explorer" : "Inspector"}
        </span>
        <span className="font-semibold text-sm truncate max-w-[320px]">
          {selectedNode.type === "contextNode"
            ? (selectedNode.data as any).name
            : (selectedNode.data as any).name || `Task Node (${selectedNode.id})`}
        </span>
      </div>
      <div className="flex items-center space-x-1">
        {selectedNode.type === "globalChatNode" && (
          <>
            <CustomSelect
              value={taskGenerationModel || ""}
              onChange={(value) => onTaskGenerationModelChange?.(value)}
              options={taskGenerationModels}
              placeholder={taskModelPlaceholder}
              className="w-36"
              direction="down"
            />
            <button
              onClick={isGeneratingTasks ? onStopGenerateTasks : onGenerateTasks}
              disabled={!isGeneratingTasks && disableGlobalActions}
              className={`${isGeneratingTasks ? "text-[var(--color-status-danger)] hover:text-[var(--color-status-danger)] hover:bg-[var(--color-status-danger-bg)]" : "text-[var(--color-status-success)] hover:text-[var(--color-status-success)] hover:bg-[var(--color-status-success-bg)]"} disabled:text-[var(--text-muted)] disabled:opacity-50 transition-colors px-2 py-1 rounded-lg cursor-pointer flex items-center gap-1 text-[10px] font-mono`}
              title={isGeneratingTasks ? "Stop task generation" : "Generate editable TaskNode drafts from this conversation"}
            >
              {isGeneratingTasks ? <Octagon size={14} /> : <ListPlus size={14} />}
              <span>{isGeneratingTasks ? "Stop" : "Generate Tasks"}</span>
            </button>
            <button
              onClick={onSummarize}
              disabled={disableGlobalActions || isSummarizing}
              className="text-[var(--color-status-warning)] hover:text-[var(--color-status-warning)] disabled:text-[var(--text-muted)] disabled:opacity-50 transition-colors px-2 py-1 rounded-lg hover:bg-[var(--color-status-warning-bg)] cursor-pointer flex items-center gap-1 text-[10px] font-mono"
              title="Generate global architectural summary"
            >
              <Sparkles size={14} className={isSummarizing ? "animate-spin" : ""} />
              <span>Summarize</span>
            </button>
            <div className="h-5 w-px bg-[var(--border-color)] mx-1" />
          </>
        )}
        <button
          onClick={onToggleMaximize}
          className="text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors p-1 rounded-lg hover:bg-[var(--bg-sidebar)] cursor-pointer"
          title={isMaximized ? "Restore size" : "Maximize to fullscreen"}
        >
          {isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          onClick={onClose}
          className="text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors p-1 rounded-lg hover:bg-[var(--bg-sidebar)] cursor-pointer"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
};
