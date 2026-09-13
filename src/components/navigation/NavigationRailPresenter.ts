import { FolderOpen, Files, GitBranch, Cpu, Settings, Bot, Wand2, Plug, BookOpen, Gauge } from "lucide-react";
import React from "react";
import type { WorkspaceState } from "../../store";
import { RustyIcon } from "../RustyIcon";
import { formatCompactTokenCount } from "../../services/tokenFormat";

export type NavigationRailStoreState = Pick<
  WorkspaceState,
  "openTab" | "gitStatus" | "statusByRepositoryId" | "metricsTodayTotal" | "toggleDrawerView"
>;

export interface NavigationRailIconItem {
  id: string;
  label: string;
  icon: React.ComponentType<any>;
  onClick: (storeState: NavigationRailStoreState) => void;
  badgeCount?: (storeState: NavigationRailStoreState) => number;
  badgeText?: (storeState: NavigationRailStoreState) => string | undefined;
}

export const NAVIGATION_RAIL_ICONS: NavigationRailIconItem[] = [
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
      // Sums across every repository whose status has actually been loaded
      // into statusByRepositoryId (REFACTOR_PLAN.md PR 5b commit 20) --
      // covers submodules/worktrees the deprecated single-slot gitStatus
      // never could. Falls back to gitStatus only when nothing has been
      // mirrored into statusByRepositoryId yet (e.g. immediately at
      // startup, before discoverRepositories/loadGitStatus have both run),
      // so the badge doesn't regress to 0 during that brief window.
      const perRepositoryTotal = Object.values(store.statusByRepositoryId ?? {}).reduce(
        (sum, status) => sum + status.staged.length + status.unstaged.length,
        0,
      );
      if (perRepositoryTotal > 0) return perRepositoryTotal;
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
