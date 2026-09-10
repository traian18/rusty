import React, { useRef, useEffect, useState, useCallback } from "react";
import { X, Plus } from "lucide-react";
import { useWorkspaceStore } from "../store";
import { LocalTerminal } from "./LocalTerminal";
import { Tooltip } from "./ui";
import styles from "./TerminalPanel.module.css";

export const TerminalPanel: React.FC = () => {
  const devLogs = useWorkspaceStore((state) => state.devLogs);
  const showDevConsole = useWorkspaceStore((state) => state.showDevConsole);
  const setShowDevConsole = useWorkspaceStore((state) => state.setShowDevConsole);
  const clearDevLogs = useWorkspaceStore((state) => state.clearDevLogs);
  
  const terminalTabs = useWorkspaceStore((state) => state.terminalTabs);
  const activeTerminalTabId = useWorkspaceStore((state) => state.activeTerminalTabId);
  const addTerminalTab = useWorkspaceStore((state) => state.addTerminalTab);
  const closeTerminalTab = useWorkspaceStore((state) => state.closeTerminalTab);
  const setActiveTerminalTabId = useWorkspaceStore((state) => state.setActiveTerminalTabId);

  const consoleScrollRef = useRef<HTMLDivElement>(null);

  // Height Resizing logic
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const stored = localStorage.getItem("terminal_height");
    if (stored) {
      const val = parseInt(stored, 10);
      if (!isNaN(val) && val >= 100 && val <= 800) {
        return val;
      }
    }
    return 240;
  });

  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(240);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingRef.current) return;
    const dy = e.clientY - startYRef.current;
    const newHeight = Math.max(100, Math.min(800, startHeightRef.current - dy));
    setTerminalHeight(newHeight);
  }, []);

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    setIsDragging(false);
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, [handleMouseMove]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    startYRef.current = e.clientY;
    startHeightRef.current = terminalHeight;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [terminalHeight, handleMouseMove, handleMouseUp]);

  // Save to local storage when height changes
  useEffect(() => {
    localStorage.setItem("terminal_height", String(terminalHeight));
  }, [terminalHeight]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // Auto-scroll dev logs
  useEffect(() => {
    if (showDevConsole && activeTerminalTabId === "dev-logs" && consoleScrollRef.current) {
      consoleScrollRef.current.scrollTop = consoleScrollRef.current.scrollHeight;
    }
  }, [devLogs, showDevConsole, activeTerminalTabId]);

  const activeTab = terminalTabs.find((t) => t.id === activeTerminalTabId);

  return (
    <div
      style={{ height: showDevConsole ? `${terminalHeight}px` : "36px" }}
      className={`${styles.panel} ${isDragging ? "" : styles.animated}`}
    >
      {/* Top Drag Resizer Handle */}
      {showDevConsole && (
        <div
          onMouseDown={handleMouseDown}
          className={styles.resizer}
        />
      )}

      {/* Header Bar */}
      <div
        onClick={() => setShowDevConsole(!showDevConsole)}
        className={styles.header}
      >
        {/* Left Section: Tabs + Plus Button */}
        <div className={styles.tabArea} onClick={(e) => e.stopPropagation()}>
          <div className={`${styles.tabs} scrollbar-none`}>
            {terminalTabs.map((tab) => {
              const isActive = tab.id === activeTerminalTabId;
              return (
                <div
                  key={tab.id}
                  onClick={() => {
                    setActiveTerminalTabId(tab.id);
                    if (!showDevConsole) {
                      setShowDevConsole(true);
                    }
                  }}
                  className={`${styles.tab} ${isActive ? styles.activeTab : ""}`}
                >
                  {/* Top line indicator for active tab */}
                  {isActive && (
                    <div className={styles.tabAccent} />
                  )}

                  {tab.type === "dev-logs" && (
                    <span
                      className={`${styles.status} ${devLogs.some((l) => l.type === "error") ? styles.statusError : ""}`}
                    />
                  )}
                  <span>{tab.name}</span>
                  
                  {tab.type !== "dev-logs" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTerminalTab(tab.id);
                      }}
                      className={styles.close}
                      aria-label={`Close ${tab.name}`}
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <Tooltip id="terminal-new-tooltip" label="New Terminal" placement="top">
            <button
              id="terminal-new"
              type="button"
              onClick={() => addTerminalTab("local")}
              className={styles.newTerminal}
              aria-label="New Terminal"
            >
              <Plus size={13} />
            </button>
          </Tooltip>
        </div>

        {/* Right Section: Clear button + Expand/Collapse */}
        <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
          {activeTab?.type === "dev-logs" && (
            <button
              onClick={clearDevLogs}
              className={`${styles.action} ${styles.outlined}`}
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setShowDevConsole(!showDevConsole)}
            className={styles.action}
          >
            {showDevConsole ? "[ Collapse ]" : "[ Expand ]"}
          </button>
        </div>
      </div>

      {/* Terminal / Logs Content */}
      <div className={`${styles.content} ${showDevConsole ? "" : styles.hidden}`}>
        {terminalTabs.length === 0 ? (
          <div className={styles.empty}>
            <span>No active terminals</span>
            <button
              onClick={() => addTerminalTab("local")}
              className={styles.primary}
            >
              Open Terminal
            </button>
          </div>
        ) : (
          terminalTabs.map((tab) => {
            const isActive = tab.id === activeTerminalTabId;

            if (tab.type === "dev-logs") {
              return (
                <div
                  key={tab.id}
                  ref={consoleScrollRef}
                  style={{ display: isActive ? "block" : "none" }}
                  className={styles.logs}
                >
                  {devLogs.length === 0 ? (
                    <span className={styles.emptyLogs}>// No dev console logs captured yet.</span>
                  ) : (
                    devLogs.map((log) => {
                      const colors = {
                        log: styles.log,
                        warn: styles.warn,
                        error: styles.error,
                        system: styles.system,
                      };
                      return (
                        <div
                          key={log.id}
                          className={styles.logRow}
                        >
                          <span className={styles.timestamp}>[{log.timestamp}]</span>
                          <span className={colors[log.type]}>{log.text}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            } else {
              return (
                <div
                  key={tab.id}
                  style={{ display: isActive ? "block" : "none" }}
                  className={styles.terminal}
                >
                  <LocalTerminal
                    sessionId={tab.id}
                    cwd={tab.cwd}
                    isActive={isActive}
                  />
                </div>
              );
            }
          })
        )}
      </div>
    </div>
  );
};
