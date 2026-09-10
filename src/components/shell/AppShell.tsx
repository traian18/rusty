import { useRef, useEffect, useCallback } from "react";
import { useWorkspaceStore } from "../../store";
import { clampDrawerWidth } from "../../preferences/shellLayout";
import { AppShellView } from "./AppShell.view";

// Mirrors Sidebar.view.tsx's RAIL_WIDTH -- see the comment there. Both are
// deleted together once the rail becomes an independent NavigationRail with
// its own CSS width (REFACTOR_PLAN.md PR 2).
const RAIL_WIDTH = 56;

/**
 * The application shell: header, navigation, the context drawer, and the
 * main workspace. Everything App.tsx used to render directly now lives here,
 * mounted only once AppBootstrapBoundary reaches "ready".
 */
export const AppShell: React.FC = () => {
  const searchOpen = useWorkspaceStore((state) => state.searchOpen);
  const setSearchOpen = useWorkspaceStore((state) => state.setSearchOpen);

  const drawerWidth = useWorkspaceStore((state) => state.drawerWidth);
  const setDrawerWidth = useWorkspaceStore((state) => state.setDrawerWidth);

  useEffect(() => {
    const handleReveal = () => {
      useWorkspaceStore.getState().openDrawer("explorer");
    };
    window.addEventListener("reveal-file-in-tree", handleReveal);
    return () => window.removeEventListener("reveal-file-in-tree", handleReveal);
  }, []);

  const isSidebarDraggingRef = useRef(false);
  const sidebarWidthRef = useRef(drawerWidth);
  const sidebarElementRef = useRef<HTMLDivElement>(null);

  const handleSidebarMouseMove = useCallback((moveEvent: MouseEvent) => {
    if (!isSidebarDraggingRef.current) return;
    const startX = (isSidebarDraggingRef as any)._startX as number;
    const startWidth = (isSidebarDraggingRef as any)._startWidth as number;
    const dx = moveEvent.clientX - startX;
    const newWidth = clampDrawerWidth(startWidth + dx);
    sidebarWidthRef.current = newWidth;
    // Directly mutate DOM — no React re-render
    if (sidebarElementRef.current) {
      sidebarElementRef.current.style.width = `${RAIL_WIDTH + newWidth}px`;
    }
  }, []);

  const handleSidebarMouseUp = useCallback(() => {
    isSidebarDraggingRef.current = false;
    document.removeEventListener("mousemove", handleSidebarMouseMove);
    document.removeEventListener("mouseup", handleSidebarMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // Commit the final width once. setDrawerWidth clamps and persists.
    setDrawerWidth(sidebarWidthRef.current);
  }, [handleSidebarMouseMove, setDrawerWidth]);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isSidebarDraggingRef.current = true;
    (isSidebarDraggingRef as any)._startX = e.clientX;
    (isSidebarDraggingRef as any)._startWidth = sidebarWidthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleSidebarMouseMove);
    document.addEventListener("mouseup", handleSidebarMouseUp);
  }, [handleSidebarMouseMove, handleSidebarMouseUp]);

  // Keep widthRef in sync when drawerWidth changes elsewhere (e.g. hydration).
  useEffect(() => {
    sidebarWidthRef.current = drawerWidth;
  }, [drawerWidth]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", handleSidebarMouseMove);
      document.removeEventListener("mouseup", handleSidebarMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [handleSidebarMouseMove, handleSidebarMouseUp]);

  return (
    <AppShellView
      searchOpen={searchOpen}
      onSearchOpen={() => setSearchOpen(true)}
      onSearchClose={() => setSearchOpen(false)}
      onSidebarMouseDown={handleSidebarMouseDown}
      sidebarElementRef={sidebarElementRef}
    />
  );
};
