import React, { useState, useRef, useEffect, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { Workspace } from "./components/Workspace";
import { useWorkspaceStore } from "./store";
import { requestCloseTab } from "./tabs/closeRequests";
import { SearchPalette } from "./components/SearchPalette";
import { AlertModal } from "./components/AlertModal";
import { TerminalPanel } from "./components/TerminalPanel";
import { matchesShortcut } from "./preferences/shortcuts";
import styles from "./App.module.css";

const MAX_CONSOLE_ARGUMENT_LENGTH = 2_000;
const MAX_CONSOLE_ENTRY_LENGTH = 8_000;
const MAX_CONSOLE_OBJECT_ENTRIES = 80;

function truncateConsoleText(value: string, limit = MAX_CONSOLE_ARGUMENT_LENGTH): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [${value.length - limit} chars omitted]`;
}

function formatConsoleArgument(value: unknown): string {
  if (typeof value === "string") return truncateConsoleText(value);
  if (value instanceof Error) return truncateConsoleText(value.stack || value.message);
  if (value === null || typeof value !== "object") return String(value);

  const seen = new WeakSet<object>();
  let visitedEntries = 0;
  try {
    const serialized = JSON.stringify(value, (key, nestedValue) => {
      if (key) visitedEntries += 1;
      if (visitedEntries > MAX_CONSOLE_OBJECT_ENTRIES) return "[Entry truncated]";
      if (typeof nestedValue === "string") return truncateConsoleText(nestedValue, 500);
      if (!nestedValue || typeof nestedValue !== "object") return nestedValue;
      if (seen.has(nestedValue)) return "[Circular]";
      seen.add(nestedValue);
      if (Array.isArray(nestedValue) && nestedValue.length > 30) {
        return [...nestedValue.slice(0, 30), `[${nestedValue.length - 30} items omitted]`];
      }
      return nestedValue;
    });
    return truncateConsoleText(serialized || String(value));
  } catch {
    return `[Unserializable ${value.constructor?.name || "object"}]`;
  }
}

function formatConsoleEntry(args: unknown[]): string {
  return truncateConsoleText(args.map(formatConsoleArgument).join(" "), MAX_CONSOLE_ENTRY_LENGTH);
}

function App() {
  const addDevLog = useWorkspaceStore((state) => state.addDevLog);
  const initTerminalState = useWorkspaceStore((state) => state.initTerminalState);
  const keyboardShortcuts = useWorkspaceStore((state) => state.keyboardShortcuts);
  const [searchOpen, setSearchOpen] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem("sidebar_width");
    if (stored) {
      const val = parseInt(stored, 10);
      if (!isNaN(val) && val >= 200 && val <= 600) {
        return val;
      }
    }
    return 320;
  });

  const [isSidebarExplorerOpen, setIsSidebarExplorerOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<"explorer" | "git">("explorer");
  const [lastSidebarWidth, setLastSidebarWidth] = useState(320);

  useEffect(() => {
    const handleReveal = () => {
      setSidebarView("explorer");
      setIsSidebarExplorerOpen(true);
      if (sidebarWidthRef.current <= 56) {
        const targetWidth = lastSidebarWidth > 56 ? lastSidebarWidth : 320;
        setSidebarWidth(targetWidth);
        sidebarWidthRef.current = targetWidth;
        if (sidebarElementRef.current) {
          sidebarElementRef.current.style.width = `${targetWidth}px`;
        }
      }
    };
    window.addEventListener("reveal-file-in-tree", handleReveal);
    return () => window.removeEventListener("reveal-file-in-tree", handleReveal);
  }, [lastSidebarWidth]);

  const toggleExplorer = useCallback(() => {
    if (!isSidebarExplorerOpen) {
      setSidebarView("explorer");
      setSidebarWidth(lastSidebarWidth);
      setIsSidebarExplorerOpen(true);
    } else if (sidebarView === "explorer") {
      setLastSidebarWidth(sidebarWidth);
      setSidebarWidth(56);
      setIsSidebarExplorerOpen(false);
    } else {
      setSidebarView("explorer");
    }
  }, [isSidebarExplorerOpen, sidebarView, sidebarWidth, lastSidebarWidth]);
  const isSidebarDraggingRef = useRef(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  const sidebarElementRef = useRef<HTMLDivElement>(null);

  const handleSidebarMouseMove = useCallback((moveEvent: MouseEvent) => {
    if (!isSidebarDraggingRef.current) return;
    const startX = (isSidebarDraggingRef as any)._startX as number;
    const startWidth = (isSidebarDraggingRef as any)._startWidth as number;
    const dx = moveEvent.clientX - startX;
    const newWidth = Math.max(200, Math.min(600, startWidth + dx));
    sidebarWidthRef.current = newWidth;
    // Directly mutate DOM — no React re-render
    if (sidebarElementRef.current) {
      sidebarElementRef.current.style.width = `${newWidth}px`;
    }
  }, []);

  const handleSidebarMouseUp = useCallback(() => {
    isSidebarDraggingRef.current = false;
    document.removeEventListener("mousemove", handleSidebarMouseMove);
    document.removeEventListener("mouseup", handleSidebarMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // Commit the final width to React state once
    setSidebarWidth(sidebarWidthRef.current);
  }, [handleSidebarMouseMove]);

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

  // Keep widthRef in sync when state changes (e.g. from collapse/expand buttons)
  // and save active sidebar width if expanded
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
    if (sidebarWidth > 56) {
      localStorage.setItem("sidebar_width", String(sidebarWidth));
    }
  }, [sidebarWidth]);

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

  // Global console/rejection interceptor
  useEffect(() => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    console.log = (...args: any[]) => {
      const text = formatConsoleEntry(args);
      originalLog(text);
      addDevLog("log", text);
    };

    console.error = (...args: any[]) => {
      const text = formatConsoleEntry(args);
      originalError(text);
      addDevLog("error", text);
    };

    console.warn = (...args: any[]) => {
      const text = formatConsoleEntry(args);
      originalWarn(text);
      addDevLog("warn", text);
    };

    const handleWindowError = (event: ErrorEvent) => {
      addDevLog("error", `Uncaught Error: ${event.message} at ${event.filename}:${event.lineno}`);
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const text = reason instanceof Error ? reason.stack || reason.message : String(reason);
      addDevLog("error", `Unhandled Promise Rejection: ${text}`);
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    addDevLog("system", "Developer Terminal capturing logs.");

    return () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, [addDevLog]);



  // Global user-configurable shortcuts.
  // Also blocks reload (Cmd/Ctrl+R, F5) and devtools (F12, Cmd/Ctrl+Shift+I/J/C, Cmd/Ctrl+Alt+I)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const target = e.target instanceof Element ? e.target : null;

      // Shortcut recorders own the keystroke while focused.
      if (target?.closest("[data-shortcut-recorder]")) return;

      // Reload (hard + soft)
      if (mod && key === "r") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // DevTools shortcuts
      if (e.key === "F12") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (mod && e.shiftKey && (key === "i" || key === "j" || key === "c")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (mod && e.altKey && key === "i") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // View-source (Cmd/Ctrl+U)
      if (mod && key === "u") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (matchesShortcut(e, keyboardShortcuts.closeActiveTab)) {
        e.preventDefault();
        e.stopPropagation();

        const currentActive = useWorkspaceStore.getState().activeTabId;
        if (currentActive) {
          // Goes through the shared close channel rather than the raw store
          // action, so the unsaved/running guards apply to the keyboard path
          // too. They did not before.
          requestCloseTab(currentActive);
        }
      } else if (matchesShortcut(e, keyboardShortcuts.openSearch)) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
      } else if (matchesShortcut(e, keyboardShortcuts.toggleExplorer)) {
        e.preventDefault();
        e.stopPropagation();
        toggleExplorer();
      }
    };

    // Disable the right-click context menu across the entire application so the
    // user cannot access "Reload", "Inspect Element", or view the UI's HTML.
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("contextmenu", handleContextMenu);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [keyboardShortcuts, toggleExplorer]);

  return (
    <div className={`ide-typography-scope ${styles.app}`}>
      {/* 1. Header Bar */}
      <Header onSearchOpen={() => setSearchOpen(true)} />

      {/* 2. Workspace Cards Content Area */}
      <div className={styles.workbench}>
        {/* Sidebar with explorer and icon dock */}
        <Sidebar
          sidebarWidth={sidebarWidth}
          setSidebarWidth={setSidebarWidth}
          onSidebarMouseDown={handleSidebarMouseDown}
          containerRef={sidebarElementRef}
          isExplorerOpen={isSidebarExplorerOpen}
          setIsExplorerOpen={setIsSidebarExplorerOpen}
          sidebarView={sidebarView}
          setSidebarView={setSidebarView}
          lastWidth={lastSidebarWidth}
          setLastWidth={setLastSidebarWidth}
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
