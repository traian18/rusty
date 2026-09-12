/**
 * SidePaneFooter.tsx
 *
 * Footer bar displayed at the bottom of the side pane when a task node is
 * selected. Shows the node status, optional token usage badge, model
 * selector, and an execute / stop button.
 */

import React from "react";
import { Sparkles, Octagon } from "lucide-react";
import { CustomSelect } from "../../CustomSelect";
import { TokenBadge } from "../../ui/TokenBadge/TokenBadge";
import { selectableProviderModels } from "../../../store/providerHelpers";
import { useWorkspaceStore } from "../../../store";
import type { TokenUsageLike } from "../hooks/useNodeUsage";

export interface SidePaneFooterProps {
  /** The selected task node. */
  selectedNode: any;
  /** Current execution status. */
  nodeStatus: string;
  /** Token usage data for the running node (optional). */
  nodeUsage: TokenUsageLike | null;
  /** Custom providers from the store. */
  customProviders: any[];
  /** ID of the active custom provider. */
  activeCustomProviderId: string | null;
  /** Called when the user clicks the execute button. */
  onExecute: () => void;
  /** Called when the user clicks the stop button. */
  onStop: () => void;
}

/**
 * Footer bar with status, model selector, token badge, and execute/stop
 * controls for the selected task node.
 */
export const SidePaneFooter: React.FC<SidePaneFooterProps> = ({
  selectedNode,
  nodeStatus,
  nodeUsage,
  customProviders,
  activeCustomProviderId,
  onExecute,
  onStop,
}) => {
  // Read directly rather than threading a new prop through SidePane.tsx --
  // this component already imports useWorkspaceStore for its imperative
  // updateTaskNode call below, so a selector hook here is consistent with
  // that, not a new pattern (REFACTOR_PLAN.md PR 3c).
  const providerStatus = useWorkspaceStore((s) => s.providerStatus);
  const modelOptions = selectableProviderModels(
    customProviders,
    providerStatus,
    activeCustomProviderId
  ).map(({ model }) => ({
    id: model.id,
    name: model.name,
  }));

  return (
    <div className="p-3 border-t border-[var(--border-color)] bg-[var(--bg-sidebar)]/20 flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-[10px] uppercase font-mono text-[var(--text-muted)]">
        Status:{" "}
        <span className="font-bold text-[var(--text-normal)]">
          {nodeStatus}
        </span>
        {nodeUsage && (
          <TokenBadge usage={nodeUsage} live={nodeStatus === "running"} />
        )}
      </span>

      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase font-mono text-[var(--text-muted)]">
          Model:
        </span>
        <CustomSelect
          value={(selectedNode.data as any).model || ""}
          onChange={(val) => {
            const updateTaskNode =
              useWorkspaceStore.getState().updateTaskNode;
            updateTaskNode(selectedNode.id, { model: val });
          }}
          options={modelOptions}
          placeholder="Select model"
          className="w-36"
        />
      </div>

      {nodeStatus === "running" ? (
        <button
          onClick={onStop}
          className="bg-[var(--color-status-danger-solid)] hover:bg-[var(--color-status-danger-solid)] text-[var(--color-status-danger-solid-foreground)] text-xs font-mono font-bold px-4 py-2 rounded-lg flex items-center space-x-1.5 transition-all shadow-md cursor-pointer"
        >
          <Octagon size={14} />
          <span>Stop</span>
        </button>
      ) : (
        <button
          onClick={onExecute}
          className="bg-[var(--accent-color)] hover:bg-[var(--accent-color)]/80 disabled:bg-[var(--bg-sidebar)] disabled:text-[var(--text-muted)] text-[var(--color-primary-foreground)] text-xs font-mono font-bold px-4 py-2 rounded-lg flex items-center space-x-1.5 transition-all glow-btn shadow-md cursor-pointer"
        >
          <Sparkles size={14} />
          <span>Run Executor</span>
        </button>
      )}
    </div>
  );
};
