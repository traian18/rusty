/**
 * TAB_VIEWS — the view-side half of the tab registry: which component renders
 * each tab type, and which icon represents it.
 *
 * VIEW ONLY. `src/store/**` must never import this file; doing so would pull
 * all 13 tab components into the store's import graph. `layering.test.ts`
 * enforces that. The store-side counterpart is `policy.ts`.
 *
 * Having one table also removes a class of drift the previous per-site `&&`
 * chains allowed: `mcp-integration` and `metrics` rendered fine but had no tab
 * icon at all, because the icon chain (and its duplicate in the overflow
 * dropdown) simply had no branch for them.
 */

import React from "react";
import { Bot, BookOpen, Cpu, FolderOpen, Gauge, GitCommit, Plug, Settings, Wand2 } from "lucide-react";
import { FileIcon } from "../services/fileTypeService";
import { RustyIcon } from "../components/RustyIcon";
import { RustyTab } from "../components/tabs/canvas/RustyTab";
import { FileTab } from "../components/tabs/FileTab";
import { TaskTab } from "../components/tabs/TaskTab";
import { GitDiffTab } from "../components/tabs/GitDiffTab";
import { GitHistoryTab } from "../components/tabs/GitHistoryTab";
import { LlmSetupTab } from "../components/tabs/LlmSetupTab";
import { SettingsTab } from "../components/tabs/SettingsTab";
import { SkillsTab } from "../components/tabs/SkillsTab";
import { WorkspaceTab } from "../components/tabs/WorkspaceTab";
import { AgentTab } from "../components/tabs/AgentTab";
import { OnboardingTab } from "../components/tabs/OnboardingTab";
import { MetricsTab } from "../components/tabs/MetricsTab";
import { McpIntegrationTab } from "../components/mcp/McpIntegrationTab";
import type { TabInstance, TabOfType, TabType } from "./types";

/** Ambient callbacks a tab view may need, supplied once by the workspace. */
export interface TabViewContext {
  executeNode: (nodeId: string, customPrompt?: string) => void;
  stopExecution: (nodeId: string) => void;
}

export interface TabViewProps<K extends TabType> {
  tab: TabOfType<K>;
  isActive: boolean;
  context: TabViewContext;
}

interface IconProps {
  size?: number;
  className?: string;
}

export interface TabViewEntry<K extends TabType> {
  Component: React.ComponentType<TabViewProps<K>>;
  Icon: React.ComponentType<IconProps>;
  /** Per-type icon, for types whose icon depends on the tab itself. */
  renderIcon?: (tab: TabOfType<K>, props: IconProps) => React.ReactNode;
  /** Drives the panel background and the tab strip's active styling. */
  surface: "editor" | "canvas";
}

type TabViewTable = { [K in TabType]: TabViewEntry<K> };

/** A view that takes no props at all. */
const plain = <K extends TabType>(
  Component: React.ComponentType,
  Icon: React.ComponentType<IconProps>,
): TabViewEntry<K> => ({
  Component: () => <Component />,
  Icon,
  surface: "editor",
});

export const TAB_VIEWS: TabViewTable = {
  canvas: {
    // Thin adapter, so RustyTab keeps its own prop shape and this table stays
    // the only place that knows about TabViewContext.
    Component: ({ tab, context }) => (
      <RustyTab
        tab={tab}
        onExecuteNode={context.executeNode}
        onStopExecution={context.stopExecution}
      />
    ),
    Icon: RustyIcon,
    surface: "canvas",
  },
  file: {
    Component: ({ tab, isActive }) => <FileTab tab={tab} isActive={isActive} />,
    Icon: (props) => <FileIcon fileName="" {...props} />,
    renderIcon: (tab, props) => <FileIcon fileName={tab.title} {...props} />,
    surface: "editor",
  },
  task: {
    Component: ({ tab, isActive, context }) => (
      <TaskTab
        tab={tab}
        isActive={isActive}
        onExecuteNode={context.executeNode}
        onStopExecution={context.stopExecution}
      />
    ),
    Icon: Cpu,
    surface: "editor",
  },
  "git-diff": {
    Component: ({ tab, isActive }) => <GitDiffTab tab={tab} isActive={isActive} />,
    Icon: GitCommit,
    surface: "editor",
  },
  "git-history": {
    Component: ({ tab }) => <GitHistoryTab tab={tab} />,
    Icon: GitCommit,
    surface: "editor",
  },
  agent: {
    Component: ({ tab }) => <AgentTab tab={tab} />,
    Icon: Bot,
    surface: "editor",
  },
  "llm-setup": plain(LlmSetupTab, Cpu),
  skills: plain(SkillsTab, Wand2),
  "mcp-integration": plain(McpIntegrationTab, Plug),
  settings: plain(SettingsTab, Settings),
  workspace: plain(WorkspaceTab, FolderOpen),
  onboarding: plain(OnboardingTab, BookOpen),
  metrics: plain(MetricsTab, Gauge),
};

export function getTabView<K extends TabType>(type: K): TabViewEntry<K> {
  return TAB_VIEWS[type];
}

/** Renders a tab's icon, honouring any per-tab override. */
export const TabIcon: React.FC<{ tab: TabInstance } & IconProps> = ({ tab, ...props }) => {
  const view = TAB_VIEWS[tab.type] as TabViewEntry<TabType>;
  if (view.renderIcon) return <>{view.renderIcon(tab as never, props)}</>;
  const Icon = view.Icon;
  return <Icon {...props} />;
};

/** Renders a tab's panel. */
export const TabPanel: React.FC<{
  tab: TabInstance;
  isActive: boolean;
  context: TabViewContext;
}> = ({ tab, isActive, context }) => {
  const Component = (TAB_VIEWS[tab.type] as TabViewEntry<TabType>).Component;
  return <Component tab={tab as never} isActive={isActive} context={context} />;
};
