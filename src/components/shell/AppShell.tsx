import { useRef, useEffect, useCallback } from "react";
import { useWorkspaceStore } from "../../store";
import { clampDrawerWidth } from "../../preferences/shellLayout";
import { AppShellView } from "./AppShell.view";

/**
 * The application shell: header, navigation, the context drawer, and the
 * main workspace. Everything App.tsx used to render directly now lives here,
 * mounted only once AppBootstrapBoundary reaches "ready".
 */
export const AppShell: React.FC = () => {
  const searchOpen = useWorkspaceStore((state) => state.searchOpen);
  const setSearchOpen = useWorkspaceStore((state) => state.setSearchOpen);

  const drawerOpen = useWorkspaceStore((state) => state.drawerOpen);
  const drawerWidth = useWorkspaceStore((state) => state.drawerWidth);
  const setDrawerWidth = useWorkspaceStore((state) => state.setDrawerWidth);

  useEffect(() => {
    const handleReveal = () => {
      useWorkspaceStore.getState().openDrawer("explorer");
    };
    window.addEventListener("reveal-file-in-tree", handleReveal);
    return () => window.removeEventListener("reveal-file-in-tree", handleReveal);
  }, []);

  const isDraggingRef = useRef(false);
  const drawerWidthRef = useRef(drawerWidth);
  const drawerElementRef = useRef<HTMLDivElement>(null);

  const handleDrawerResizeMouseMove = useCallback((moveEvent: MouseEvent) => {
    if (!isDraggingRef.current) return;
    const startX = (isDraggingRef as any)._startX as number;
    const startWidth = (isDraggingRef as any)._startWidth as number;
    const dx = moveEvent.clientX - startX;
    const newWidth = clampDrawerWidth(startWidth + dx);
    drawerWidthRef.current = newWidth;
    // Directly mutate DOM — no React re-render. The rail no longer shares
    // this width (it left the card in PR 2's commit 11), so this is the
    // drawer's own width, not rail-plus-drawer.
    if (drawerElementRef.current) {
      drawerElementRef.current.style.width = `${newWidth}px`;
    }
  }, []);

  const handleDrawerResizeMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    document.removeEventListener("mousemove", handleDrawerResizeMouseMove);
    document.removeEventListener("mouseup", handleDrawerResizeMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // Commit the final width once. setDrawerWidth clamps and persists.
    setDrawerWidth(drawerWidthRef.current);
  }, [handleDrawerResizeMouseMove, setDrawerWidth]);

  const handleDrawerResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    (isDraggingRef as any)._startX = e.clientX;
    (isDraggingRef as any)._startWidth = drawerWidthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleDrawerResizeMouseMove);
    document.addEventListener("mouseup", handleDrawerResizeMouseUp);
  }, [handleDrawerResizeMouseMove, handleDrawerResizeMouseUp]);

  // Keep widthRef in sync when drawerWidth changes elsewhere (e.g. hydration).
  useEffect(() => {
    drawerWidthRef.current = drawerWidth;
  }, [drawerWidth]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", handleDrawerResizeMouseMove);
      document.removeEventListener("mouseup", handleDrawerResizeMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [handleDrawerResizeMouseMove, handleDrawerResizeMouseUp]);

  return (
    <AppShellView
      searchOpen={searchOpen}
      onSearchOpen={() => setSearchOpen(true)}
      onSearchClose={() => setSearchOpen(false)}
      drawerOpen={drawerOpen}
      onDrawerResizeMouseDown={handleDrawerResizeMouseDown}
      drawerElementRef={drawerElementRef}
    />
  );
};
