import React from "react";
import { useWorkspaceStore } from "../store";
import { selectActiveTab, selectActiveTabId } from "../store/tabSelectors";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { SIDEBAR_ICONS } from "./sidebar/SidebarPresenter";
import { SidebarView } from "./Sidebar.view";
import { formatShortcut } from "../preferences/shortcuts";

interface SidebarProps {
  containerRef?: React.RefObject<HTMLDivElement | null>;
  onSidebarMouseDown: (e: React.MouseEvent) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ containerRef, onSidebarMouseDown }) => {
  const fileTree = useWorkspaceStore((state) => state.fileTree);
  const setFileTree = useWorkspaceStore((state) => state.setFileTree);
  const activeTabId = useWorkspaceStore(selectActiveTabId);
  const activeTab = useWorkspaceStore(selectActiveTab);
  const isActiveTabCanvas = activeTab?.type === "canvas";
  const toggleExplorerShortcut = useWorkspaceStore((state) => state.keyboardShortcuts.toggleExplorer);
  const drawerOpen = useWorkspaceStore((state) => state.drawerOpen);
  const drawerView = useWorkspaceStore((state) => state.drawerView);
  const drawerWidth = useWorkspaceStore((state) => state.drawerWidth);
  const closeDrawer = useWorkspaceStore((state) => state.closeDrawer);

  const handleCollapseAllFolders = () => {
    useWorkspaceStore.getState().collapseAllFolders();
  };

  const handleRefreshExplorer = async () => {
    const rootPath = useWorkspaceStore.getState().rootPath;
    if (!rootPath) return;
    try {
      const tree: any[] = await invoke("get_directory_structure", { rootDir: rootPath });
      setFileTree(tree);
      await useWorkspaceStore.getState().loadGitStatus();
    } catch (err) {
      console.error("Failed to refresh explorer:", err);
    }
  };

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
    metricsTodayTotal: state.metricsTodayTotal,
    toggleDrawerView: state.toggleDrawerView,
  })));
  const topIcons = SIDEBAR_ICONS
    .filter((item) => item.id !== "settings" && item.id !== "onboarding")
    .map((item) => item.id === "explorer"
      ? { ...item, label: `Files (${formatShortcut(toggleExplorerShortcut)})` }
      : item);
  const helpIcon = SIDEBAR_ICONS.find((item) => item.id === "onboarding");
  const settingsIcon = SIDEBAR_ICONS.find((item) => item.id === "settings");

  return (
    <SidebarView
      drawerOpen={drawerOpen}
      drawerView={drawerView}
      drawerWidth={drawerWidth}
      fileTree={fileTree}
      containerRef={containerRef}
      topIcons={topIcons}
      helpIcon={helpIcon}
      settingsIcon={settingsIcon}
      store={store}
      isItemActive={isItemActive}
      handleRefreshExplorer={handleRefreshExplorer}
      handleCollapseAllFolders={handleCollapseAllFolders}
      handleCollapseSidebar={closeDrawer}
      onSidebarMouseDown={onSidebarMouseDown}
    />
  );
};
