import React, { useState, useEffect, useRef } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { ChevronDown, ChevronRight, ChevronLeft, Save, RotateCcw, Loader2, FileCode } from "lucide-react";
import { VfsRegistry } from "../../../services/vfs";
import { invoke } from "@tauri-apps/api/core";
import { DiffViewToggle } from "../../ui/DiffViewToggle";
import { notify } from "../../../notificationStore";
import { CustomSelect } from "../../CustomSelect";
import { getMonacoLanguageId } from "../../../services/languageRegistry";
import { useWorkspaceStore } from "../../../store";
import { createMonacoDiffOptions } from "../../../editor/monacoOptions";

// ── Attribution palette ─────────────────────────────────────────────────────
// Each slot: [border stripe hex, background rgba, overview ruler hex]
const TASK_PALETTE = [
  { stripe: "#6366f1", bg: "rgba(99,102,241,0.08)",  ruler: "#6366f199" },
  { stripe: "#10b981", bg: "rgba(16,185,129,0.08)",  ruler: "#10b98199" },
  { stripe: "#f59e0b", bg: "rgba(245,158,11,0.08)",  ruler: "#f59e0b99" },
  { stripe: "#ef4444", bg: "rgba(239,68,68,0.08)",   ruler: "#ef444499" },
  { stripe: "#06b6d4", bg: "rgba(6,182,212,0.08)",   ruler: "#06b6d499" },
  { stripe: "#84cc16", bg: "rgba(132,204,22,0.08)",  ruler: "#84cc1699" },
] as const;

const SYNTHESIZED_PALETTE = { stripe: "#a855f7", bg: "rgba(168,85,247,0.08)", ruler: "#a855f799" };

// ── CSS injection (once per document) ──────────────────────────────────────
let _cssInjected = false;
function ensureAttributionCss() {
  if (_cssInjected || typeof document === "undefined") return;
  _cssInjected = true;
  const style = document.createElement("style");
  style.textContent = [
    ...TASK_PALETTE.map((p, i) => `
      .rusty-attr-bg-${i} { background-color: ${p.bg} !important; }
      .rusty-attr-stripe-${i} { background: ${p.stripe} !important; width: 3px !important; margin-left: 1px; border-radius: 1px; }
    `),
    `.rusty-attr-bg-synth { background-color: ${SYNTHESIZED_PALETTE.bg} !important; }`,
    `.rusty-attr-stripe-synth { background: ${SYNTHESIZED_PALETTE.stripe} !important; width: 3px !important; margin-left: 1px; border-radius: 1px; }`,
  ].join("\n");
  document.head.appendChild(style);
}

// ── Attribution algorithm ──────────────────────────────────────────────────
export interface TaskVersion {
  taskId: string;
  taskName: string;
  content: string;
}

interface AttributedLine {
  lineIndex: number; // 0-based
  type: "original" | "task" | "synthesized";
  taskIndex: number; // -1 for original/synthesized
}

function computeAttribution(
  originalContent: string,
  reconciledContent: string,
  tasks: TaskVersion[],
): AttributedLine[] {
  const originalSet = new Set(originalContent.split("\n"));
  const addedBySets = tasks.map((t) => {
    const orig = new Set(originalContent.split("\n"));
    const added = new Set<string>();
    for (const line of t.content.split("\n")) {
      if (!orig.has(line)) added.add(line);
    }
    return added;
  });
  const claimedCounts: Map<string, number>[] = tasks.map(() => new Map());
  const taskLineCounts: Map<string, number>[] = tasks.map((t) => {
    const m = new Map<string, number>();
    for (const line of t.content.split("\n")) {
      m.set(line, (m.get(line) || 0) + 1);
    }
    return m;
  });

  return reconciledContent.split("\n").map((line, lineIndex) => {
    if (originalSet.has(line)) return { lineIndex, type: "original", taskIndex: -1 };
    for (let i = 0; i < tasks.length; i++) {
      if (addedBySets[i].has(line)) {
        const claimed = claimedCounts[i].get(line) || 0;
        const available = taskLineCounts[i].get(line) || 0;
        if (claimed < available) {
          claimedCounts[i].set(line, claimed + 1);
          return { lineIndex, type: "task", taskIndex: i };
        }
      }
    }
    return { lineIndex, type: "synthesized", taskIndex: -1 };
  });
}

function applyAttributionDecorations(
  modifiedEditor: any,
  monacoInstance: any,
  originalContent: string,
  reconciledContent: string,
  tasks: TaskVersion[],
  decorationsRef: React.MutableRefObject<string[]>,
) {
  if (!modifiedEditor || !monacoInstance || !tasks.length) {
    if (decorationsRef.current.length) {
      decorationsRef.current = modifiedEditor?.deltaDecorations(decorationsRef.current, []) || [];
    }
    return;
  }

  ensureAttributionCss();
  const attributed = computeAttribution(originalContent, reconciledContent, tasks);
  const decorations: any[] = [];

  for (const line of attributed) {
    if (line.type === "original") continue;
    const monacoLine = line.lineIndex + 1; // 1-based
    const palette = line.type === "task"
      ? TASK_PALETTE[line.taskIndex % TASK_PALETTE.length]
      : SYNTHESIZED_PALETTE;
    const suffix = line.type === "task"
      ? `${line.taskIndex % TASK_PALETTE.length}`
      : "synth";

    decorations.push({
      range: new monacoInstance.Range(monacoLine, 1, monacoLine, 1),
      options: {
        isWholeLine: true,
        className: `rusty-attr-bg-${suffix}`,
        linesDecorationsClassName: `rusty-attr-stripe-${suffix}`,
        overviewRulerColor: palette.ruler,
        overviewRulerLane: 4, // right
        minimap: { color: palette.stripe, position: 1 },
      },
    });
  }

  decorationsRef.current = modifiedEditor.deltaDecorations(decorationsRef.current, decorations);
}

// ── Prop types ─────────────────────────────────────────────────────────────
interface PRDiffViewProps {
  tabId: string;
  modifiedFiles: string[];
  ownerNodeId?: string;
  persistenceTabId?: string;
  taskVersionsPerFile?: Record<string, TaskVersion[]>;
  refreshKey?: number;
  onFileSaved?: (filePath: string) => void | Promise<void>;
}

interface FileDiffState {
  path: string;
  name: string;
  dir: string;
  original: string;
  modified: string;
  edited: string;
  isDirty: boolean;
  isCollapsed: boolean;
  isSaving: boolean;
}

interface FileDiffCardProps {
  file: string;
  state: FileDiffState;
  taskVersions?: TaskVersion[];
  renderSideBySide: boolean;
  onContentChange: (filePath: string, newContent: string) => void;
  onSaveFile: (filePath: string) => Promise<void>;
  onResetFile: (filePath: string, editor: any) => void;
  toggleCollapse: (filePath: string) => void;
}

// ── FileDiffCard ───────────────────────────────────────────────────────────
const FileDiffCard: React.FC<FileDiffCardProps> = ({
  file,
  state,
  taskVersions,
  renderSideBySide,
  onContentChange,
  onSaveFile,
  onResetFile,
  toggleCollapse,
}) => {
  const editorFontSize = useWorkspaceStore((state) => state.typographyPreferences.editorFontSize);
  const [hasRendered, setHasRendered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<string[]>([]);
  const contentChangeDisposableRef = useRef<any>(null);

  // Lazy render via IntersectionObserver
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setHasRendered(true); },
      { rootMargin: "400px 0px 400px 0px" },
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => { if (containerRef.current) observer.unobserve(containerRef.current); };
  }, []);

  // Re-apply decorations when content or task versions change
  useEffect(() => {
    const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
    if (!modifiedEditor || !monacoRef.current) return;
    applyAttributionDecorations(
      modifiedEditor,
      monacoRef.current,
      state.original,
      state.edited,
      taskVersions || [],
      decorationsRef,
    );
  }, [state.original, state.edited, taskVersions]);

  const lineCount = Math.max(state.original.split("\n").length, state.edited.split("\n").length);
  const editorHeight = lineCount * 18 + 20;

  // Active tasks (those that have at least one attributed line)
  const activeTasks = taskVersions?.length ? taskVersions : [];

  return (
    <div
      ref={containerRef}
      className="border border-[var(--border-color)] rounded-xl overflow-hidden shadow-md flex flex-col bg-[var(--color-surface-sunken)] transition-all hover:border-[var(--border-active)]/55"
    >
      {/* File Header */}
      <div
        onClick={() => toggleCollapse(file)}
        className="px-4 py-3 bg-[var(--bg-sidebar)] border-b border-[var(--border-color)] flex items-center justify-between select-none cursor-pointer hover:bg-[var(--bg-sidebar)]/80 transition-colors"
      >
        <div className="flex items-center space-x-2 font-mono text-xs text-[var(--text-light)] min-w-0">
          {state.isCollapsed ? <ChevronRight size={14} className="flex-shrink-0" /> : <ChevronDown size={14} className="flex-shrink-0" />}
          <span className="font-semibold truncate">{state.name}</span>
          {state.dir && <span className="text-[10px] text-[var(--text-muted)] truncate max-w-[180px]">({state.dir})</span>}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {state.isDirty && (
            <span className="text-[9px] font-mono text-[var(--color-status-warning)] bg-[var(--color-status-warning-bg)] border border-[var(--color-status-warning-border)] px-1.5 py-0.5 rounded uppercase">
              Unsaved
            </span>
          )}
          {state.isDirty && (
            <>
              <button
                onClick={() => onResetFile(file, diffEditorRef.current)}
                disabled={state.isSaving}
                className="p-1 hover:bg-[var(--bg-app)] hover:text-[var(--text-light)] text-[var(--text-muted)] rounded transition-colors"
                title="Reset changes"
              >
                <RotateCcw size={13} />
              </button>
              <button
                onClick={() => onSaveFile(file)}
                disabled={state.isSaving}
                className="p-1 hover:bg-[var(--color-status-success-solid)] bg-[var(--color-status-success-bg)] text-[var(--color-status-success)] hover:text-[var(--color-status-success-solid-foreground)] rounded transition-colors"
                title="Save to VFS"
              >
                {state.isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Task attribution legend */}
      {!state.isCollapsed && activeTasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/40">
          <span className="text-[9px] font-mono font-bold uppercase text-[var(--text-muted)]">Changes from:</span>
          {activeTasks.map((t, i) => {
            const p = TASK_PALETTE[i % TASK_PALETTE.length];
            return (
              <span
                key={t.taskId}
                className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-mono"
                style={{ borderColor: p.stripe, color: p.stripe, backgroundColor: p.bg }}
              >
                <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.stripe }} />
                {t.taskName}
              </span>
            );
          })}
          <span
            className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-mono"
            style={{ borderColor: SYNTHESIZED_PALETTE.stripe, color: SYNTHESIZED_PALETTE.stripe, backgroundColor: SYNTHESIZED_PALETTE.bg }}
          >
            <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: SYNTHESIZED_PALETTE.stripe }} />
            Synthesized
          </span>
        </div>
      )}

      {/* Monaco Diff Editor */}
      {!state.isCollapsed && (
        <div
          style={{ height: `${editorHeight}px` }}
          className="w-full border-t border-[var(--border-color)] overflow-hidden relative bg-[var(--bg-app)]/30"
        >
          {hasRendered ? (
            <DiffEditor
              height="100%"
              language={getMonacoLanguageId(file)}
              theme="rusty-custom-theme"
              original={state.original}
              modified={state.edited}
              onMount={(editor, monaco) => {
                diffEditorRef.current = editor;
                monacoRef.current = monaco;
                const modifiedEditor = editor.getModifiedEditor();
                modifiedEditor.updateOptions({ readOnly: false });

                if (contentChangeDisposableRef.current) {
                  contentChangeDisposableRef.current.dispose();
                }
                contentChangeDisposableRef.current = modifiedEditor.onDidChangeModelContent(() => {
                  onContentChange(file, modifiedEditor.getValue());
                });

                // Apply initial attribution decorations
                applyAttributionDecorations(
                  modifiedEditor,
                  monaco,
                  state.original,
                  state.edited,
                  taskVersions || [],
                  decorationsRef,
                );

                // Re-apply after diff computation settles (Monaco needs a tick)
                setTimeout(() => {
                  applyAttributionDecorations(
                    modifiedEditor,
                    monaco,
                    state.original,
                    state.edited,
                    taskVersions || [],
                    decorationsRef,
                  );
                }, 200);
              }}
              options={createMonacoDiffOptions(editorFontSize, {
                readOnly: false,
                minimap: { enabled: true },
                scrollBeyondLastLine: false,
                lineNumbers: "on",
                renderSideBySide: renderSideBySide,
                scrollbar: { vertical: "hidden", handleMouseWheel: false },
                automaticLayout: true,
              })}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-app)] text-[var(--text-muted)] text-[11px] font-mono">
              <Loader2 className="animate-spin text-[var(--color-status-danger)] mr-2" size={14} />
              <span>Preloading editor for {state.name}...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── PRDiffView ─────────────────────────────────────────────────────────────
export const PRDiffView: React.FC<PRDiffViewProps> = ({
  tabId,
  modifiedFiles,
  ownerNodeId,
  persistenceTabId,
  taskVersionsPerFile,
  refreshKey = 0,
  onFileSaved,
}) => {
  const [filesState, setFilesState] = useState<Record<string, FileDiffState>>({});
  const [loading, setLoading] = useState(false);
  const [renderSideBySide, setRenderSideBySide] = useState(true);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  const loadAllDiffs = async () => {
    if (modifiedFiles.length === 0) {
      setFilesState({});
      setActiveFilePath(null);
      return;
    }
    setLoading(true);
    const newState: Record<string, FileDiffState> = {};
    for (const file of modifiedFiles) {
      try {
        const modified: string = await VfsRegistry.getOrCreate(tabId).readFile(file);
        let original: string;
        try {
          original = await invoke("read_file_disk", { path: file });
        } catch {
          original = ""; // New file not on disk yet
        }
        const parts = file.split("/");
        const name = parts[parts.length - 1];
        const dir = parts.slice(0, -1).join("/");
        newState[file] = {
          path: file,
          name,
          dir,
          original,
          modified,
          edited: modified,
          isDirty: false,
          isCollapsed: false,
          isSaving: false,
        };
      } catch (err) {
        console.error(`Failed to load diff content for ${file}:`, err);
      }
    }
    setFilesState(newState);
    if (modifiedFiles.length > 0) {
      setActiveFilePath((prev) => (prev && modifiedFiles.includes(prev) ? prev : modifiedFiles[0]));
    }
    setLoading(false);
  };

  useEffect(() => {
    loadAllDiffs();
  }, [tabId, modifiedFiles.join(","), refreshKey]);

  const toggleCollapse = (filePath: string) => {
    setFilesState((prev) => {
      const current = prev[filePath];
      if (!current) return prev;
      return { ...prev, [filePath]: { ...current, isCollapsed: !current.isCollapsed } };
    });
  };

  const handleContentChange = (filePath: string, newContent: string) => {
    setFilesState((prev) => {
      const current = prev[filePath];
      if (!current) return prev;
      return { ...prev, [filePath]: { ...current, edited: newContent, isDirty: newContent !== current.modified } };
    });
  };

  const handleSaveFile = async (filePath: string) => {
    const file = filesState[filePath];
    if (!file || !file.isDirty || file.isSaving) return;
    setFilesState((prev) => ({ ...prev, [filePath]: { ...prev[filePath], isSaving: true } }));
    try {
      await VfsRegistry.getOrCreate(tabId).writeFile(filePath, file.edited, ownerNodeId);
      await onFileSaved?.(filePath);
      setFilesState((prev) => {
        const current = prev[filePath];
        return { ...prev, [filePath]: { ...current, modified: current.edited, isDirty: false, isSaving: false } };
      });
      const { canvasFileService } = await import("../../tabs/canvas/services/canvasFileService");
      canvasFileService.autoSaveCanvas(persistenceTabId || tabId);
      notify("Saved", `${file.name} saved to VFS.`, "success");
    } catch (err: any) {
      console.error("Failed to save VFS file:", err);
      notify("Save Failed", `Failed to save ${file.name}: ${err.message || String(err)}`, "error");
      setFilesState((prev) => ({ ...prev, [filePath]: { ...prev[filePath], isSaving: false } }));
    }
  };

  const handleResetFile = (filePath: string, editor: any) => {
    const file = filesState[filePath];
    if (!file) return;
    if (editor) editor.getModifiedEditor?.()?.setValue(file.modified);
    setFilesState((prev) => ({ ...prev, [filePath]: { ...prev[filePath], edited: file.modified, isDirty: false } }));
  };

  const currentIndex = activeFilePath ? modifiedFiles.indexOf(activeFilePath) : -1;
  const handlePrev = () => { if (currentIndex > 0) setActiveFilePath(modifiedFiles[currentIndex - 1]); };
  const handleNext = () => { if (currentIndex < modifiedFiles.length - 1) setActiveFilePath(modifiedFiles[currentIndex + 1]); };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-[var(--bg-app)] text-[var(--text-muted)] text-xs font-mono">
        <Loader2 className="animate-spin text-[var(--color-status-danger)] mb-2" size={24} />
        <span>Loading code diffs...</span>
      </div>
    );
  }

  if (modifiedFiles.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-[var(--text-muted)]">
        <FileCode size={32} className="text-[var(--text-muted)]/20 mb-2" />
        <span className="text-xs">No modified VFS files detected.</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--bg-app)]">
      {/* Toolbar */}
      <div className="flex flex-col border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/30 flex-shrink-0">
        <div className="px-4 py-2 bg-[var(--bg-sidebar)]/80 flex items-center justify-between text-xs font-mono select-none">
          <div className="flex items-center space-x-2">
            <button
              onClick={handlePrev}
              disabled={currentIndex <= 0}
              className="p-1.5 rounded hover:bg-[var(--accent-bg)] text-[var(--text-muted)] hover:text-[var(--text-light)] disabled:opacity-30 disabled:hover:bg-transparent transition-colors cursor-pointer disabled:cursor-not-allowed border border-[var(--border-color)]"
              title="Previous file"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              onClick={handleNext}
              disabled={currentIndex >= modifiedFiles.length - 1}
              className="p-1.5 rounded hover:bg-[var(--accent-bg)] text-[var(--text-muted)] hover:text-[var(--text-light)] disabled:opacity-30 disabled:hover:bg-transparent transition-colors cursor-pointer disabled:cursor-not-allowed border border-[var(--border-color)]"
              title="Next file"
            >
              <ChevronRight size={14} />
            </button>
            <CustomSelect
              value={activeFilePath || ""}
              onChange={(val) => setActiveFilePath(val || null)}
              options={modifiedFiles.map((f) => {
                const name = f.split("/").pop() || f;
                const s = filesState[f];
                return { id: f, name: s?.isDirty ? `* ${name}` : name };
              })}
              placeholder="Select file"
              className="w-64 text-xs font-mono"
              direction="down"
            />
            <span className="text-[10px] text-[var(--text-muted)] font-mono pl-1">
              {currentIndex + 1} of {modifiedFiles.length}
            </span>
          </div>
          <DiffViewToggle
            viewMode={renderSideBySide ? "side-by-side" : "inline"}
            isAutoMode={false}
            onToggle={() => setRenderSideBySide(!renderSideBySide)}
            onEnableAuto={() => {}}
          />
        </div>
      </div>

      {/* Active file diff */}
      <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
        {activeFilePath && filesState[activeFilePath] && (
          <FileDiffCard
            file={activeFilePath}
            state={{ ...filesState[activeFilePath], isCollapsed: false }}
            taskVersions={taskVersionsPerFile?.[activeFilePath]}
            renderSideBySide={renderSideBySide}
            onContentChange={handleContentChange}
            onSaveFile={handleSaveFile}
            onResetFile={handleResetFile}
            toggleCollapse={toggleCollapse}
          />
        )}
      </div>
    </div>
  );
};
