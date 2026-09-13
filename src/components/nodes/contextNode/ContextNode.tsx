/**
 * ContextNode — a React Flow node that attaches file/folder context and
 * free-form description notes to a Rusty pipeline.
 *
 * Responsibilities:
 * - Display an attached file/folder (from sidebar drag-drop or search).
 * - Provide a file-search overlay for browsing the workspace.
 * - Accept free-form description text with an expand/minimize toggle.
 * - Allow inline renaming and deletion.
 *
 * Architecture:
 * - **Orchestrator pattern.** This component wires store actions, local
 *   state, custom hooks, and pure helpers together, then delegates
 *   rendering to focused sub-components (Header, Content, SearchOverlay).
 * - **No nested functions.** Every callback is defined at the component
 *   body level and passed down as a prop.
 * - **Custom hooks** encapsulate debounced search (`useDebouncedSearch`)
 *   and drag-over visual feedback (`useContextNodeDrag`).
 * - **Helper module** (`helpers.ts`) provides pure utility functions
 *   for path formatting and drag-data parsing.
 */

import React, { memo, useState, useEffect, useCallback } from "react";
import { Handle, Position } from "@xyflow/react";
import { useWorkspaceStore } from "../../../store";
import { parseDragData, getDefaultContextName } from "./helpers";
import { useDebouncedSearch, useContextNodeDrag } from "./hooks";
import { ContextNodeHeader } from "./ContextNodeHeader";
import { ContextNodeContent } from "./ContextNodeContent";
import { ContextNodeSearchOverlay } from "./ContextNodeSearchOverlay";
import type { ContextNodeData } from "./types";

/* ------------------------------------------------------------------ */
/*  HANDLE_STYLE                                                       */
/* ------------------------------------------------------------------ */

/** Shared style for the source handles. */
const HANDLE_STYLE: React.CSSProperties = {
  background: "var(--color-status-success-solid)",
  width: 14,
  height: 14,
  border: "2.5px solid var(--color-surface-sidebar)",
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const ContextNode: React.FC<{
  id: string;
  data: ContextNodeData;
}> = memo(({ id, data }) => {
  /* ---- Store Selectors ---- */
  const updateNode = useWorkspaceStore((state) => state.updateTaskNode);
  const openTab = useWorkspaceStore((state) => state.openTab);
  const deleteNode = useWorkspaceStore((state) => state.deleteNode);
  const rootPath = useWorkspaceStore((state) => state.rootPath);

  /* ---- Local State ---- */
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(data.name || "");
  const [showSearch, setShowSearch] = useState(false);

  /* ---- Derived Values ---- */
  const isMinimized = !!data.isMinimized;
  const hasFilePath = !!data.path;

  /* ---- Sync temp name when data.name changes externally ---- */
  useEffect(() => {
    setTempName(data.name || "");
  }, [data.name]);

  /* ---- Search Overlay State ---- */
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    results: searchResults,
    isSearching,
    selectedIndex,
    setSelectedIndex,
    searchInputRef,
  } = useDebouncedSearch({
    rootPath,
    enabled: showSearch,
  });

  /* ---- Drag & Drop ---- */
  const handleDropData = useCallback(
    (e: React.DragEvent): void => {
      const rawData = e.dataTransfer.getData("text/plain");
      if (!rawData) return;

      const dragData = parseDragData(rawData);
      if (!dragData) return;

      updateNode(id, {
        path: dragData.path,
        fileName: dragData.name,
        isDir: dragData.isDir,
        name: !data.name ? getDefaultContextName(dragData.name) : data.name,
      });
    },
    [id, data.name, updateNode],
  );

  const { dragOver, handleDragOver, handleDragLeave, handleDrop } =
    useContextNodeDrag(handleDropData);

  /* ---- Handlers: Name Editing ---- */

  /** Persist the edited name and exit edit mode. */
  const handleNameSave = useCallback((): void => {
    updateNode(id, { name: tempName });
    setIsEditing(false);
  }, [id, tempName, updateNode]);

  /** Discard the edit and revert to the stored name. */
  const handleCancelEdit = useCallback((): void => {
    setTempName(data.name || "");
    setIsEditing(false);
  }, [data.name]);

  /** Enter name-edit mode. */
  const handleStartEdit = useCallback((): void => {
    setIsEditing(true);
  }, []);

  /** Delete this node from the canvas. */
  const handleDelete = useCallback((): void => {
    deleteNode(id);
  }, [id, deleteNode]);

  /* ---- Handlers: File Action ---- */

  /** Opens the attached file in a new editor tab. */
  const handleFileClick = useCallback(
    (e: React.MouseEvent): void => {
      e.stopPropagation();
      if (data.path && !data.isDir) {
        openTab({
          type: "file",
          path: data.path,
          title: data.fileName || "File",
        });
      }
    },
    [data.path, data.isDir, data.fileName, openTab],
  );

  /** Clears the attached context file from the node. */
  const handleClearContext = useCallback(
    (e: React.MouseEvent): void => {
      e.stopPropagation();
      const shouldResetName =
        typeof data.name === "string" && data.name.startsWith("Context: ");
      updateNode(id, {
        path: "",
        fileName: "",
        isDir: false,
        name: shouldResetName ? "" : data.name,
      });
    },
    [id, data.name, updateNode],
  );

  /** Updates the description text on every keystroke. */
  const handleDescriptionChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
      updateNode(id, { description: e.target.value });
    },
    [id, updateNode],
  );

  /** Toggles the description textarea between minimized and expanded. */
  const handleToggleMinimize = useCallback((): void => {
    updateNode(id, { isMinimized: !isMinimized });
  }, [id, isMinimized, updateNode]);

  /* ---- Handlers: Search Overlay ---- */

  /** Opens the file-search overlay. */
  const handleOpenSearch = useCallback((): void => {
    setShowSearch(true);
  }, []);

  /** Closes the search overlay and resets search state. */
  const handleSearchClose = useCallback((): void => {
    setShowSearch(false);
    setSearchQuery("");
    setSelectedIndex(0);
  }, [setSearchQuery, setSelectedIndex]);

  /** Attaches a selected search result to the node. */
  const handleSearchSelect = useCallback(
    (match: { path: string; name: string }): void => {
      updateNode(id, {
        path: match.path,
        fileName: match.name,
        isDir: false,
        name: !data.name ? getDefaultContextName(match.name) : data.name,
      });
      handleSearchClose();
    },
    [id, data.name, updateNode, handleSearchClose],
  );

  /** Handles keyboard events inside the search input. */
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === "Escape") {
        handleSearchClose();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, searchResults.length - 1));
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }

      if (e.key === "Enter" && searchResults.length > 0) {
        e.preventDefault();
        handleSearchSelect(searchResults[selectedIndex]);
      }
    },
    [searchResults, selectedIndex, handleSearchClose, handleSearchSelect, setSelectedIndex],
  );

  /* ---- Render ---- */
  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`w-72 rounded-xl border text-[var(--text-normal)] overflow-hidden transition-all duration-300 ${
        dragOver
          ? "border-[var(--color-status-success-border)] bg-[var(--bg-sidebar)] shadow-[0_0_15px_var(--color-status-success-bg)]"
          : "border-[var(--border-color)] bg-[var(--bg-sidebar)] hover:border-[var(--border-active)] shadow-lg"
      }`}
    >
      {/* ---- Header ---- */}
      <ContextNodeHeader
        name={data.name}
        isEditing={isEditing}
        tempName={tempName}
        hasFilePath={hasFilePath}
        onTempNameChange={setTempName}
        onNameSave={handleNameSave}
        onCancelEdit={handleCancelEdit}
        onStartEdit={handleStartEdit}
        onOpenSearch={handleOpenSearch}
        onDelete={handleDelete}
      />

      {/* ---- Content ---- */}
      <ContextNodeContent
        path={data.path}
        fileName={data.fileName}
        isDir={data.isDir}
        description={data.description}
        isMinimized={isMinimized}
        onFileClick={handleFileClick}
        onClearContext={handleClearContext}
        onDescriptionChange={handleDescriptionChange}
        onToggleMinimize={handleToggleMinimize}
      />

      {/* ---- Search Overlay ---- */}
      {showSearch && (
        <ContextNodeSearchOverlay
          query={searchQuery}
          results={searchResults}
          isSearching={isSearching}
          selectedIndex={selectedIndex}
          rootPath={rootPath}
          inputRef={searchInputRef}
          onQueryChange={setSearchQuery}
          onResultSelect={handleSearchSelect}
          onKeyDown={handleSearchKeyDown}
          onClose={handleSearchClose}
        />
      )}

      {/* ---- React Flow Handles ---- */}
      <Handle
        type="source"
        position={Position.Top}
        id="context-out-top"
        style={HANDLE_STYLE}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="context-out-bottom"
        style={HANDLE_STYLE}
      />
    </div>
  );
});
