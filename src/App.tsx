import React, { useRef, useEffect, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { Workspace } from "./components/Workspace";
import { useWorkspaceStore } from "./store";
import { SearchPalette } from "./components/SearchPalette";
import { AlertModal } from "./components/AlertModal";
import { TerminalPanel } from "./components/TerminalPanel";
import { DevLogBridge } from "./components/shell/DevLogBridge";
import { GlobalShortcuts } from "./components/shell/GlobalShortcuts";
import { clampDrawerWidth } from "./preferences/shellLayout";
import styles from "./App.module.css";

// Mirrors Sidebar.view.tsx's RAIL_WIDTH -- see the comment there. Both are
// deleted together once the rail becomes an independent NavigationRail with
// its own CSS width (REFACTOR_PLAN.md PR 2).
const RAIL_WIDTH = 56;

function App() {
  const initTerminalState = useWorkspaceStore((state) => state.initTerminalState);
  const searchOpen = useWorkspaceStore((state) => state.searchOpen);
  const setSearchOpen = useWorkspaceStore((state) => state.setSearchOpen);

  const drawerWidth = useWorkspaceStore((state) => state.drawerWidth);
  const setDrawerWidth = useWorkspaceStore((state) => state.setDrawerWidth);

  // Hydrates drawerWidth from localStorage. Temporary here -- this moves into
  // AppBootstrapBoundary once that component exists, so it runs before the
  // shell's first paint instead of after.
  useEffect(() => {
    useWorkspaceStore.getState().hydrateUi();
  }, []);

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

  // Load secure configuration on startup
  useEffect(() => {
    useWorkspaceStore.getState().loadSecureConfig().then(() => {
      const rootPath = useWorkspaceStore.getState().rootPath;
      if (rootPath) {
        useWorkspaceStore.getState().loadSkills().catch((err) => {
          console.error("Failed to load skills on startup:", err);
        });
      }
    }).catch((err) => {
      console.error("Failed to load secure configuration on startup:", err);
    });
  }, []);

  // Initialize terminal bar state
  useEffect(() => {
    initTerminalState(import.meta.env.DEV);
  }, [initTerminalState]);

  return (
    <div className={`ide-typography-scope ${styles.app}`}>
      <DevLogBridge />
      <GlobalShortcuts />

      {/* 1. Header Bar */}
      <Header onSearchOpen={() => setSearchOpen(true)} />

      {/* 2. Workspace Cards Content Area */}
      <div className={styles.workbench}>
        {/* Sidebar with explorer and icon dock */}
        <Sidebar
          onSidebarMouseDown={handleSidebarMouseDown}
          containerRef={sidebarElementRef}
        />

        {/* Main Workspace Card Panel */}
        <div className={styles.workspace}>
          {/* Workspace dynamic tabs and contents */}
          <Workspace />

          {/* Collapsible Bottom Terminal Panel (Pinned Globally) */}
          <TerminalPanel />
        </div>
      </div>
      {/* Search Command Palette Overlay */}
      {searchOpen && (
        <SearchPalette onClose={() => setSearchOpen(false)} />
      )}
      {/* Global alert modal (replaces native alert()) */}
      <AlertModal />
    </div>
  );
}

export default App;
