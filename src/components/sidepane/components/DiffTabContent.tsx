import React, { useState, useRef, useCallback, useEffect } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { CustomSelect } from "../../CustomSelect";
import { VfsRegistry } from "../../../services/vfs";
import { Save, RotateCcw, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { useDiffViewMode } from "../../../hooks/useDiffViewMode";
import { DiffViewToggle } from "../../ui/DiffViewToggle";
import { useWorkspaceStore } from "../../../store";
import { getMonacoLanguageId } from "../../../services/languageRegistry";
import { createMonacoDiffOptions } from "../../../editor/monacoOptions";

interface DiffTabContentProps {
  selectedNode: any;
  modifiedFiles: string[];
  activeDiffFile: string;
  setActiveDiffFile: (file: string) => void;
  originalCode: string;
  modifiedCode: string;
  isDiffLoading?: boolean;
  tabId?: string;
}

export const DiffTabContent: React.FC<DiffTabContentProps> = ({
  selectedNode,
  modifiedFiles,
  activeDiffFile,
  setActiveDiffFile,
  originalCode,
  modifiedCode,
  isDiffLoading,
  tabId
}) => {
  const updateTaskNode = useWorkspaceStore((state) => state.updateTaskNode);
  const editorFontSize = useWorkspaceStore((state) => state.typographyPreferences.editorFontSize);
  const [editedCode, setEditedCode] = useState<string>("");
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const diffEditorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentChangeDisposableRef = useRef<any>(null);
  const lastActiveFileRef = useRef<string>("");
  const { viewMode, isAutoMode, toggleViewMode, enableAutoMode, renderSideBySide } = useDiffViewMode(containerRef);

  const diffOptions = modifiedFiles.map((file) => ({
    id: file,
    name: file.split("/").pop() || file,
  }));

  const handleEditorMount = useCallback((editor: any) => {
    if (contentChangeDisposableRef.current) {
      contentChangeDisposableRef.current.dispose();
    }

    diffEditorRef.current = editor;
    const modifiedEditor = editor.getModifiedEditor();
    modifiedEditor.updateOptions({ readOnly: false });

    const listener = () => {
      const newContent = modifiedEditor.getValue();
      setEditedCode(newContent);
      setIsDirty(newContent !== modifiedCode);
    };
    contentChangeDisposableRef.current = modifiedEditor.onDidChangeModelContent(listener);

    lastActiveFileRef.current = activeDiffFile;
  }, [modifiedCode, activeDiffFile]);

  useEffect(() => {
    if (!diffEditorRef.current) return;

    const editor = diffEditorRef.current;
    const originalModel = editor.getOriginalEditor().getModel();
    const modifiedModel = editor.getModifiedEditor().getModel();

    if (originalModel && modifiedModel) {
      const currentValue = originalModel.getValue();
      if (currentValue !== originalCode && !originalCode.startsWith("// Loading")) {
        originalModel.setValue(originalCode);
      }

      const modifiedValue = modifiedModel.getValue();
      if (modifiedValue !== modifiedCode && !modifiedCode.startsWith("// Loading")) {
        modifiedModel.setValue(modifiedCode);
        lastActiveFileRef.current = activeDiffFile;
      }
    }
  }, [originalCode, modifiedCode, activeDiffFile]);

  const handleSave = async () => {
    if (!activeDiffFile || !isDirty) return;
    setIsSaving(true);
    try {
      await VfsRegistry.getOrCreate(tabId).writeFile(activeDiffFile, editedCode, selectedNode.id);
      const originalFileContents = (selectedNode.data?.originalFileContents as Record<string, string>) || {};
      const generatedFileContents = (selectedNode.data?.generatedFileContents as Record<string, string>) || {};
      updateTaskNode(selectedNode.id, {
        originalFileContents: {
          ...originalFileContents,
          [activeDiffFile]: originalFileContents[activeDiffFile] ?? originalCode,
        },
        generatedFileContents: {
          ...generatedFileContents,
          [activeDiffFile]: editedCode,
        },
      });
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

  const currentIndex = activeDiffFile ? modifiedFiles.indexOf(activeDiffFile) : -1;

  const handlePrev = () => {
    if (currentIndex > 0) {
      setActiveDiffFile(modifiedFiles[currentIndex - 1]);
    }
  };

  const handleNext = () => {
    if (currentIndex < modifiedFiles.length - 1) {
      setActiveDiffFile(modifiedFiles[currentIndex + 1]);
    }
  };

  const displayCode = isDirty ? editedCode : modifiedCode;

  return (
    <div ref={containerRef} className="flex flex-col h-full w-full">
      {/* File Diff Dropdown Selector (only for TaskNode when files are edited) */}
      {selectedNode.type === "taskNode" && modifiedFiles.length > 0 && (
        <div className="px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)] flex items-center justify-between text-xs font-mono flex-shrink-0">
          <div className="flex items-center space-x-1">
            <span className="text-[var(--text-muted)] mr-3 flex-shrink-0">File Diff:</span>
            <button
              onClick={handlePrev}
              disabled={currentIndex <= 0}
              className="p-1 rounded hover:bg-[var(--accent-bg)] text-[var(--text-muted)] hover:text-[var(--text-light)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)] transition-colors cursor-pointer disabled:cursor-not-allowed border border-[var(--border-color)] flex items-center justify-center flex-shrink-0"
              title="Previous file"
            >
              <ChevronLeft size={13} />
            </button>
            <button
              onClick={handleNext}
              disabled={currentIndex >= modifiedFiles.length - 1}
              className="p-1 rounded hover:bg-[var(--accent-bg)] text-[var(--text-muted)] hover:text-[var(--text-light)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)] transition-colors cursor-pointer disabled:cursor-not-allowed border border-[var(--border-color)] flex items-center justify-center flex-shrink-0 mr-3"
              title="Next file"
            >
              <ChevronRight size={13} />
            </button>
            <CustomSelect
              value={activeDiffFile}
              onChange={setActiveDiffFile}
              options={diffOptions}
              className="w-64"
            />
            {activeDiffFile && (
              <button
                onClick={async () => {
                  if (confirm(`Are you sure you want to delete ${activeDiffFile.split("/").pop() || activeDiffFile} from this task's VFS?`)) {
                    try {
                      await VfsRegistry.getOrCreate(tabId).deleteNodeFile(selectedNode.id, activeDiffFile);
                      const newFiles = modifiedFiles.filter((f) => f !== activeDiffFile);
                      const nextOriginalFileContents = {
                        ...((selectedNode.data?.originalFileContents as Record<string, string>) || {}),
                      };
                      const nextGeneratedFileContents = {
                        ...((selectedNode.data?.generatedFileContents as Record<string, string>) || {}),
                      };
                      delete nextOriginalFileContents[activeDiffFile];
                      delete nextGeneratedFileContents[activeDiffFile];
                      updateTaskNode(selectedNode.id, {
                        modifiedFiles: newFiles,
                        originalFileContents: nextOriginalFileContents,
                        generatedFileContents: nextGeneratedFileContents,
                      });
                      if (tabId) {
                        const { canvasFileService } = await import("../../tabs/canvas/services/canvasFileService");
                        await canvasFileService.autoSaveCanvas(tabId);
                      }
                    } catch (err) {
                      console.error("Failed to delete VFS file:", err);
                    }
                  }
                }}
                className="p-1 text-[var(--text-muted)] hover:text-[var(--color-status-danger)] hover:bg-[var(--color-status-danger-bg)] rounded transition-colors cursor-pointer"
                title="Delete this file from VFS"
              >
                <Trash2 size={14} />
              </button>
            )}
            <button
              onClick={async () => {
                if (confirm("Are you sure you want to delete all files modified by this task node from the VFS?")) {
                  try {
                    await VfsRegistry.getOrCreate(tabId).deleteNodeFiles(selectedNode.id);
                    updateTaskNode(selectedNode.id, {
                      modifiedFiles: [],
                      originalFileContents: {},
                      generatedFileContents: {},
                    });
                    if (tabId) {
                      const { canvasFileService } = await import("../../tabs/canvas/services/canvasFileService");
                      await canvasFileService.autoSaveCanvas(tabId);
                    }
                  } catch (err) {
                    console.error("Failed to delete all VFS files:", err);
                  }
                }
              }}
              className="flex items-center space-x-1 px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--color-status-danger)] hover:bg-[var(--color-status-danger-bg)] rounded transition-colors cursor-pointer animate-fade-in"
              title="Delete all files from VFS"
            >
              <Trash2 size={12} />
              <span>Delete All</span>
            </button>
          </div>
          <DiffViewToggle
            viewMode={viewMode}
            isAutoMode={isAutoMode}
            onToggle={toggleViewMode}
            onEnableAuto={enableAutoMode}
          />
        </div>
      )}

      {/* Edit controls for taskNode */}
      {selectedNode.type === "taskNode" && activeDiffFile && (
        <div className="px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/50 flex items-center justify-end space-x-2 flex-shrink-0">
          <span className="text-[10px] text-[var(--text-muted)] font-mono mr-auto">
            {isDiffLoading ? "Loading..." : isDirty ? "Modified (unsaved)" : "Editable"}
          </span>
          <button
            onClick={handleReset}
            disabled={!isDirty || isSaving || isDiffLoading}
            className="flex items-center space-x-1 px-2 py-1 text-[10px] font-mono text-[var(--text-muted)] hover:text-[var(--text-light)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Reset changes"
          >
            <RotateCcw size={11} />
            <span>Reset</span>
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty || isSaving || isDiffLoading}
            className="flex items-center space-x-1 px-2 py-1 text-[10px] font-mono bg-[var(--color-status-success-bg)] hover:bg-[var(--color-status-success-solid)] text-[var(--color-status-success)] hover:text-[var(--color-status-success-solid-foreground)] disabled:bg-[var(--bg-sidebar)] disabled:text-[var(--text-muted)] rounded transition-colors"
            title="Save changes to VFS"
          >
            <Save size={11} />
            <span>{isSaving ? "Saving..." : "Save"}</span>
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 relative">
        {activeDiffFile ? (
          <div className="w-full h-full">
            <DiffEditor
              height="100%"
              language={getMonacoLanguageId(activeDiffFile)}
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
          <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center text-[var(--text-muted)] font-mono text-xs space-y-2">
            <span className="text-[var(--accent-color)] font-bold">// Sandbox VFS Standby</span>
            <span className="text-[11px] text-[var(--text-muted)] max-w-[280px]">
              No files modified by this task node yet. Connect a source File Node, type prompt instructions, and click "Run Executor".
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
