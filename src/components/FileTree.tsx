import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Folder,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Plus,
  FolderPlus,
  Trash2,
  Pencil,
  FolderInput,
  ExternalLink,
  FilePlus,
  TreePine,
  EyeOff
} from "lucide-react";
import { useWorkspaceStore } from "../store";
import { selectActiveFilePath, selectActiveTabId } from "../store/tabSelectors";
import { fileTabIdentity } from "../tabs/identity";
import { FileIcon } from "../services/fileTypeService";
import { invoke } from "@tauri-apps/api/core";
import { MoveDialog } from "./MoveDialog";
import { CreateDialog } from "./CreateDialog";
import { notify } from "../notificationStore";
import { useConfirm } from "./useConfirm";
import { gitPresenter } from "./git/GitPresenter";

import { fileTreePresenter, refreshTree } from "./filetree/FileTreePresenter";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
}

interface FileTreeProps {
  entries: FileEntry[];
}

interface GitState {
  colorClass: string;
  char: string;
  label: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: any;
}

const getGitState = (node: any, gitStatus: any): GitState | null => {
  if (!gitStatus) return null;
  
  if (node.is_dir) {
    const hasUnstaged = gitStatus.unstaged.some((f: any) => f.path.startsWith(node.path + "/"));
    const hasStaged = gitStatus.staged.some((f: any) => f.path.startsWith(node.path + "/"));
    
    if (hasUnstaged && hasStaged) {
      return { colorClass: "text-[var(--color-status-warning)]", char: "•", label: "Modified & Staged contents" };
    }
    if (hasUnstaged) {
      const isUntrackedOnly = !gitStatus.unstaged.some((f: any) => f.path.startsWith(node.path + "/") && f.status_type !== "untracked");
      if (isUntrackedOnly) {
        return { colorClass: "text-[var(--color-status-success)]", char: "•", label: "Untracked contents" };
      }
      return { colorClass: "text-[var(--color-status-warning)]", char: "•", label: "Modified contents" };
    }
    if (hasStaged) {
      return { colorClass: "text-[var(--color-status-success)]", char: "•", label: "Staged contents" };
    }
    return null;
  } else {
    const staged = gitStatus.staged.find((f: any) => f.path === node.path);
    const unstaged = gitStatus.unstaged.find((f: any) => f.path === node.path);
 
    if (staged && unstaged) {
      return { colorClass: "text-[var(--color-status-warning)] font-bold", char: "M", label: "Staged & Modified" };
    }
    if (unstaged) {
      if (unstaged.status_type === "untracked") {
        return { colorClass: "text-[var(--color-status-success)] opacity-90", char: "U", label: "Untracked" };
      }
      return { colorClass: "text-[var(--color-status-warning)] font-semibold", char: "M", label: "Modified" };
    }
    if (staged) {
      if (staged.status_type === "added") {
        return { colorClass: "text-[var(--color-status-success)] font-bold", char: "A", label: "Staged Added" };
      }
      return { colorClass: "text-[var(--color-status-info)] font-bold", char: "A", label: "Staged" };
    }
    return null;
  }
};

export const FileTree: React.FC<FileTreeProps> = ({ entries }) => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [moveDialogNode, setMoveDialogNode] = useState<any | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [createDialog, setCreateDialog] = useState<{ type: "file" | "folder"; dir: string; name: string } | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const revealPath = useWorkspaceStore((state) => state.revealPath);
  const clearRevealPath = useWorkspaceStore((state) => state.clearRevealPath);
  const activeFilePath = useWorkspaceStore(selectActiveFilePath);
  const revealFileInTree = useWorkspaceStore((state) => state.revealFileInTree);
 
  const { confirm, ConfirmModalComponent } = useConfirm();

  const expandedPaths = useWorkspaceStore((state) => state.expandedPaths);
  const setPathExpanded = useWorkspaceStore((state) => state.setPathExpanded);

  const visibleEntries = React.useMemo(() => {
    const result: FileEntry[] = [];
    const visit = (nodes: FileEntry[]) => {
      nodes.forEach((node) => {
        result.push(node);
        if (node.is_dir && expandedPaths[node.path] && node.children) visit(node.children);
      });
    };
    visit(entries);
    return result;
  }, [entries, expandedPaths]);

  useEffect(() => {
    const existingPaths = new Set<string>();
    const visit = (nodes: FileEntry[]) => nodes.forEach((node) => {
      existingPaths.add(node.path);
      if (node.children) visit(node.children);
    });
    visit(entries);
    setSelectedPaths((current) => new Set([...current].filter((path) => existingPaths.has(path))));
    setFocusedPath((current) => current && existingPaths.has(current) ? current : null);
  }, [entries]);

  const openFile = async (node: FileEntry) => {
    if (node.path.includes("/.rusty/canvas/") && node.path.endsWith(".json")) {
      try {
        const { canvasFileService } = await import("./tabs/canvas/services/canvasFileService");
        const parsedData = await canvasFileService.loadCanvasFromFile(node.path);
        const tabId = parsedData.id || `canvas_${Date.now()}`;
        parsedData.id = tabId;
        const hasContents = parsedData.vfsContents && Object.keys(parsedData.vfsContents).length > 0;
        const hasTracker = parsedData.vfsTracker && Object.keys(parsedData.vfsTracker).length > 0;
        if (hasContents || hasTracker) {
          await canvasFileService.restoreCanvasVfs(parsedData.vfsContents || {}, parsedData.vfsTracker || {}, tabId);
        }
        useWorkspaceStore.getState().loadCanvasTab(parsedData);
      } catch (err: any) {
        notify("Canvas error", `Failed to load canvas: ${err.message || err}`, "error");
      }
      return;
    }
    useWorkspaceStore.getState().openTab({ type: "file", path: node.path, title: node.name });
  };

  const activateEntry = (node: FileEntry) => {
    if (node.is_dir) setPathExpanded(node.path, !expandedPaths[node.path]);
    else void openFile(node);
  };

  const handleEntryClick = (event: React.MouseEvent, node: FileEntry) => {
    treeContainerRef.current?.focus({ preventScroll: true });
    setFocusedPath(node.path);
    if (event.metaKey || event.ctrlKey) {
      setSelectedPaths((current) => {
        const next = new Set(current);
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
        return next;
      });
      return;
    }
    setSelectedPaths(new Set([node.path]));
    activateEntry(node);
  };

  const handleTreeKeyDown = (event: React.KeyboardEvent) => {
    if (renamingPath || visibleEntries.length === 0) return;
    const foundIndex = visibleEntries.findIndex((node) => node.path === focusedPath);
    const currentIndex = foundIndex < 0 ? 0 : foundIndex;
    const current = visibleEntries[currentIndex];
    let next: FileEntry | undefined;
    if (event.key === "ArrowDown") next = visibleEntries[foundIndex < 0 ? 0 : Math.min(currentIndex + 1, visibleEntries.length - 1)];
    else if (event.key === "ArrowUp") next = visibleEntries[foundIndex < 0 ? 0 : Math.max(currentIndex - 1, 0)];
    else if (event.key === "ArrowRight") {
      if (current.is_dir && !expandedPaths[current.path]) setPathExpanded(current.path, true);
      else if (current.is_dir) next = visibleEntries[currentIndex + 1];
    } else if (event.key === "ArrowLeft") {
      if (current.is_dir && expandedPaths[current.path]) setPathExpanded(current.path, false);
      else {
        next = [...visibleEntries].slice(0, currentIndex).reverse().find((candidate) =>
          candidate.is_dir && current.path.startsWith(`${candidate.path}/`)
        );
      }
    } else if (event.key === "Enter") activateEntry(current);
    else if (event.key === " ") {
      setSelectedPaths((selected) => {
        const nextSelection = new Set(selected);
        if (event.metaKey || event.ctrlKey) {
          if (nextSelection.has(current.path)) nextSelection.delete(current.path);
          else nextSelection.add(current.path);
        } else {
          nextSelection.clear();
          nextSelection.add(current.path);
        }
        return nextSelection;
      });
    } else return;
    event.preventDefault();
    event.stopPropagation();
    if (next) {
      setFocusedPath(next.path);
      setSelectedPaths(new Set([next.path]));
      requestAnimationFrame(() => treeContainerRef.current?.querySelector(`[data-file-path="${CSS.escape(next!.path)}"]`)?.scrollIntoView({ block: "nearest" }));
    }
  };

  const movePaths = async (paths: string[], destinationDir: string) => {
    const uniquePaths = [...new Set(paths)].filter((path) =>
      !paths.some((other) => other !== path && path.startsWith(`${other}/`))
    );
    const movable = uniquePaths.filter((path) => path !== destinationDir && !destinationDir.startsWith(`${path}/`));
    if (movable.length === 0) return;
    try {
      for (const srcPath of movable) {
        const fileName = srcPath.split("/").pop() || "";
        const destPath = `${destinationDir}/${fileName}`;
        if (srcPath !== destPath) await invoke("move_file_or_dir", { src: srcPath, dest: destPath });
      }
      await refreshTree();
      setPathExpanded(destinationDir, true);
      setSelectedPaths(new Set());
      notify("Items moved", `Moved ${movable.length} item${movable.length === 1 ? "" : "s"}.`, "success");
    } catch (err: any) {
      await refreshTree();
      notify("Move failed", `Some items could not be moved: ${err}`, "error");
    }
  };
 
  useEffect(() => {
    if (revealPath && treeContainerRef.current) {
      setTimeout(() => {
        const el = treeContainerRef.current?.querySelector(`[data-file-path="${CSS.escape(revealPath)}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        clearRevealPath();
      }, 100);
    }
  }, [revealPath, clearRevealPath]);
 
  const handleDropOnRoot = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rootPath = useWorkspaceStore.getState().rootPath;
    if (!rootPath) return;
 
    try {
      const dataStr = e.dataTransfer.getData("text/plain");
      if (!dataStr) return;
      const dragData = JSON.parse(dataStr);
      const paths = Array.isArray(dragData.paths) ? dragData.paths : dragData.path ? [dragData.path] : [];
      await movePaths(paths, rootPath);
    } catch (err: any) {
      console.error("Failed to move file to root:", err);
    }
  };
 
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-context-menu]")) return;
      setContextMenu(null);
    };
    if (contextMenu) {
      document.addEventListener("mousedown", handleOutsideClick);
      return () => document.removeEventListener("mousedown", handleOutsideClick);
    }
  }, [contextMenu]);
 
  const handleContextMenu = (e: React.MouseEvent, node: any) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };
 
  const handleMove = async (destPath: string) => {
    if (!moveDialogNode) return;
    try {
      await fileTreePresenter.moveItem(moveDialogNode.path, destPath);
    } catch (err) {
      console.error(err);
    }
    setMoveDialogNode(null);
  };
 
  const handleDelete = async (node: any) => {
    try {
      await fileTreePresenter.deleteItem(
        { path: node.path, name: node.name, isDir: node.is_dir },
        async (opts) => {
          return await confirm({
            title: opts.title,
            message: opts.message,
            confirmLabel: opts.confirmLabel,
            cancelLabel: opts.cancelLabel,
            kind: opts.kind,
          });
        }
      );
    } catch (err) {
      console.error(err);
    }
  };
 
  const handleOpenInFinder = async (node: any) => {
    try {
      await fileTreePresenter.openInFinder(node.path);
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddToGit = async (node: any) => {
    const rootPath = useWorkspaceStore.getState().rootPath;
    if (!rootPath) return;
    try {
      await gitPresenter.stageFile(rootPath, node.path);
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddToGitignore = async (node: any) => {
    const rootPath = useWorkspaceStore.getState().rootPath;
    if (!rootPath) return;
    try {
      await gitPresenter.addToGitignore(rootPath, node.path);
    } catch (err) {
      console.error(err);
    }
  };
 
  const handleNewFileFromMenu = (node: any) => {
    const targetDir = node.is_dir ? node.path : node.path.substring(0, node.path.lastIndexOf("/"));
    const dirName = node.is_dir ? node.name : targetDir.split("/").pop() || "folder";
    setCreateDialog({ type: "file", dir: targetDir, name: dirName });
  };
 
  const handleNewFolderFromMenu = (node: any) => {
    const targetDir = node.is_dir ? node.path : node.path.substring(0, node.path.lastIndexOf("/"));
    const dirName = node.is_dir ? node.name : targetDir.split("/").pop() || "folder";
    setCreateDialog({ type: "folder", dir: targetDir, name: dirName });
  };
 
  const handleCreate = async (name: string) => {
    if (!createDialog) return;
    const { type, dir } = createDialog;
    try {
      if (type === "file") {
        await fileTreePresenter.createFile(dir, name);
      } else {
        await fileTreePresenter.createFolder(dir, name);
      }
    } catch (err) {
      console.error(err);
    }
    setCreateDialog(null);
  };

  return (
    <div 
      ref={treeContainerRef}
      role="tree"
      aria-label="Project files"
      tabIndex={0}
      onKeyDown={handleTreeKeyDown}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDropOnRoot}
      className="space-y-[1px] select-none font-sans text-xs text-[var(--text-normal)] w-full min-h-[300px] overflow-y-auto focus:outline-none"
    >
      {/* Header with reveal button */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/50 sticky top-0 z-10">
        <span className="text-[10px] font-mono text-[var(--text-muted)] uppercase tracking-wide">Files</span>
        <button
          onClick={() => {
            if (activeFilePath) {
              revealFileInTree(activeFilePath);
            }
          }}
          className="text-[9px] font-mono text-[var(--text-muted)] hover:text-[var(--text-light)] hover:bg-[var(--accent-bg)] px-1.5 py-0.5 rounded transition-colors cursor-pointer flex items-center space-x-1"
          title="Reveal active file in tree"
        >
          <TreePine size={10} />
          <span>Reveal</span>
        </button>
      </div>
      {entries.map((entry) => (
        <FileTreeNode 
          key={entry.path} 
          node={entry} 
          onContextMenu={handleContextMenu}
          renamingPath={renamingPath}
          onRenameComplete={() => setRenamingPath(null)}
          onCreateRequest={(type, dir, name) => setCreateDialog({ type, dir, name })}
          selectedPaths={selectedPaths}
          focusedPath={focusedPath}
          onEntryClick={handleEntryClick}
          onDragSelection={(node) => {
            setFocusedPath(node.path);
            setSelectedPaths(new Set([node.path]));
          }}
          onMovePaths={movePaths}
        />
      ))}

      {/* Context Menu */}
      {contextMenu && (
        <FileTreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          onMove={() => { setMoveDialogNode(contextMenu.node); setContextMenu(null); }}
          onDelete={() => { handleDelete(contextMenu.node); setContextMenu(null); }}
          onOpenInFinder={() => { handleOpenInFinder(contextMenu.node); setContextMenu(null); }}
          onRename={() => { setRenamingPath(contextMenu.node.path); setContextMenu(null); }}
          onNewFile={() => { handleNewFileFromMenu(contextMenu.node); setContextMenu(null); }}
          onNewFolder={() => { handleNewFolderFromMenu(contextMenu.node); setContextMenu(null); }}
          onAddToGit={() => { handleAddToGit(contextMenu.node); setContextMenu(null); }}
          onAddToGitignore={() => { handleAddToGitignore(contextMenu.node); setContextMenu(null); }}
        />
      )}

      {/* Move Dialog */}
      {moveDialogNode && (
        <MoveDialog
          node={moveDialogNode}
          fileTree={entries}
          onMove={handleMove}
          onCancel={() => setMoveDialogNode(null)}
        />
      )}

      {/* Create Dialog */}
      {createDialog && (
        <CreateDialog
          type={createDialog.type}
          parentDir={createDialog.dir}
          onCreate={handleCreate}
          onCancel={() => setCreateDialog(null)}
        />
      )}

      {/* Confirmation Modal */}
      {ConfirmModalComponent}
    </div>
  );
};

const FileTreeContextMenu: React.FC<{
  x: number;
  y: number;
  node: any;
  onMove: () => void;
  onDelete: () => void;
  onOpenInFinder: () => void;
  onRename: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onAddToGit: () => void;
  onAddToGitignore: () => void;
}> = ({ x, y, onMove, onDelete, onOpenInFinder, onRename, onNewFile, onNewFolder, onAddToGit, onAddToGitignore }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      let adjX = x;
      let adjY = y;
      if (x + rect.width > window.innerWidth) adjX = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight) adjY = window.innerHeight - rect.height - 8;
      setPos({ x: adjX, y: adjY });
    }
  }, [x, y]);

  const items = [
    { icon: FilePlus, label: "New File", action: "newFile" },
    { icon: FolderPlus, label: "New Folder", action: "newFolder" },
    { type: "divider" as const },
    { icon: Pencil, label: "Rename", action: "rename" },
    { icon: FolderInput, label: "Move...", action: "move" },
    { type: "divider" as const },
    { icon: Plus, label: "Add to Git", action: "addToGit" },
    { icon: EyeOff, label: "Add to .gitignore", action: "addToGitignore" },
    { type: "divider" as const },
    { icon: ExternalLink, label: "Reveal in Finder", action: "finder" },
    { type: "divider" as const },
    { icon: Trash2, label: "Delete", action: "delete", danger: true },
  ];

  const handleAction = (action: string) => {
    switch (action) {
      case "move": onMove(); break;
      case "delete": onDelete(); break;
      case "finder": onOpenInFinder(); break;
      case "rename": onRename(); break;
      case "newFile": onNewFile(); break;
      case "newFolder": onNewFolder(); break;
      case "addToGit": onAddToGit(); break;
      case "addToGitignore": onAddToGitignore(); break;
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      data-context-menu="true"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[9999] bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-lg shadow-2xl py-1 min-w-[180px] font-sans text-xs"
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, idx) => {
        if (item.type === "divider") {
          return <div key={idx} className="h-px bg-[var(--border-color)]/50 my-1" />;
        }
        const Icon = (item as any).icon;
        return (
          <button
            key={idx}
            onClick={() => handleAction((item as any).action)}
            className={`w-full flex items-center space-x-2.5 px-3 py-1.5 text-left hover:bg-[var(--accent-bg)] transition-colors ${
              (item as any).danger ? "text-[var(--color-status-danger)] hover:bg-[var(--color-status-danger-bg)]" : "text-[var(--text-normal)] hover:text-[var(--text-light)]"
            }`}
          >
            <Icon size={13} className="flex-shrink-0" />
            <span>{(item as any).label}</span>
          </button>
        );
      })}
    </div>,
    document.body
  );
};

const FileTreeNode: React.FC<{ 
  node: FileEntry;
  onContextMenu: (e: React.MouseEvent, node: FileEntry) => void;
  renamingPath: string | null;
  onRenameComplete: () => void;
  onCreateRequest: (type: "file" | "folder", dir: string, name: string) => void;
  selectedPaths: Set<string>;
  focusedPath: string | null;
  onEntryClick: (event: React.MouseEvent, node: FileEntry) => void;
  onDragSelection: (node: FileEntry) => void;
  onMovePaths: (paths: string[], destinationDir: string) => Promise<void>;
}> = ({ node, onContextMenu, renamingPath, onRenameComplete, onCreateRequest, selectedPaths, focusedPath, onEntryClick, onDragSelection, onMovePaths }) => {
  const expandedPaths = useWorkspaceStore((state) => state.expandedPaths);
  const gitStatus = useWorkspaceStore((state) => state.gitStatus);
  const activeTabId = useWorkspaceStore(selectActiveTabId);

  const [tempName, setTempName] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const isRenaming = renamingPath === node.path;

  const isOpen = !!expandedPaths[node.path];
  const isSelected = selectedPaths.has(node.path);
  const isFocused = focusedPath === node.path;
  const gitState = getGitState(node, gitStatus);
  const isActiveFile = activeTabId === fileTabIdentity(node.path);

  useEffect(() => {
    if (isRenaming) {
      setTempName(node.name);
      if (renameInputRef.current) {
        renameInputRef.current.focus();
        const dotIdx = node.name.lastIndexOf(".");
        if (dotIdx > 0 && !node.is_dir) {
          renameInputRef.current.setSelectionRange(0, dotIdx);
        } else {
          renameInputRef.current.select();
        }
      }
    }
  }, [isRenaming, node.name, node.is_dir]);

  const handleDragStart = (e: React.DragEvent) => {
    const paths = isSelected ? [...selectedPaths] : [node.path];
    if (!isSelected) onDragSelection(node);
    const payload = { path: node.path, paths, name: node.name, isDir: !!node.is_dir };
    e.dataTransfer.setData("text/plain", JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-rusty-files", JSON.stringify(payload));
  };

  const handleRename = async () => {
    const newName = tempName.trim();
    if (!newName || newName === node.name) {
      onRenameComplete();
      return;
    }
    const parentPath = node.path.substring(0, node.path.lastIndexOf("/"));
    const newPath = `${parentPath}/${newName}`;
    try {
      await invoke("move_file_or_dir", { src: node.path, dest: newPath });
      await refreshTree();
      const state = useWorkspaceStore.getState();
      state.closeTab(fileTabIdentity(node.path));
      // Track for undo
      state.setLastRename({ originalPath: node.path, newPath });
      state.loadGitStatus();
    } catch (err: any) {
      notify("Rename failed", `Rename failed: ${err}`, "error");
    }
    onRenameComplete();
  };

  const handleCreateFile = () => {
    onCreateRequest("file", node.path, node.name);
  };

  const handleCreateDirectory = () => {
    onCreateRequest("folder", node.path, node.name);
  };

  const handleDropOnNode = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!node.is_dir) return;
    try {
      const dataStr = e.dataTransfer.getData("text/plain");
      if (!dataStr) return;
      const dragData = JSON.parse(dataStr);
      const paths = Array.isArray(dragData.paths) ? dragData.paths : dragData.path ? [dragData.path] : [];
      await onMovePaths(paths, node.path);
    } catch (err: any) {
      notify("Move failed", `Move failed: ${err}`, "error");
    }
  };

  const renameInput = (
    <input
      ref={renameInputRef}
      type="text"
      value={tempName}
      onChange={(e) => setTempName(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") handleRename();
        if (e.key === "Escape") onRenameComplete();
      }}
      onBlur={handleRename}
      className="nodrag bg-[var(--bg-app)] border border-[var(--accent-color)] rounded px-1 py-0 text-xs text-[var(--text-light)] focus:outline-none w-full"
    />
  );

  if (node.is_dir) {
    return (
      <div className="w-full">
        <div
          role="treeitem"
          aria-expanded={isOpen}
          aria-selected={isSelected}
          data-file-path={node.path}
          draggable={true}
          onDragStart={handleDragStart}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDropOnNode}
          onClick={(event) => !isRenaming && onEntryClick(event, node)}
          onContextMenu={(e) => onContextMenu(e, node)}
          style={{ WebkitUserDrag: "element" } as React.CSSProperties}
          className={`group relative flex items-center justify-between py-0.5 px-1 active:bg-[var(--border-color)]/60 cursor-grab active:cursor-grabbing hover:text-[var(--text-light)] transition-colors font-sans text-xs w-full border ${isSelected ? "bg-[var(--accent-bg)] border-[var(--border-active)]" : "hover:bg-[var(--accent-bg)] border-transparent hover:border-[var(--border-color)]/20"} ${isFocused ? "ring-1 ring-inset ring-[var(--accent-color)]/60" : ""} ${gitState ? gitState.colorClass : "text-[var(--text-normal)]"}`}
        >
          <div className="flex items-center min-w-0 flex-1 mr-14">
            <span className="mr-0.5 text-[var(--text-muted)] flex-shrink-0">
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
            <span className="mr-1 text-[var(--accent-color)] flex-shrink-0">
              {isOpen ? <FolderOpen size={13} className={gitState ? gitState.colorClass : ""} /> : <Folder size={13} className={gitState ? gitState.colorClass : ""} />}
            </span>
            {isRenaming ? (
              renameInput
            ) : (
              <span className="truncate pr-2">{node.name}</span>
            )}
          </div>

          <div className="flex items-center space-x-1 mr-1">
            {gitState && (
              <span className="text-[12px] font-mono font-bold opacity-85 select-none" title={gitState.label}>
                {gitState.char}
              </span>
            )}
          </div>

          {/* Folder Actions */}
          {!isRenaming && (
            <div className="absolute right-1 top-0 bottom-0 opacity-0 group-hover:opacity-100 flex items-center space-x-1.5 bg-[var(--accent-bg)] pl-2 transition-opacity">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleCreateFile(); }}
                className="p-0.5 rounded hover:bg-[var(--accent-color)]/20 text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors cursor-pointer"
                title="New File"
              >
                <Plus size={11} />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleCreateDirectory(); }}
                className="p-0.5 rounded hover:bg-[var(--accent-color)]/20 text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors cursor-pointer"
                title="New Folder"
              >
                <FolderPlus size={11} />
              </button>
            </div>
          )}
        </div>
        {isOpen && node.children && (
          <div className="pl-2 border-l border-[var(--border-color)]/60 ml-1.5 mt-[1px] space-y-[1px]">
            {node.children.map((child: any) => (
              <FileTreeNode key={child.path} node={child} onContextMenu={onContextMenu} renamingPath={renamingPath} onRenameComplete={onRenameComplete} onCreateRequest={onCreateRequest} selectedPaths={selectedPaths} focusedPath={focusedPath} onEntryClick={onEntryClick} onDragSelection={onDragSelection} onMovePaths={onMovePaths} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="treeitem"
      aria-selected={isSelected}
      draggable={true}
      onDragStart={handleDragStart}
      onClick={(event) => !isRenaming && onEntryClick(event, node)}
      onContextMenu={(e) => onContextMenu(e, node)}
      data-file-path={node.path}
      style={{ WebkitUserDrag: "element" } as React.CSSProperties}
      className={`group relative flex items-center justify-between py-1 px-1.5 pl-[18px] transition-all cursor-grab active:cursor-grabbing font-sans text-xs w-full border rounded-md ${
        isSelected
          ? "bg-[var(--accent-bg)] border-[var(--border-active)] text-[var(--text-light)] font-medium shadow-sm"
          : isActiveFile
          ? "bg-[var(--color-surface-sunken)] border-[var(--color-border-subtle)] text-[var(--text-light)] font-medium shadow-sm"
          : "hover:bg-[var(--accent-bg)] hover:text-[var(--text-light)] border-transparent hover:border-[var(--border-color)]/20 " + (gitState ? gitState.colorClass : "text-[var(--text-normal)]")
      } ${isFocused ? "ring-1 ring-inset ring-[var(--accent-color)]/60" : ""}`}
    >
      <div className="flex items-center min-w-0 flex-1 mr-6">
        <FileIcon fileName={node.name} size={13} className="mr-1.5 flex-shrink-0" />
        {isRenaming ? (
          renameInput
        ) : (
          <span className="truncate pr-2">{node.name}</span>
        )}
      </div>

      <div className="flex items-center space-x-1 mr-1">
        {gitState && (
          <span className="text-[10px] font-mono font-bold opacity-90 select-none" title={gitState.label}>
            {gitState.char}
          </span>
        )}
      </div>
    </div>
  );
};
