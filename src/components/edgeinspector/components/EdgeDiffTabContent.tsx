/**
 * EdgeDiffTabContent Component
 * 
 * Embeds Monaco DiffEditor and provides a dropdown selector to view diffs
 * of files that were modified by the source task.
 */

import React, { useState, useRef, useCallback } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { CustomSelect } from "../../CustomSelect";
import { VfsRegistry } from "../../../services/vfs";
import { Save, RotateCcw } from "lucide-react";
import { useDiffViewMode } from "../../../hooks/useDiffViewMode";
import { DiffViewToggle } from "../../ui/DiffViewToggle";
import { getMonacoLanguageId } from "../../../services/languageRegistry";
import { useWorkspaceStore } from "../../../store";
import { createMonacoDiffOptions } from "../../../editor/monacoOptions";

interface EdgeDiffTabContentProps {
  sourceModifiedFiles: string[];
  diffFile: string;
  setDiffFile: (file: string) => void;
  loadDiffContent: (file: string) => Promise<void>;
  originalCode: string;
  modifiedCode: string;
  tabId?: string;
}

export const EdgeDiffTabContent: React.FC<EdgeDiffTabContentProps> = ({
  sourceModifiedFiles,
  diffFile,
  setDiffFile,
  loadDiffContent,
  originalCode,
  modifiedCode,
  tabId
}) => {
  const editorFontSize = useWorkspaceStore((state) => state.typographyPreferences.editorFontSize);
  const [editedCode, setEditedCode] = useState<string>("");
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const diffEditorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { viewMode, isAutoMode, toggleViewMode, enableAutoMode, renderSideBySide } = useDiffViewMode(containerRef);

  const fileOptions = sourceModifiedFiles.map((file) => ({
    id: file,
    name: file.split("/").pop() || file,
  }));

  const handleEditorMount = useCallback((editor: any) => {
    diffEditorRef.current = editor;
    const modifiedEditor = editor.getModifiedEditor();
    modifiedEditor.updateOptions({ readOnly: false });
    modifiedEditor.onDidChangeModelContent(() => {
      const newContent = modifiedEditor.getValue();
      setEditedCode(newContent);
      setIsDirty(newContent !== modifiedCode);
    });
  }, [modifiedCode]);

  const handleSave = async () => {
    if (!diffFile || !isDirty) return;
    setIsSaving(true);
    try {
      await VfsRegistry.getOrCreate(tabId).writeFile(diffFile, editedCode);
      setIsDirty(false);
      if (tabId) {
        const { canvasFileService } = await import("../../tabs/canvas/services/canvasFileService");
        await canvasFileService.autoSaveCanvas(tabId);
      }
    } catch (err) {
      console.error("Failed to save file:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    if (diffEditorRef.current) {
      const modifiedEditor = diffEditorRef.current.getModifiedEditor();
      modifiedEditor.setValue(modifiedCode);
      setEditedCode(modifiedCode);
      setIsDirty(false);
    }
  };

  const displayCode = isDirty ? editedCode : modifiedCode;

  return (
    <div ref={containerRef} className="flex flex-col h-full w-full">
      {sourceModifiedFiles.length > 0 && (
        <div className="px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)] flex items-center justify-between text-xs font-mono flex-shrink-0">
          <div className="flex items-center space-x-3">
            <span className="text-[var(--text-muted)] mr-4">File:</span>
            <CustomSelect
              value={diffFile}
              onChange={(val) => {
                setDiffFile(val);
                loadDiffContent(val);
              }}
              options={fileOptions}
              className="w-64"
            />
          </div>
          <DiffViewToggle
            viewMode={viewMode}
            isAutoMode={isAutoMode}
            onToggle={toggleViewMode}
            onEnableAuto={enableAutoMode}
          />
        </div>
      )}

      {/* Edit controls */}
      {diffFile && (
        <div className="px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/50 flex items-center justify-end space-x-2 flex-shrink-0">
          <span className="text-[10px] text-[var(--text-muted)] font-mono mr-auto">
            {isDirty ? "Modified (unsaved)" : "Editable"}
          </span>
          <button
            onClick={handleReset}
            disabled={!isDirty || isSaving}
            className="flex items-center space-x-1 px-2 py-1 text-[10px] font-mono text-[var(--text-muted)] hover:text-[var(--text-light)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Reset changes"
          >
            <RotateCcw size={11} />
            <span>Reset</span>
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className="flex items-center space-x-1 px-2 py-1 text-[10px] font-mono bg-[var(--color-status-success-bg)] hover:bg-[var(--color-status-success-solid)] text-[var(--color-status-success)] hover:text-[var(--color-status-success-solid-foreground)] disabled:bg-[var(--bg-sidebar)] disabled:text-[var(--text-muted)] rounded transition-colors"
            title="Save changes to VFS"
          >
            <Save size={11} />
            <span>{isSaving ? "Saving..." : "Save"}</span>
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 relative">
        {diffFile ? (
          <div className="w-full h-full">
            <DiffEditor
              height="100%"
              language={getMonacoLanguageId(diffFile)}
              theme="rusty-custom-theme"
              original={originalCode}
              modified={displayCode}
              onMount={handleEditorMount}
              options={createMonacoDiffOptions(editorFontSize, {
                readOnly: false,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: "on",
                renderSideBySide,
              })}
            />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-xs font-mono">
            No modified files to display.
          </div>
        )}
      </div>
    </div>
  );
};
