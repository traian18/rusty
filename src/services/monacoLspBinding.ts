import { LspConnection, LspService, LspStatus } from "./lspService";
import { getLspKeyFromMonacoId, isLspMonacoId } from "./languageRegistry";
import { useWorkspaceStore } from "../store";
import {
  registerModelPath,
  unregisterModelPath,
  resolveModelPath,
  resolveInmemoryByContent,
} from "./modelPathRegistry";

/**
 * Monaco <-> LSP binding layer.
 *
 * Owns everything Monaco-specific that used to live inline in `FileTab.tsx`:
 *
 *   - Per-editor model synchronization (textDocument/didOpen|didChange|didClose)
 *     with ref-counting so split editors sharing one Monaco model don't tear
 *     down the server-side document when one copy closes.
 *   - Global Monaco language-feature provider registration, keyed by Monaco
 *     language id (NOT the LSP key — this was a second root cause: providers
 *     were registered under the LSP key, which never matched the model's
 *     language id for .js/.jsx/.sh, so Monaco never invoked them).
 *   - The `openCodeEditor` override that turns definition/references jumps
 *     into Rusty tab opens (moved here from FileTab so it's installed once
 *     globally and reusable).
 *   - Diagnostics -> Monaco marker mapping.
 *   - Indexing/progress status fan-out to attached editors.
 *
 * `LspService` stays pure transport; `FileTab` just calls `attach`/`detach`.
 */

interface AttachOptions {
  onStatus?: (status: LspStatus) => void;
}

/** LSP DiagnosticSeverity -> Monaco MarkerSeverity. */
const SEVERITY_MAP: Record<number, number> = { 1: 8, 2: 4, 3: 2, 4: 1 };

function lspRangeToMonaco(range: any) {
  return {
    startLineNumber: (range?.start?.line ?? 0) + 1,
    startColumn: (range?.start?.character ?? 0) + 1,
    endLineNumber: (range?.end?.line ?? 0) + 1,
    endColumn: (range?.end?.character ?? 0) + 1,
  };
}

function stripWindowsDriveSlash(p: string): string {
  if (p.startsWith("/") && /^\/[a-zA-Z]:/.test(p)) return p.substring(1);
  return p;
}

export class MonacoLspBinding {
  // ── Static registries (process-wide, Monaco is a singleton) ─────────

  private static providerRegistered = new Set<string>(); // by monacoId
  private static modelRefCounts = new Map<string, number>(); // by uri string
  private static openCodeEditorInstalled = false;
  private static tsDiagnosticsDisabled = false;
  private static connectionCallbacksWired = new Set<string>(); // by lspKey
  private static bindingsByLspKey = new Map<string, Set<MonacoLspBinding>>();

  // ── Instance state ──────────────────────────────────────────────────

  private editor: any;
  private filePath: string;
  private model: any;
  private uri: string;
  private monacoId: string;
  private lspKey: string | null;
  private onStatus?: (status: LspStatus) => void;
  private changeDisposable: { dispose(): void } | null = null;
  private debounceTimer: any = null;
  private disposed = false;

  private constructor(editor: any, filePath: string, opts: AttachOptions) {
    this.editor = editor;
    this.filePath = filePath;
    this.onStatus = opts.onStatus;
    this.model = editor.getModel();
    this.uri = this.model?.uri?.toString?.() ?? "";
    this.monacoId = this.model?.getLanguageId?.() ?? "";
    this.lspKey = getLspKeyFromMonacoId(this.monacoId);
  }

  /**
   * Attach LSP intelligence to a mounted Monaco editor.
   * Returns the binding to later `detach()`.
   */
  public static attach(editor: any, filePath: string, opts: AttachOptions = {}): MonacoLspBinding {
    const binding = new MonacoLspBinding(editor, filePath, opts);
    binding.attachInternal();
    return binding;
  }

  private attachInternal() {
    const monaco = (window as any).monaco;
    if (!monaco || !this.model) return;

    // 1. Register the model URI in the path registry so the openCodeEditor
    //    override can resolve definition jumps back to this file.
    registerModelPath(this.uri, this.filePath);

    // 2. Install the global openCodeEditor override + disable built-in TS
    //    diagnostics, each exactly once per Monaco instance.
    MonacoLspBinding.installOpenCodeEditorOverride(this.editor);
    MonacoLspBinding.disableBuiltInTsDiagnostics();

    // 3. If this language has no LSP server, we're done — the override still
    //    lets other files jump *to* this one.
    if (!this.lspKey || !isLspMonacoId(this.monacoId)) {
      return;
    }

    // 4. Register Monaco providers for this monacoId once.
    MonacoLspBinding.ensureProvidersRegistered(this.monacoId);

    // 5. Track this binding for status fan-out.
    const set = MonacoLspBinding.bindingsByLspKey.get(this.lspKey) ?? new Set();
    set.add(this);
    MonacoLspBinding.bindingsByLspKey.set(this.lspKey, set);

    // 6. Ensure the connection exists and wire its callbacks once.
    LspService.ensureConnectionForModel(this.monacoId).then((conn) => {
      if (this.disposed || !conn) return;
      MonacoLspBinding.wireConnectionCallbacks(conn, this.lspKey!);

      // 7. Open the document with the server (ref-counted).
      const refCount = (MonacoLspBinding.modelRefCounts.get(this.uri) ?? 0) + 1;
      MonacoLspBinding.modelRefCounts.set(this.uri, refCount);
      if (refCount === 1) {
        conn.openModel(this.uri, this.monacoId, this.model.getVersionId(), this.model.getValue());
      }

      // 8. Sync edits (debounced) — full content per change. The previous code
      //    sent the entire document on every keystroke, flooding slow servers.
      this.changeDisposable = this.model.onDidChangeContent(() => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (this.disposed) return;
          conn.changeModel(this.uri, this.model.getVersionId(), this.model.getValue());
        }, 150);
      });
    });
  }

  /** Detach: dispose editor-level subscriptions and ref-count the model down. */
  public detach() {
    if (this.disposed) return;
    this.disposed = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.changeDisposable) {
      this.changeDisposable.dispose();
      this.changeDisposable = null;
    }

    if (this.lspKey) {
      const set = MonacoLspBinding.bindingsByLspKey.get(this.lspKey);
      set?.delete(this);
      if (set && set.size === 0) MonacoLspBinding.bindingsByLspKey.delete(this.lspKey);
    }

    const monaco = (window as any).monaco;
    const conn = this.lspKey ? LspService.getConnectionForLspKey(this.lspKey) : null;

    if (this.uri) {
      const remaining = (MonacoLspBinding.modelRefCounts.get(this.uri) ?? 0) - 1;
      if (remaining <= 0) {
        MonacoLspBinding.modelRefCounts.delete(this.uri);
        unregisterModelPath(this.uri);
        if (conn) {
          conn.closeModel(this.uri);
          if (monaco) {
            const model = monaco.editor.getModel(monaco.Uri.parse(this.uri));
            if (model) monaco.editor.setModelMarkers(model, "lsp", []);
          }
        }
      } else {
        MonacoLspBinding.modelRefCounts.set(this.uri, remaining);
      }
    }
  }

  // ── Global, install-once hooks ──────────────────────────────────────

  /**
   * Override Monaco's code-editor opener so definition/references jumps open
   * as Rusty tabs instead of in Monaco's built-in viewer. Installed once on
   * the shared CodeEditorService.
   */
  private static installOpenCodeEditorOverride(editor: any) {
    if (this.openCodeEditorInstalled) return;
    const monaco = (window as any).monaco;
    const editorService = editor?._codeEditorService;
    if (!editorService || !monaco) return;

    this.openCodeEditorInstalled = true;
    editorService.openCodeEditor = async (input: any) => {
      if (!input || !input.resource) return null;

      const targetUri = input.resource;
      const uriStr = targetUri.toString?.() || targetUri.external;
      let filePath: string | null = null;

      // 1. Path registry covers file:// and inmemory:// models we created.
      filePath = resolveModelPath(uriStr);

      // 2. file:// URIs: take the filesystem path directly.
      if (!filePath && targetUri.scheme === "file") {
        filePath = targetUri.fsPath || targetUri.path;
      }

      // 3. inmemory:// URIs: the TypeScript worker creates internal projections
      //    whose content matches a real file:// model — match by content.
      if (!filePath && targetUri.scheme === "inmemory") {
        filePath = resolveInmemoryByContent(monaco, targetUri);
      }

      if (filePath) filePath = stripWindowsDriveSlash(filePath);

      if (!filePath) {
        console.warn("[LSP] Cannot resolve definition target to a file path:", uriStr);
        return null;
      }

      const lineNum = input.options?.selection?.startLineNumber ?? 1;
      const openTab = useWorkspaceStore.getState().openTab;
      const title = filePath.split("/").pop() || filePath;
      // Shares one identity with the file tree, search palette and context
      // nodes now, so "go to definition" into an already-open file focuses
      // that tab instead of opening a second copy of the same file.
      openTab({ type: "file", path: filePath, title, line: lineNum });
      // Return the currently-focused editor so Monaco treats the jump as handled.
      return monaco.editor?.getFocusedEditor?.() ?? null;
    };
  }

  /**
   * Disable Monaco's built-in TypeScript worker diagnostics so error squiggles
   * come from the LSP server (typescript-language-server / jdtls / etc.) rather
   * than the worker. Monaco has no public API to unregister the worker's own
   * definition/completion providers, so those coexist as a fallback — but the
   * cross-file jump still routes through our openCodeEditor override, so
   * navigation is consistent across languages.
   *
   * Called unconditionally at Monaco startup (see ThemeRuntime/FileTab), not
   * just when an LSP attaches: the built-in worker has no awareness of this
   * project's tsconfig, module resolution, or file system, so left enabled it
   * produces false-positive "cannot find module"/"cannot use JSX" errors on
   * any file with project-relative imports. Real diagnostics come from the
   * LSP's own markers once `LSP_EDITOR_ENABLED` is turned on for a language.
   */
  public static disableBuiltInTsDiagnostics(monacoInstance?: any) {
    if (this.tsDiagnosticsDisabled) return;
    const monaco = monacoInstance || (window as any).monaco;
    if (!monaco?.languages?.typescript) return;
    this.tsDiagnosticsDisabled = true;
    try {
      monaco.languages.typescript.typescriptDefaults?.setDiagnosticsOptions?.({
        noSemanticValidation: true,
        noSyntaxValidation: true,
      });
      monaco.languages.typescript.javascriptDefaults?.setDiagnosticsOptions?.({
        noSemanticValidation: true,
        noSyntaxValidation: true,
      });
    } catch {
      /* older monaco builds may not expose these */
    }
  }

  /** Wire onStatus/onDiagnostics/onProgress on a connection exactly once. */
  private static wireConnectionCallbacks(conn: LspConnection, lspKey: string) {
    if (this.connectionCallbacksWired.has(lspKey)) return;
    this.connectionCallbacksWired.add(lspKey);

    const monaco = (window as any).monaco;

    conn.onStatus = (status: LspStatus) => {
      const set = this.bindingsByLspKey.get(lspKey);
      if (!set) return;
      for (const binding of set) {
        try {
          binding.onStatus?.(status);
        } catch {
          /* ignore */
        }
      }
    };

    conn.onDiagnostics = ({ uri, diagnostics }) => {
      if (!monaco || !uri) return;
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (!model) return;
      const markers = (diagnostics || []).map((diag: any) => ({
        severity: SEVERITY_MAP[diag.severity] ?? 1,
        message: diag.message,
        source: diag.source || "lsp",
        code: diag.code,
        startLineNumber: (diag.range?.start?.line ?? 0) + 1,
        startColumn: (diag.range?.start?.character ?? 0) + 1,
        endLineNumber: (diag.range?.end?.line ?? 0) + 1,
        endColumn: (diag.range?.end?.character ?? 0) + 1,
      }));
      monaco.editor.setModelMarkers(model, "lsp", markers);
    };
  }

  // ── Provider registration (once per monacoId) ───────────────────────

  private static ensureProvidersRegistered(monacoId: string) {
    if (this.providerRegistered.has(monacoId)) return;
    this.providerRegistered.add(monacoId);
    const monaco = (window as any).monaco;
    if (!monaco) return;

    console.log(`[LSP Binding] Registering Monaco providers for: ${monacoId}`);

    // Shared: resolve a live connection for a model, waiting for boot so
    // providers during server startup wait instead of returning null.
    const connFor = (model: any): Promise<LspConnection | null> => {
      const id = model.getLanguageId();
      return LspService.ensureConnectionForModel(id);
    };

    // 1. Completion
    monaco.languages.registerCompletionItemProvider(monacoId, {
      triggerCharacters: [".", ":", "/", "@", "(", '"', "'", "<"],
      provideCompletionItems: async (model: any, position: any) => {
        const conn = await connFor(model);
        if (!conn || !conn.supports("textDocument/completion")) return { suggestions: [] };
        try {
          const result = await conn.sendRequest("textDocument/completion", {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          });
          if (!result) return { suggestions: [] };
          const items = Array.isArray(result) ? result : result.items || [];
          const wordRange = model.getWordUntilPosition(position);
          const CompletionItemKind = monaco.languages.CompletionItemKind;
          const suggestions = items.map((item: any) => {
            let kind = CompletionItemKind.Property;
            if (item.kind >= 1 && item.kind <= 25) kind = item.kind - 1;
            const label = typeof item.label === "string" ? item.label : item.label?.label;
            let insertText = label;
            let range: any = {
              startLineNumber: wordRange.startLineNumber,
              startColumn: wordRange.startColumn,
              endLineNumber: wordRange.endLineNumber,
              endColumn: wordRange.endColumn,
            };
            if (item.textEdit) {
              const te = item.textEdit.newText ? item.textEdit : item.textEdit;
              const newText = te.newText || te.text || "";
              const teRange = te.range || te.replace || te.insert;
              if (newText) insertText = newText;
              if (teRange) range = lspRangeToMonaco(teRange);
            } else if (item.insertText) {
              insertText = item.insertText;
            }
            let insertTextRules;
            if (item.insertTextFormat === 2) {
              insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
            }
            const documentation =
              typeof item.documentation === "string"
                ? item.documentation
                : item.documentation?.value;
            return {
              label,
              kind,
              detail: item.detail || "",
              documentation,
              insertText,
              insertTextRules,
              range,
              sortText: item.sortText,
              filterText: item.filterText,
            };
          });
          return { suggestions };
        } catch {
          return { suggestions: [] };
        }
      },
    });

    // 2. Hover
    monaco.languages.registerHoverProvider(monacoId, {
      provideHover: async (model: any, position: any) => {
        const conn = await connFor(model);
        if (!conn || !conn.supports("textDocument/hover")) return null;
        try {
          const result = await conn.sendRequest("textDocument/hover", {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          });
          if (!result || !result.contents) return null;
          const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
          const value = contents
            .map((c: any) => (typeof c === "string" ? c : c?.value || ""))
            .join("\n\n");
          return {
            contents: [{ value }],
            range: result.range ? lspRangeToMonaco(result.range) : undefined,
          };
        } catch {
          return null;
        }
      },
    });

    // Shared definition-like resolver (definition/declaration/typeDefinition/implementation).
    // Each Monaco provider interface requires a different method name on the
    // provider object (provideDefinition / provideDeclaration / ...), so we pass
    // both the LSP method and the Monaco provider-method name.
    const registerDefinitionLike = (
      lspMethod: string,
      registerFn: string,
      providerMethod: string
    ) => {
      monaco.languages[registerFn](monacoId, {
        [providerMethod]: async (model: any, position: any) => {
          const conn = await connFor(model);
          if (!conn || !conn.supports(lspMethod)) return null;
          try {
            const result = await conn.sendRequest(lspMethod, {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            });
            if (!result) return null;
            const mapLoc = (loc: any) => {
              const tUri = loc.uri || loc.targetUri;
              const tRange = loc.range || loc.targetSelectionRange || loc.targetRange;
              return { uri: monaco.Uri.parse(tUri), range: lspRangeToMonaco(tRange) };
            };
            return Array.isArray(result) ? result.map(mapLoc) : mapLoc(result);
          } catch {
            return null;
          }
        },
      });
    };
    registerDefinitionLike("textDocument/definition", "registerDefinitionProvider", "provideDefinition");
    registerDefinitionLike("textDocument/declaration", "registerDeclarationProvider", "provideDeclaration");
    registerDefinitionLike("textDocument/typeDefinition", "registerTypeDefinitionProvider", "provideTypeDefinition");
    registerDefinitionLike("textDocument/implementation", "registerImplementationProvider", "provideImplementation");

    // 3. References
    monaco.languages.registerReferenceProvider(monacoId, {
      provideReferences: async (model: any, position: any, context: any) => {
        const conn = await connFor(model);
        if (!conn || !conn.supports("textDocument/references")) return null;
        try {
          const result = await conn.sendRequest("textDocument/references", {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            context,
          });
          if (!result || !Array.isArray(result)) return null;
          return result.map((loc: any) => ({
            uri: monaco.Uri.parse(loc.uri || loc.targetUri),
            range: lspRangeToMonaco(loc.range || loc.targetSelectionRange || loc.targetRange),
          }));
        } catch {
          return null;
        }
      },
    });

    // 4. Document symbol (outline)
    monaco.languages.registerDocumentSymbolProvider(monacoId, {
      provideDocumentSymbols: async (model: any) => {
        const conn = await connFor(model);
        if (!conn || !conn.supports("textDocument/documentSymbol")) return [];
        try {
          const result = await conn.sendRequest("textDocument/documentSymbol", {
            textDocument: { uri: model.uri.toString() },
          });
          if (!result) return [];
          const mapSymbol = (sym: any): any => ({
            name: sym.name,
            detail: sym.detail || "",
            kind: sym.kind,
            tags: sym.tags,
            range: lspRangeToMonaco(sym.range),
            selectionRange: lspRangeToMonaco(sym.selectionRange),
            children: Array.isArray(sym.children) ? sym.children.map(mapSymbol) : undefined,
          });
          return result.map(mapSymbol);
        } catch {
          return [];
        }
      },
    });

    // 5. Signature help
    monaco.languages.registerSignatureHelpProvider(monacoId, {
      signatureHelpTriggerCharacters: ["(", ","],
      provideSignatureHelp: async (model: any, position: any) => {
        const conn = await connFor(model);
        if (!conn || !conn.supports("textDocument/signatureHelp")) return null;
        try {
          const result = await conn.sendRequest("textDocument/signatureHelp", {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          });
          if (!result) return null;
          return {
            signatures: result.signatures || [],
            activeSignature: result.activeSignature,
            activeParameter: result.activeParameter,
          };
        } catch {
          return null;
        }
      },
    });

    // 6. Document highlight (occurrences)
    monaco.languages.registerDocumentHighlightProvider(monacoId, {
      provideDocumentHighlights: async (model: any, position: any) => {
        const conn = await connFor(model);
        if (!conn || !conn.supports("textDocument/documentHighlight")) return [];
        try {
          const result = await conn.sendRequest("textDocument/documentHighlight", {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          });
          if (!result) return [];
          return result.map((hl: any) => ({ range: lspRangeToMonaco(hl.range), kind: hl.kind }));
        } catch {
          return [];
        }
      },
    });

    // 7. Folding range
    monaco.languages.registerFoldingRangeProvider(monacoId, {
      provideFoldingRanges: async (model: any) => {
        const conn = await connFor(model);
        if (!conn || !conn.supports("textDocument/foldingRange")) return [];
        try {
          const result = await conn.sendRequest("textDocument/foldingRange", {
            textDocument: { uri: model.uri.toString() },
          });
          if (!result) return [];
          return result.map((fr: any) => ({
            start: (fr.startLine ?? 0) + 1,
            end: (fr.endLine ?? 0) + 1,
            startCharacter: fr.startCharacter,
            endCharacter: fr.endCharacter,
            kind: fr.kind,
          }));
        } catch {
          return [];
        }
      },
    });

    // 8. Formatting (whole document) + range formatting. Both apply TextEdits
    //    to the current model only, so they work without workspace-edit support.
    monaco.languages.registerDocumentFormattingEditProvider(monacoId, {
      provideDocumentFormattingEdits: async (model: any) => {
        const conn = await connFor(model);
        if (!conn || !conn.supports("textDocument/formatting")) return [];
        try {
          const result = await conn.sendRequest("textDocument/formatting", {
            textDocument: { uri: model.uri.toString() },
            options: { tabSize: model.getOptions?.().tabSize ?? 2, insertSpaces: true },
          });
          if (!result) return [];
          return result.map((ed: any) => ({ range: lspRangeToMonaco(ed.range), text: ed.newText }));
        } catch {
          return [];
        }
      },
    });
    monaco.languages.registerDocumentRangeFormattingEditProvider(monacoId, {
      provideDocumentRangeFormattingEdits: async (model: any, range: any) => {
        const conn = await connFor(model);
        if (!conn || !conn.supports("textDocument/rangeFormatting")) return [];
        try {
          const result = await conn.sendRequest("textDocument/rangeFormatting", {
            textDocument: { uri: model.uri.toString() },
            range: {
              start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
              end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
            },
            options: { tabSize: model.getOptions?.().tabSize ?? 2, insertSpaces: true },
          });
          if (!result) return [];
          return result.map((ed: any) => ({ range: lspRangeToMonaco(ed.range), text: ed.newText }));
        } catch {
          return [];
        }
      },
    });

    // 9. Inlay hints
    if (monaco.languages.registerInlayHintsProvider) {
      monaco.languages.registerInlayHintsProvider(monacoId, {
        provideInlayHints: async (model: any, range: any) => {
          const conn = await connFor(model);
          if (!conn || !conn.supports("textDocument/inlayHint")) return { hints: [], dispose: () => {} };
          try {
            const result = await conn.sendRequest("textDocument/inlayHint", {
              textDocument: { uri: model.uri.toString() },
              range: {
                start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
              },
            });
            if (!result) return { hints: [], dispose: () => {} };
            const hints = result.map((h: any) => {
              const label = typeof h.label === "string" ? h.label : (h.label || []).map((p: any) => p.value || "").join("");
              return {
                label,
                position: {
                  lineNumber: (h.position?.line ?? 0) + 1,
                  column: (h.position?.character ?? 0) + 1,
                },
                kind: h.kind,
                paddingLeft: h.paddingLeft,
                paddingRight: h.paddingRight,
              };
            });
            return { hints, dispose: () => {} };
          } catch {
            return { hints: [], dispose: () => {} };
          }
        },
      });
    }
  }
}
