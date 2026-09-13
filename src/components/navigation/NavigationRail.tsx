import React from "react";
import { useWorkspaceStore } from "../../store";
import { selectActiveTab, selectActiveTabId } from "../../store/tabSelectors";
import { useShallow } from "zustand/react/shallow";
import { NAVIGATION_RAIL_ICONS } from "./NavigationRailPresenter";
import { NavigationRailView } from "./NavigationRail.view";
import { formatShortcut } from "../../preferences/shortcuts";

/**
 * The activity bar: workspace/canvas/tab launchers plus the two drawer
 * toggles (Files, Source Control). A flat sibling of the shell's single
 * card -- see AppShell.module.css's `.surface` for why it left the card.
 */
export const NavigationRail: React.FC = () => {
  const activeTabId = useWorkspaceStore(selectActiveTabId);
  const activeTab = useWorkspaceStore(selectActiveTab);
  const isActiveTabCanvas = activeTab?.type === "canvas";
  const toggleExplorerShortcut = useWorkspaceStore((state) => state.keyboardShortcuts.toggleExplorer);
  const drawerOpen = useWorkspaceStore((state) => state.drawerOpen);
  const drawerView = useWorkspaceStore((state) => state.drawerView);

  const isItemActive = (id: string) => {
    switch (id) {
      case "workspace":
        return activeTabId === "workspace";
      case "explorer":
        return drawerOpen && drawerView === "explorer";
      case "git":
        return drawerOpen && drawerView === "git";
      case "rusty":
        return isActiveTabCanvas;
      case "agent":
        return activeTab?.type === "agent";
      case "llm-setup":
        return activeTabId === "llm-setup";
      case "skills":
        return activeTabId === "skills";
      case "mcp":
        return activeTabId === "mcp-integration";
      case "settings":
        return activeTabId === "settings";
      case "onboarding":
        return activeTab?.type === "onboarding";
      case "metrics":
        return activeTab?.type === "metrics";
      default:
        return false;
    }
  };

  const store = useWorkspaceStore(useShallow((state) => ({
    openTab: state.openTab,
    gitStatus: state.gitStatus,
    statusByRepositoryId: state.statusByRepositoryId,
    metricsTodayTotal: state.metricsTodayTotal,
    toggleDrawerView: state.toggleDrawerView,
  })));
  const topIcons = NAVIGATION_RAIL_ICONS
    .filter((item) => item.id !== "settings" && item.id !== "onboarding")
    .map((item) => item.id === "explorer"
      ? { ...item, label: `Files (${formatShortcut(toggleExplorerShortcut)})` }
      : item);
  const helpIcon = NAVIGATION_RAIL_ICONS.find((item) => item.id === "onboarding");
  const settingsIcon = NAVIGATION_RAIL_ICONS.find((item) => item.id === "settings");

  return (
    <NavigationRailView
      topIcons={topIcons}
      helpIcon={helpIcon}
      settingsIcon={settingsIcon}
      store={store}
      isItemActive={isItemActive}
    />
  );
};
