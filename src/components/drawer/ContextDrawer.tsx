import React, { useCallback } from "react";
import { useWorkspaceStore } from "../../store";
import { invoke } from "@tauri-apps/api/core";
import { clampDrawerWidth, DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH } from "../../preferences/shellLayout";
import { ContextDrawerView } from "./ContextDrawer.view";

interface ContextDrawerProps {
  containerRef?: React.RefObject<HTMLDivElement | null>;
  onResizerMouseDown: (e: React.MouseEvent) => void;
}

// Arrow-key / Shift+Arrow-key resize steps, in px.
const RESIZE_STEP = 8;
const RESIZE_STEP_LARGE = 32;

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
  const setDrawerWidth = useWorkspaceStore((state) => state.setDrawerWidth);

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

  // Keyboard resizing lives here rather than in AppShell's mouse-drag ref
  // machinery: each key press is a discrete, already-cheap state update
  // (unlike a drag's per-pixel mousemove), so there's no reason to bypass
  // React and no shared ref state to coordinate with the drag handlers.
  const handleResizerKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setDrawerWidth(clampDrawerWidth(useWorkspaceStore.getState().drawerWidth - step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setDrawerWidth(clampDrawerWidth(useWorkspaceStore.getState().drawerWidth + step));
    } else if (e.key === "Home") {
      e.preventDefault();
      setDrawerWidth(DRAWER_MIN_WIDTH);
    } else if (e.key === "End") {
      e.preventDefault();
      setDrawerWidth(DRAWER_MAX_WIDTH);
    }
  }, [setDrawerWidth]);

  // Escape closes the drawer and returns focus to the rail button that
  // opened it -- written mode-agnostically (no docked/overlay branch)
  // per REFACTOR_PLAN.md PR 2. Ignored when the key originated in a form
  // control (e.g. FileTree's inline rename input), which already owns
  // Escape for its own "cancel edit" behavior.
  const handleDrawerKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    closeDrawer();
    document.getElementById(`sidebar-${drawerView}`)?.focus();
  }, [closeDrawer, drawerView]);

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
      onResizerKeyDown={handleResizerKeyDown}
      onDrawerKeyDown={handleDrawerKeyDown}
    />
  );
};
