import React, { useState, useEffect, useRef, useMemo } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { useWorkspaceStore } from "../../store";
import { invoke } from "@tauri-apps/api/core";
import { VfsRegistry } from "../../services/vfs";
import { getFileTypeDetails } from "../../services/fileTypeService";
import { useDiffViewMode } from "../../hooks/useDiffViewMode";
import { DiffViewToggle } from "../ui/DiffViewToggle";
import { createMonacoDiffOptions } from "../../editor/monacoOptions";

interface GitDiffTabProps {
  tab: any;
  isActive: boolean;
}

export const GitDiffTab: React.FC<GitDiffTabProps> = ({ tab, isActive }) => {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const editorFontSize = useWorkspaceStore((state) => state.typographyPreferences.editorFontSize);

  const [gitOriginalCode, setGitOriginalCode] = useState("");
  const [gitModifiedCode, setGitModifiedCode] = useState("");
  const [loading, setLoading] = useState(true);
  const diffEditorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const canvasTabId = useMemo(() => {
    const contexts = useWorkspaceStore.getState().canvasContexts;
    for (const tId in contexts) {
      const ctx = contexts[tId];
      const hasNode = ctx.nodes.some((n: any) => n.data?.modifiedFiles?.includes(tab.key));
      if (hasNode) return tId;
    }
    return undefined;
  }, [tab.key]);
  const { viewMode, isAutoMode, toggleViewMode, enableAutoMode, renderSideBySide } = useDiffViewMode(containerRef);

  useEffect(() => {
    if (!rootPath) return;

    const fetchGitDiffContent = async () => {
      setLoading(true);
      try {
        console.log(`GitDiffTab loading diff for: ${tab.key} (${tab.diffType || "unstaged"})`);
        let original = "";
        let modified = "";

        if (tab.diffType === "commit" && tab.commitHash) {
          original = await invoke("git_get_file_content_at_rev", {
            rootDir: rootPath,
            revision: `${tab.commitHash}~1`,
            filePath: tab.key,
          });
          modified = await invoke("git_get_file_content_at_rev", {
            rootDir: rootPath,
            revision: tab.commitHash,
            filePath: tab.key,
          });
        } else if (tab.diffType === "staged") {
          original = await invoke("git_get_head_content", {
            rootDir: rootPath,
            filePath: tab.key,
          });
          modified = await invoke("git_get_index_content", {
            rootDir: rootPath,
            filePath: tab.key,
          });
        } else {
          original = await invoke("git_get_index_content", {
            rootDir: rootPath,
            filePath: tab.key,
          });
          try {
            modified = await VfsRegistry.getOrCreate(canvasTabId).readFile(tab.key);
          } catch (e) {
            try {
              modified = await invoke("read_file_disk", { path: tab.key });
            } catch (err) {
              modified = "";
            }
          }
        }

        setGitOriginalCode(original);
        setGitModifiedCode(modified);
      } catch (err: any) {
        console.error("GitDiffTab failed to load git diff:", err);
        setGitOriginalCode(`// Error reading original content: ${err.message}`);
        setGitModifiedCode(`// Error reading modified content: ${err.message}`);
      } finally {
        setLoading(false);
      }
    };

    fetchGitDiffContent();
  }, [tab.key, tab.diffType, tab.commitHash, rootPath]);

  // Adjust editor size when tab active state changes
  useEffect(() => {
    if (isActive && diffEditorRef.current) {
      setTimeout(() => {
        if (diffEditorRef.current) {
          diffEditorRef.current.layout();
        }
      }, 50);
    }
  }, [isActive]);

  const handleEditorMount = (editor: any) => {
    diffEditorRef.current = editor;
    setTimeout(() => {
      editor.layout();
    }, 50);
  };

  const getEditorLanguage = (filePath: string): string => {
    return getFileTypeDetails(filePath).language;
  };

  return (
    <div ref={containerRef} className="flex-1 flex flex-col h-full overflow-hidden relative">
      {/* Header info */}
      <div className="px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)] flex items-center justify-between text-xs font-mono">
        <div className="flex items-center space-x-3">
          <span className="text-[var(--text-light)] font-bold">{tab.title}</span>
          <span className="text-[var(--text-muted)] text-[10px] truncate max-w-[400px]">
            {tab.key}
          </span>
        </div>
        <DiffViewToggle
          viewMode={viewMode}
          isAutoMode={isAutoMode}
          onToggle={toggleViewMode}
          onEnableAuto={enableAutoMode}
        />
      </div>

      {/* Diff editor viewport */}
      <div className="flex-1 w-full h-full relative bg-[var(--bg-app)]">
        {loading ? (
          <div className="w-full h-full flex flex-col items-center justify-center font-mono text-xs text-[var(--text-muted)]">
            <span>Loading Git diff changes...</span>
          </div>
        ) : (
          <DiffEditor
            height="100%"
            language={getEditorLanguage(tab.key)}
            theme="rusty-custom-theme"
            original={gitOriginalCode}
            modified={gitModifiedCode}
            onMount={handleEditorMount}
            options={createMonacoDiffOptions(editorFontSize, {
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: "on",
              renderSideBySide,
            })}
          />
        )}
      </div>
    </div>
  );
};
