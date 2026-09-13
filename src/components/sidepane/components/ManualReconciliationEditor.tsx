import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { ArrowLeftToLine, ChevronLeft, ChevronRight, Loader2, MessageSquareCode, RotateCcw, Save, Sparkles, UserRoundCheck } from "lucide-react";
import { VfsRegistry } from "../../../services/vfs";
import { getMonacoLanguageId } from "../../../services/languageRegistry";
import { CustomSelect } from "../../CustomSelect";
import { InlineChat } from "../../inline-chat/InlineChat";
import type { InlineChatEditorContext } from "../../../services/inlineChatService";
import { notify } from "../../../notificationStore";
import { useWorkspaceStore } from "../../../store";
import { createMonacoDiffOptions, createMonacoEditorOptions } from "../../../editor/monacoOptions";

export interface ManualReconciliationVariant {
  taskId: string;
  taskName: string;
  sourcePath: string;
  content?: string;
  prompt?: string;
}

interface ManualReconciliationEditorProps {
  tabId: string;
  filePath: string;
  sourcePath: string;
  variants: ManualReconciliationVariant[];
  onSave: (content: string) => Promise<void>;
  onAskModel?: (prompt: string) => Promise<void> | void;
  modelBusy?: boolean;
  refreshKey?: number;
}

const editorBehaviorOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "off" as const,
};

interface DiffLineHunk {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/** Apply one Monaco line change from a task version into the working result. */
function applyLineHunk(result: string, taskVersion: string, hunk: DiffLineHunk): string {
  const resultLines = result.split("\n");
  const taskLines = taskVersion.split("\n");
  const insertion = hunk.originalEndLineNumber === 0;
  const startIndex = insertion
    ? Math.max(0, hunk.originalStartLineNumber)
    : Math.max(0, hunk.originalStartLineNumber - 1);
  const deleteCount = insertion
    ? 0
    : Math.max(0, hunk.originalEndLineNumber - hunk.originalStartLineNumber + 1);
  const replacement = hunk.modifiedEndLineNumber === 0
    ? []
    : taskLines.slice(hunk.modifiedStartLineNumber - 1, hunk.modifiedEndLineNumber);
  resultLines.splice(startIndex, deleteCount, ...replacement);
  return resultLines.join("\n");
}

export const ManualReconciliationEditor: React.FC<ManualReconciliationEditorProps> = ({
  tabId,
  filePath,
  sourcePath,
  variants,
  onSave,
  onAskModel,
  modelBusy = false,
  refreshKey = 0,
}) => {
  const editorFontSize = useWorkspaceStore((state) => state.typographyPreferences.editorFontSize);
  const [baseline, setBaseline] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState(variants[0]?.taskId || "");
  const [selectedVariantText, setSelectedVariantText] = useState("");
  const [diffHunks, setDiffHunks] = useState<DiffLineHunk[]>([]);
  const [activeHunkIndex, setActiveHunkIndex] = useState(0);
  const [modelPrompt, setModelPrompt] = useState("");
  const [isAskingModel, setIsAskingModel] = useState(false);
  const [inlineChat, setInlineChat] = useState<{ context: InlineChatEditorContext; position: { x: number; y: number } } | null>(null);
  const resultEditorRef = useRef<any>(null);
  const variantEditorRef = useRef<any>(null);
  const variantDiffEditorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inlineChatSessionIdRef = useRef(`manual-reconciliation-${tabId}-${Date.now()}`);

  const activeVariant = useMemo(
    () => variants.find((variant) => variant.taskId === activeTaskId) || variants[0],
    [activeTaskId, variants],
  );

  useEffect(() => {
    if (!variants.some((variant) => variant.taskId === activeTaskId)) {
      setActiveTaskId(variants[0]?.taskId || "");
    }
  }, [activeTaskId, variants]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setInlineChat(null);
    void VfsRegistry.getOrCreate(tabId).readFile(sourcePath || filePath)
      .then((content) => {
        if (cancelled) return;
        setBaseline(content);
        setDraft(content);
      })
      .catch((error: any) => {
        if (!cancelled) notify("Manual Reconciliation", error?.message || String(error), "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, refreshKey, sourcePath, tabId]);

  useEffect(() => {
    setSelectedVariantText("");
    setDiffHunks([]);
    setActiveHunkIndex(0);
  }, [activeTaskId]);

  useEffect(() => {
    const hunk = diffHunks[activeHunkIndex];
    if (!hunk) return;
    variantEditorRef.current?.revealLineInCenter(Math.max(1, hunk.modifiedStartLineNumber));
  }, [activeHunkIndex, diffHunks]);

  const openInlineChat = useCallback(() => {
    const editor = resultEditorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const position = editor?.getPosition();
    if (!model || !selection || !position) return;
    const selectedText = selection.isEmpty() ? "" : model.getValueInRange(selection);
    setInlineChat({
      position: { x: 12, y: 54 },
      context: {
        filePath,
        language: getMonacoLanguageId(filePath),
        fileContent: model.getValue(),
        selection: {
          text: selectedText,
          startLine: selection.startLineNumber,
          startColumn: selection.startColumn,
          endLine: selection.endLineNumber,
          endColumn: selection.endColumn,
        },
      },
    });
  }, [filePath]);

  const handleResultEditorMount = useCallback((editor: any, monaco: any) => {
    resultEditorRef.current = editor;
    editor.addAction({
      id: `rusty.manualReconciliation.inlineChat.${tabId}.${filePath}`,
      label: "Open Inline Chat",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: openInlineChat,
    });
  }, [filePath, openInlineChat, tabId]);

  const handleVariantEditorMount = useCallback((diffEditor: any) => {
    variantDiffEditorRef.current = diffEditor;
    const editor = diffEditor.getModifiedEditor();
    variantEditorRef.current = editor;
    const refreshHunks = () => {
      const hunks = (diffEditor.getLineChanges() || []) as DiffLineHunk[];
      setDiffHunks(hunks);
      setActiveHunkIndex((current) => Math.min(current, Math.max(0, hunks.length - 1)));
    };
    const refreshSelection = () => {
      const model = editor.getModel();
      const selection = editor.getSelection();
      setSelectedVariantText(model && selection && !selection.isEmpty()
        ? model.getValueInRange(selection)
        : "");
      const line = selection?.positionLineNumber;
      if (line) {
        const hunks = (diffEditor.getLineChanges() || []) as DiffLineHunk[];
        const index = hunks.findIndex((hunk) => hunk.modifiedEndLineNumber === 0
          ? line === hunk.modifiedStartLineNumber
          : line >= hunk.modifiedStartLineNumber && line <= hunk.modifiedEndLineNumber);
        if (index >= 0) setActiveHunkIndex(index);
      }
    };
    diffEditor.onDidUpdateDiff(refreshHunks);
    editor.onDidChangeCursorSelection(refreshSelection);
    window.setTimeout(refreshHunks, 0);
    refreshSelection();
  }, []);

  const insertSelection = () => {
    if (!selectedVariantText) {
      notify("Select Code", "Select the code you want to insert from the task version on the right.", "info");
      variantEditorRef.current?.focus();
      return;
    }
    const editor = resultEditorRef.current;
    const selection = editor?.getSelection();
    if (!editor || !selection) return;
    editor.executeEdits("manual-reconciliation", [{ range: selection, text: selectedVariantText, forceMoveMarkers: true }]);
    editor.focus();
  };

  const applyActiveHunk = () => {
    const hunk = diffHunks[activeHunkIndex];
    if (!hunk || activeVariant?.content === undefined) return;
    setDraft((current) => applyLineHunk(current, activeVariant.content!, hunk));
    resultEditorRef.current?.focus();
  };

  const name = filePath.replace(/\\/g, "/").split("/").pop() || filePath;
  const isDirty = draft !== baseline;

  const save = async () => {
    if (loading || isSaving) return;
    setIsSaving(true);
    try {
      await onSave(draft);
      setBaseline(draft);
    } catch {
      // The parent reports the persistence error through the notification UI.
    } finally {
      setIsSaving(false);
    }
  };

  const askModel = async (event: React.FormEvent) => {
    event.preventDefault();
    const prompt = modelPrompt.trim();
    if (!prompt || !onAskModel || isAskingModel || modelBusy) return;
    setIsAskingModel(true);
    try {
      // The model reads the current VFS version, so checkpoint any working
      // manual edits first. The subsequent model result replaces this same
      // reconciliation-owned file and remains fully reversible in the ledger.
      if (isDirty) {
        await onSave(draft);
        setBaseline(draft);
      }
      await onAskModel(prompt);
      setModelPrompt("");
    } catch {
      // The parent reports model and persistence errors.
    } finally {
      setIsAskingModel(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs font-mono text-[var(--text-muted)]">
        <Loader2 size={16} className="animate-spin text-[var(--accent-color)]" />
        <span>Loading {name}…</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative flex flex-1 min-h-0 flex-col bg-[var(--bg-app)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/60 px-3 py-2 font-mono">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-light)]">
            <UserRoundCheck size={14} className="text-[var(--color-status-warning)]" />
            <span className="truncate">{name}</span>
            <span className="rounded border border-[var(--color-status-warning-border)] bg-[var(--color-status-warning-bg)] px-1.5 py-0.5 text-[8px] uppercase text-[var(--color-status-warning)]">Manual</span>
            {isDirty && <span className="text-[9px] text-[var(--color-status-warning)]">Unsaved</span>}
          </div>
          <div className="max-w-[520px] truncate text-[9px] text-[var(--text-muted)]" title={filePath}>{filePath}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={openInlineChat}
            className="flex items-center gap-1 rounded border border-[var(--border-color)] px-2 py-1.5 text-[10px] text-[var(--text-normal)] hover:border-[var(--border-active)] hover:text-[var(--text-light)]"
            title="Open inline chat for the result editor (Cmd/Ctrl+Enter)"
          >
            <MessageSquareCode size={12} />
            <span>Inline Chat</span>
          </button>
          <button
            type="button"
            onClick={() => setDraft(baseline)}
            disabled={!isDirty || isSaving}
            className="rounded border border-[var(--border-color)] p-1.5 text-[var(--text-muted)] hover:text-[var(--text-light)] disabled:opacity-30"
            title="Discard manual edits"
          >
            <RotateCcw size={12} />
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={isSaving}
            className="flex items-center gap-1.5 rounded bg-[var(--color-status-success-solid)] px-3 py-1.5 text-[10px] font-bold text-[var(--color-status-success-solid-foreground)] disabled:opacity-50"
            title="Save this result to the reconciliation VFS and ledger"
          >
            {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            <span>Save Changes</span>
          </button>
        </div>
      </div>

      {onAskModel && (
        <form onSubmit={(event) => void askModel(event)} className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--border-color)] bg-[var(--color-status-danger-bg)]/20 px-3 py-2 font-mono">
          <Sparkles size={13} className="flex-shrink-0 text-[var(--color-status-danger)]" />
          <input
            value={modelPrompt}
            onChange={(event) => setModelPrompt(event.target.value)}
            disabled={modelBusy || isAskingModel}
            placeholder="Ask the reconciliation model to fix something specific in this file…"
            className="min-w-0 flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-app)] px-2.5 py-1.5 text-[10px] text-[var(--text-light)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--color-status-danger-border)] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!modelPrompt.trim() || modelBusy || isAskingModel}
            className="flex flex-shrink-0 items-center gap-1.5 rounded bg-[var(--color-status-danger-solid)] px-3 py-1.5 text-[10px] font-bold text-[var(--color-status-danger-solid-foreground)] disabled:opacity-40"
            title={isDirty ? "Your working result will be saved to the VFS before the model adjusts it" : "Ask the model to adjust this reconciliation-owned file"}
          >
            {(modelBusy || isAskingModel) ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            <span>{isDirty ? "Save & Ask Model" : "Ask Model"}</span>
          </button>
        </form>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-[var(--border-color)]">
        <section className="flex min-h-0 flex-col">
          <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-[var(--border-color)] bg-[var(--color-surface-sunken)] px-3 font-mono">
            <div>
              <div className="text-[10px] font-bold uppercase text-[var(--color-status-success)]">Original / Result</div>
              <div className="text-[9px] text-[var(--text-muted)]">Editable reconciliation output</div>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <Editor
              height="100%"
              path={`inmemory://manual-reconciliation/${encodeURIComponent(tabId)}/${encodeURIComponent(filePath)}/result`}
              language={getMonacoLanguageId(filePath)}
              theme="rusty-custom-theme"
              value={draft}
              onChange={(value) => setDraft(value ?? "")}
              onMount={handleResultEditorMount}
              options={createMonacoEditorOptions(editorFontSize, editorBehaviorOptions)}
            />
          </div>
        </section>

        <section className="flex min-h-0 flex-col">
          <div className="flex min-h-11 flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--border-color)] bg-[var(--color-surface-sunken)] px-3 py-1.5 font-mono">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase text-[var(--color-status-danger)]">Task Changes</div>
              <div className="truncate text-[9px] text-[var(--text-muted)]" title={activeVariant?.sourcePath}>
                From {activeVariant?.taskName || "No saved task version"}{activeVariant?.sourcePath ? ` · ${activeVariant.sourcePath}` : ""}
              </div>
            </div>
            <CustomSelect
              value={activeVariant?.taskId || ""}
              onChange={setActiveTaskId}
              options={variants.map((variant) => ({ id: variant.taskId, name: variant.taskName }))}
              placeholder="Select task version"
              className="w-44 text-[10px]"
              direction="down"
            />
          </div>
          {activeVariant?.prompt && (
            <div className="flex-shrink-0 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/30 px-3 py-1.5 text-[9px] font-mono text-[var(--text-muted)]" title={activeVariant.prompt}>
              <span className="font-bold text-[var(--text-normal)]">Task intent:</span> {activeVariant.prompt}
            </div>
          )}
          {variants.length > 1 && (
            <div className="flex flex-shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/20 px-3 py-1.5 font-mono">
              <span className="flex-shrink-0 text-[8px] font-bold uppercase text-[var(--text-muted)]">Versions:</span>
              {variants.map((variant) => (
                <button
                  key={variant.taskId}
                  type="button"
                  onClick={() => setActiveTaskId(variant.taskId)}
                  className={`flex-shrink-0 rounded border px-2 py-0.5 text-[8px] ${
                    activeVariant?.taskId === variant.taskId
                      ? "border-[var(--color-status-danger-border)] bg-[var(--color-status-danger-bg)] text-[var(--color-status-danger)]"
                      : "border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-light)]"
                  }`}
                  title={`${variant.taskName} · ${variant.sourcePath}`}
                >
                  {variant.taskName}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)]/30 px-3 py-1.5 font-mono">
            <div className="flex items-center gap-1">
              <span className="mr-1 text-[8px] font-bold uppercase text-[var(--text-muted)]">
                {diffHunks.length > 0 ? `Hunk ${activeHunkIndex + 1} of ${diffHunks.length}` : "No remaining hunks"}
              </span>
              <button
                type="button"
                onClick={() => setActiveHunkIndex((index) => Math.max(0, index - 1))}
                disabled={activeHunkIndex <= 0}
                className="rounded border border-[var(--border-color)] p-1 text-[var(--text-muted)] disabled:opacity-30"
                title="Previous diff hunk"
              >
                <ChevronLeft size={10} />
              </button>
              <button
                type="button"
                onClick={() => setActiveHunkIndex((index) => Math.min(diffHunks.length - 1, index + 1))}
                disabled={diffHunks.length === 0 || activeHunkIndex >= diffHunks.length - 1}
                className="rounded border border-[var(--border-color)] p-1 text-[var(--text-muted)] disabled:opacity-30"
                title="Next diff hunk"
              >
                <ChevronRight size={10} />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={applyActiveHunk}
                disabled={diffHunks.length === 0}
                className="flex items-center gap-1 rounded border border-[var(--color-status-success-border)] bg-[var(--color-status-success-bg)] px-2 py-1 text-[8px] font-bold text-[var(--color-status-success)] disabled:opacity-30"
                title="Apply this Git-style diff hunk to the working result"
              >
                <ArrowLeftToLine size={10} />
                <span>Apply Hunk</span>
              </button>
              <button
                type="button"
                onClick={insertSelection}
                className="flex items-center gap-1 rounded border border-[var(--accent-color)]/50 bg-[var(--accent-bg)] px-2 py-1 text-[8px] font-bold text-[var(--accent-color)]"
                title="Insert selected task code at the cursor in the result editor"
              >
                <ArrowLeftToLine size={10} />
                <span>Insert Selection</span>
              </button>
              <button
                type="button"
                onClick={() => activeVariant?.content !== undefined && setDraft(activeVariant.content)}
                disabled={activeVariant?.content === undefined}
                className="rounded border border-[var(--border-color)] px-2 py-1 text-[8px] font-bold text-[var(--text-normal)] disabled:opacity-30"
                title="Use this complete TaskNode version as the working result"
              >
                Apply Version
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {activeVariant?.content !== undefined ? (
              <DiffEditor
                key={activeVariant.taskId}
                height="100%"
                language={getMonacoLanguageId(filePath)}
                theme="rusty-custom-theme"
                original={draft}
                modified={activeVariant.content}
                onMount={handleVariantEditorMount}
                options={createMonacoDiffOptions(editorFontSize, {
                  ...editorBehaviorOptions,
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: false,
                  renderOverviewRuler: false,
                })}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-[10px] font-mono text-[var(--text-muted)]">
                This Task Node has no saved generated-file snapshot for this path.
              </div>
            )}
          </div>
        </section>
      </div>

      {inlineChat && (
        <InlineChat
          sessionId={inlineChatSessionIdRef.current}
          context={inlineChat.context}
          position={inlineChat.position}
          onClose={() => {
            setInlineChat(null);
            window.setTimeout(() => resultEditorRef.current?.focus(), 0);
          }}
        />
      )}
    </div>
  );
};
