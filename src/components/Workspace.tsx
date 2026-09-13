import React from "react";
import type { TabViewContext } from "../tabs/views";
import { TabStrip } from "./workspace/TabStrip";
import { TabOutlet } from "./workspace/TabOutlet";
import { CommandPermissionPresenter } from "./permissions/CommandPermissionPresenter";
import { TabCloseInterceptPresenter } from "./workspace/TabCloseInterceptPresenter";
import * as agentRunCoordinator from "../services/agentRunCoordinator";

/**
 * The tab strip + tab outlet, plus two self-contained presenters
 * (`CommandPermissionPresenter`, `TabCloseInterceptPresenter`) that own
 * their own state/subscriptions and need no props from here.
 *
 * Canvas/task execution (`agentRunCoordinator.ts`) and the close-intercept
 * controller (`TabCloseInterceptPresenter.tsx`) both used to live inline
 * in this component (REFACTOR_PLAN.md PR 7 commits 1 and 3) -- this file
 * is now just the wiring between the tab registry and those two services.
 */
export const Workspace: React.FC = () => {
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
      <TabCloseInterceptPresenter />
      <div className="flex flex-col h-full w-full min-w-0 overflow-hidden">
        <TabStrip />
        <TabOutlet context={tabViewContext} />
      </div>
    </div>
  );
};
