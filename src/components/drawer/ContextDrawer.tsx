import React from "react";
import { useWorkspaceStore } from "../../store";
import { invoke } from "@tauri-apps/api/core";
import { ContextDrawerView } from "./ContextDrawer.view";

interface ContextDrawerProps {
  containerRef?: React.RefObject<HTMLDivElement | null>;
  onResizerMouseDown: (e: React.MouseEvent) => void;
}

/**
 * The drawer half of the old Sidebar: Project Explorer / Source Control,
 * rendered only while `drawerOpen` -- which is what satisfies "the file
 * tree must not mount at launch" (REFACTOR_PLAN.md PR 2).
 */
export const ContextDrawer: React.FC<ContextDrawerProps> = ({ containerRef, onResizerMouseDown }) => {
  const fileTree = useWorkspaceStore((state) => state.fileTree);
  const setFileTree = useWorkspaceStore((state) => state.setFileTree);
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

  return (
    <ContextDrawerView
      drawerView={drawerView}
      drawerWidth={drawerWidth}
      fileTree={fileTree}
      containerRef={containerRef}
      handleRefreshExplorer={handleRefreshExplorer}
      handleCollapseAllFolders={handleCollapseAllFolders}
      handleCollapseDrawer={closeDrawer}
      onResizerMouseDown={onResizerMouseDown}
    />
  );
};
