import React, { useState, useEffect } from "react";
import { FolderOpen, History, Trash2, ArrowRight, Plus } from "lucide-react";
import { useWorkspaceStore } from "../../store";
import { notify } from "../../notificationStore";

export const WorkspaceTab: React.FC = () => {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const setRootPath = useWorkspaceStore((state) => state.setRootPath);
  const setFileTree = useWorkspaceStore((state) => state.setFileTree);
  
  const [recents, setRecents] = useState<string[]>([]);

  // Load recents on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem("previous_workspaces");
      if (stored) {
        setRecents(JSON.parse(stored));
      }
    } catch (e) {
      console.error("Failed to read previous workspaces:", e);
    }
  }, []);

  const updateRecents = (path: string) => {
    try {
      const stored = localStorage.getItem("previous_workspaces");
      const list: string[] = stored ? JSON.parse(stored) : [];
      const filtered = list.filter((p) => p !== path);
      filtered.unshift(path);
      if (filtered.length > 10) filtered.pop();
      localStorage.setItem("previous_workspaces", JSON.stringify(filtered));
      setRecents(filtered);
    } catch (e) {
      console.error("Failed to update previous workspaces:", e);
    }
  };

  const handleRemoveRecent = (e: React.MouseEvent, pathToRemove: string) => {
    e.stopPropagation();
    const updated = recents.filter((p) => p !== pathToRemove);
    setRecents(updated);
    try {
      localStorage.setItem("previous_workspaces", JSON.stringify(updated));
    } catch (err) {
      console.error("Failed to save updated previous workspaces:", err);
    }
  };

  const handleOpenWorkspace = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Workspace Folder",
      });
      if (selected && typeof selected === "string") {
        await loadWorkspace(selected);
      }
    } catch (err: any) {
      console.error("Failed to open directory dialog:", err);
    }
  };

  const loadWorkspace = async (path: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const tree: any[] = await invoke("get_directory_structure", { rootDir: path });
      
      setFileTree(tree);
      setRootPath(path);
      updateRecents(path);
    } catch (err) {
      console.error("Failed to load workspace folder:", err);
      notify("Error", `Failed to load workspace directory: ${err}`, "error");
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8 font-sans text-[var(--text-normal)] h-full overflow-y-auto">
      {/* Welcome Header */}
      <div className="space-y-2">
        <h2 className="text-2xl font-black tracking-tight text-[var(--text-light)]">Workspace Manager</h2>
        <p className="text-xs text-[var(--text-muted)] font-mono">
          {rootPath ? `Currently loaded: ${rootPath}` : "Get started by opening a local project folder"}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Open Workspace Action Card */}
        <div className="md:col-span-1 space-y-4">
          <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider font-mono">Actions</h3>
          <div className="space-y-3">
            <div
              onClick={handleOpenWorkspace}
              className="group flex flex-col justify-between p-6 h-48 rounded-2xl bg-[var(--bg-sidebar)] border border-[var(--border-color)] hover:border-[var(--accent-color)] hover:shadow-xl cursor-pointer transition-all duration-300 relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-[var(--accent-color)]/5 rounded-bl-full pointer-events-none group-hover:bg-[var(--accent-color)]/10 transition-colors" />
              <div className="w-10 h-10 rounded-xl bg-[var(--bg-app)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-color)] group-hover:scale-110 transition-transform">
                <FolderOpen size={20} />
              </div>
              <div>
                <div className="text-sm font-bold text-[var(--text-light)] flex items-center gap-1.5 group-hover:text-[var(--accent-color)] transition-colors">
                  Open Workspace <ArrowRight size={14} className="opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                </div>
                <p className="text-[11px] text-[var(--text-muted)] mt-1.5 leading-relaxed font-mono">
                  Select a folder on your system to begin editing and orchestrating flows.
                </p>
              </div>
            </div>

            {rootPath && (
              <div
                onClick={() => useWorkspaceStore.getState().openTab({ type: "canvas" })}
                className="group flex flex-col justify-between p-6 h-48 rounded-2xl bg-[var(--bg-sidebar)] border border-[var(--border-color)] hover:border-[var(--color-status-success-border)] hover:shadow-xl cursor-pointer transition-all duration-300 relative overflow-hidden"
              >
                <div className="absolute top-0 right-0 w-24 h-24 bg-[var(--color-status-success-bg)] rounded-bl-full pointer-events-none group-hover:bg-[var(--color-status-success-bg)] transition-colors" />
                <div className="w-10 h-10 rounded-xl bg-[var(--bg-app)] border border-[var(--border-color)] flex items-center justify-center text-[var(--color-status-success)] group-hover:scale-110 transition-transform">
                  <Plus size={20} />
                </div>
                <div>
                  <div className="text-sm font-bold text-[var(--text-light)] flex items-center gap-1.5 group-hover:text-[var(--color-status-success)] transition-colors">
                    New Rusty <ArrowRight size={14} className="opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)] mt-1.5 leading-relaxed font-mono">
                    Create a new Rusty canvas tab to build and run AI tasks.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Previous Workspaces List */}
        <div className="md:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider font-mono flex items-center gap-1.5">
              <History size={13} /> Recent Workspaces
            </h3>
            {recents.length > 0 && (
              <span className="text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-sidebar)] border border-[var(--border-color)] px-2 py-0.5 rounded-full">
                {recents.length} projects
              </span>
            )}
          </div>

          <div className="space-y-2.5">
            {recents.length === 0 ? (
              <div className="text-center py-12 rounded-2xl border border-dashed border-[var(--border-color)] text-xs text-[var(--text-muted)] font-mono">
                No recent workspaces found
              </div>
            ) : (
              recents.map((path) => {
                const folderName = path.split(/[/\\]/).pop() || path;
                const isActive = path === rootPath;
                return (
                  <div
                    key={path}
                    onClick={() => loadWorkspace(path)}
                    className={`group flex items-center justify-between p-4 rounded-xl border transition-all cursor-pointer ${
                      isActive
                        ? "bg-[var(--accent-bg)]/10 border-[var(--accent-color)]/50 hover:bg-[var(--accent-bg)]/20"
                        : "bg-[var(--bg-sidebar)] border-[var(--border-color)] hover:border-[var(--border-active)] hover:bg-[var(--bg-app)]/30"
                    }`}
                  >
                    <div className="flex items-center space-x-3.5 min-w-0">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border ${
                        isActive
                          ? "bg-[var(--accent-color)]/25 text-[var(--accent-color)] border-[var(--accent-color)]/30"
                          : "bg-[var(--bg-app)] text-[var(--text-muted)] border-[var(--border-color)] group-hover:text-[var(--text-light)]"
                      }`}>
                        <FolderOpen size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-[var(--text-light)] truncate flex items-center gap-2">
                          {folderName}
                          {isActive && (
                            <span className="text-[9px] font-mono font-bold bg-[var(--accent-color)]/20 text-[var(--accent-color)] px-1.5 py-0.25 rounded">
                              Active
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-[var(--text-muted)] font-mono truncate mt-0.5" title={path}>
                          {path}
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={(e) => handleRemoveRecent(e, path)}
                      className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--color-status-danger)] hover:bg-[var(--color-status-danger-bg)] opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
                      title="Remove from Recents"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
