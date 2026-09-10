import { FolderOpen, Files, GitBranch, Cpu, Settings, Bot, Wand2, Plug, BookOpen, Gauge } from "lucide-react";
import React from "react";
import type { WorkspaceState } from "../../store";
import { RustyIcon } from "../RustyIcon";
import { formatCompactTokenCount } from "../../services/tokenFormat";

export type SidebarStoreState = Pick<
  WorkspaceState,
  "openTab" | "gitStatus" | "metricsTodayTotal" | "toggleDrawerView"
>;

export interface SidebarIconItem {
  id: string;
  label: string;
  icon: React.ComponentType<any>;
  onClick: (storeState: SidebarStoreState) => void;
  badgeCount?: (storeState: SidebarStoreState) => number;
  badgeText?: (storeState: SidebarStoreState) => string | undefined;
}

export const SIDEBAR_ICONS: SidebarIconItem[] = [
  {
    id: "workspace",
    label: "Open Workspace",
    icon: FolderOpen,
    onClick: (store) => {
      store.openTab({ type: "workspace" });
    },
  },
  {
    id: "explorer",
    label: "Files",
    icon: Files,
    onClick: (store) => {
      store.toggleDrawerView("explorer");
    },
  },
  {
    id: "git",
    label: "Source Control",
    icon: GitBranch,
    badgeCount: (store) => {
      return store.gitStatus ? store.gitStatus.staged.length + store.gitStatus.unstaged.length : 0;
    },
    onClick: (store) => {
      store.toggleDrawerView("git");
    },
  },
  {
    id: "rusty",
    label: "Rusty Canvas",
    icon: RustyIcon,
    onClick: (store) => {
      store.openTab({ type: "canvas" });
    },
  },
  {
    id: "agent",
    label: "Agent Mode",
    icon: Bot,
    onClick: (store) => {
      store.openTab({ type: "agent" });
    },
  },
  {
    id: "llm-setup",
    label: "LLM Integrations",
    icon: Cpu,
    onClick: (store) => {
      store.openTab({ type: "llm-setup" });
    },
  },
  {
    id: "skills",
    label: "Skills",
    icon: Wand2,
    onClick: (store) => {
      store.openTab({ type: "skills" });
    },
  },
  {
    id: "mcp",
    label: "MCP Integration",
    icon: Plug,
    onClick: (store) => {
      store.openTab({ type: "mcp-integration" });
    },
  },
  {
    id: "onboarding",
    label: "Rusty Guide",
    icon: BookOpen,
    onClick: (store) => {
      store.openTab({ type: "onboarding" });
    },
  },
  {
    id: "metrics",
    label: "Token Metrics",
    icon: Gauge,
    badgeText: (store) => store.metricsTodayTotal > 0 ? formatCompactTokenCount(store.metricsTodayTotal) : undefined,
    onClick: (store) => {
      store.openTab({ type: "metrics" });
    },
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    onClick: (store) => {
      store.openTab({ type: "settings" });
    },
  },
];
