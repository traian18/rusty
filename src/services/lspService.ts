import { useWorkspaceStore } from "../store";
import {
  getLspKeyFromPath,
  getLspKeyFromMonacoId,
  LSP_SETTINGS_KEYS,
} from "./languageRegistry";
import { SIDECAR_WS_URL } from "../config/sidecar";

/**
 * LSP transport + JSON-RPC client.
 *
 * Responsibilities:
 *   - Owns the WebSocket connection to the sidecar's /lsp channel.
 *   - Implements the LSP/JSON-RPC framing: distinguishes responses, server
 *     requests, and notifications (the previous implementation treated every
 *     message with an `id` as a response, which dropped/hijacked server
 *     requests like `workspace/configuration` and `client/registerCapability`
 *     — a root cause of jdtls hanging and cmd+click doing nothing).
 *   - Answers server requests (`workspace/configuration`, `window/workDoneProgress/create`,
 *     `client/registerCapability`, `workspace/applyEdit`, ...) so the server
 *     doesn't block waiting on the client.
 *   - Tracks server capabilities from the `initialize` result so callers can
 *     skip unsupported requests instead of timing out.
 *   - Per-request timeouts appropriate to the operation (the previous global
 *     800ms timeout guaranteed that any slow server — jdtls indexing, rust
 *     analyzer, even gopls on a big module — would never answer a goto-def).
 *
 * This module intentionally knows nothing about Monaco models or editors.
 * Monaco glue lives in `monacoLspBinding.ts`.
 */

export type LspStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "initializing" }
  | { state: "indexing"; message?: string; percent?: number }
  | { state: "ready" }
  | { state: "error"; message: string };

export interface LspDiagnostic {
  uri: string;
  diagnostics: any[];
}

export interface LspProgressEvent {
  token: string | number;
  kind: "begin" | "report" | "end";
  title?: string;
  message?: string;
  percentage?: number;
}

/** Per-method default timeouts (ms). Slow indexing servers need room. */
const TIMEOUTS: Record<string, number> = {
  initialize: 60_000,
  "textDocument/completion": 5_000,
  "textDocument/hover": 10_000,
  "textDocument/definition": 15_000,
  "textDocument/declaration": 15_000,
  "textDocument/typeDefinition": 15_000,
  "textDocument/implementation": 15_000,
  "textDocument/references": 15_000,
  "textDocument/documentSymbol": 10_000,
  "textDocument/signatureHelp": 5_000,
  "textDocument/formatting": 5_000,
  "textDocument/rangeFormatting": 5_000,
  "textDocument/codeAction": 10_000,
  "textDocument/rename": 10_000,
  "textDocument/prepareRename": 5_000,
  "textDocument/documentHighlight": 5_000,
  "textDocument/foldingRange": 5_000,
  "textDocument/inlayHint": 5_000,
  "textDocument/semanticTokens/full": 10_000,
};
const DEFAULT_TIMEOUT = 10_000;
export const LSP_RUNTIME_ENABLED = false;

function pathToFileUri(filePath: string): string {
  let normalized = filePath.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  const encoded = normalized
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[a-zA-Z]:$/.test(segment)) return segment;
      return encodeURIComponent(segment);
    })
    .join("/");
  return `file://${encoded}`;
}

class LspConnection {
  private socket: WebSocket | null = null;
  private pendingRequests = new Map<
    number,
    { resolve: (res: any) => void; reject: (err: any) => void }
  >();
  private requestCounter = 0;
  private messageQueue: any[] = [];
  private activeModels = new Set<string>();
  private serverCapabilities: any = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: any) => void) | null = null;
  private status: LspStatus = { state: "disconnected" };

  /** Callbacks wired by the Monaco binding. */
  public onStatus: ((status: LspStatus) => void) | null = null;
  public onDiagnostics: ((diag: LspDiagnostic) => void) | null = null;
  public onProgress: ((event: LspProgressEvent) => void) | null = null;

  constructor(
    public lspKey: string,
    public workspacePath: string,
    public serverPath: string,
    public args: string[]
  ) {}

  public isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  public getStatus(): LspStatus {
    return this.status;
  }

  private setStatus(s: LspStatus) {
    this.status = s;
    try {
      this.onStatus?.(s);
    } catch {
      /* never let a status callback take down the transport */
    }
  }

  /** Resolves once `initialize` + `initialized` have completed. */
  public ready(): Promise<void> {
    if (this.status.state === "ready") return Promise.resolve();
    return this.readyPromise ?? this.connect();
  }

  public connect(): Promise<void> {
    if (this.status.state === "ready" && this.isOpen()) return Promise.resolve();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;

    this.setStatus({ state: "connecting" });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      const argsStr = JSON.stringify(this.args);
      const wsUrl = `${SIDECAR_WS_URL}/lsp?language=${this.lspKey}&workspacePath=${encodeURIComponent(
        this.workspacePath
      )}&serverPath=${encodeURIComponent(this.serverPath)}&args=${encodeURIComponent(argsStr)}`;

      console.log(`[LSP Client] Connecting: ${wsUrl}`);
      const socket = new WebSocket(wsUrl);
      let isOpened = false;

      socket.onopen = () => {
        isOpened = true;
        console.log(`[LSP Client] Connection established for ${this.lspKey}`);
        this.socket = socket;
        this.setStatus({ state: "initializing" });
        this.runInitialize()
          .then(() => {
            this.flushQueue();
            this.setStatus({ state: "ready" });
            this.readyResolve?.();
          })
          .catch((err) => {
            this.setStatus({ state: "error", message: err?.message || String(err) });
            this.readyReject?.(err);
          });
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "lsp_message" && data.payload) {
            this.handleIncoming(data.payload);
          } else if (data.type === "lsp_error") {
            console.error(`[LSP Client] Server error for ${this.lspKey}:`, data.error);
            this.setStatus({ state: "error", message: data.error || "Unknown server error" });
            this.readyReject?.(new Error(data.error || "LSP server error"));
          } else if (data.type === "lsp_install_start") {
            console.log(`[LSP Client] Auto-install started for ${this.lspKey}: ${data.message}`);
            this.setStatus({ state: "indexing", message: data.message || "Installing language server" });
          } else if (data.type === "lsp_install_progress") {
            console.log(`[LSP Client] Install progress for ${this.lspKey}: ${data.message}`);
            this.setStatus({ state: "indexing", message: data.message || "Installing" });
          } else if (data.type === "lsp_install_result") {
            if (data.error) {
              console.error(`[LSP Client] Install failed for ${this.lspKey}:`, data.error);
              this.setStatus({ state: "error", message: data.error });
              this.readyReject?.(new Error(data.error));
            } else {
              console.log(`[LSP Client] Install complete for ${this.lspKey}: ${data.serverPath}`);
            }
          } else if (data.type === "lsp_closed") {
            console.warn(`[LSP Client] Server process exited (code ${data.code}) for ${this.lspKey}`);
          } else if (data.type === "lsp_stderr") {
            // stderr is forwarded by the sidecar; surface only at debug.
            // console.debug(`[LSP ${this.lspKey} stderr]`, data.payload);
          }
        } catch (e) {
          console.error(`[LSP Client] Error parsing socket message:`, e);
        }
      };

      socket.onerror = () => {
        console.error(`[LSP Client] Socket error for ${this.lspKey}`);
        if (!isOpened) {
          const msg = `Cannot connect to sidecar at ${SIDECAR_WS_URL} — is the agent sidecar running?`;
          this.setStatus({ state: "error", message: msg });
          this.readyReject?.(new Error(msg));
        }
      };

      socket.onclose = () => {
        console.log(`[LSP Client] Closed for ${this.lspKey}`);
        this.socket = null;
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error("Connection closed"));
        }
        this.pendingRequests.clear();
        this.activeModels.clear();
        // If we never reached "ready", reject the connect promise so callers
        // don't hang forever (e.g. sidecar closed after lsp_error).
        if (this.status.state !== "ready" && this.status.state !== "error") {
          this.readyReject?.(new Error("Connection closed before server was ready"));
        }
        this.readyPromise = null;
        this.readyResolve = null;
        this.readyReject = null;
        if (this.status.state !== "error") this.setStatus({ state: "disconnected" });
      };
    });
    return this.readyPromise;
  }

  /** Send `initialize` + `initialized` and capture server capabilities. */
  private async runInitialize(): Promise<void> {
    const rootUri = pathToFileUri(this.workspacePath);
    const rootName = this.workspacePath.split("/").pop() || this.workspacePath;
    const initializationOptions = this.getInitializationOptions(rootUri);

    const result = await this.sendRequest("initialize", {
      processId: null,
      rootPath: this.workspacePath,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: rootName }],
      capabilities: {
        workspace: {
          workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
          configuration: true,
          workspaceFolders: true,
          didChangeConfiguration: true,
          applyEdit: true,
          semanticTokens: { refreshSupport: true },
          inlayHint: { refreshSupport: true },
          codeAction: { refreshSupport: true },
        },
        window: { workDoneProgress: true },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: true,
          },
          completion: {
            dynamicRegistration: false,
            completionItem: {
              snippetSupport: true,
              insertReplaceSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              tagSupport: { valueSet: [1] },
            },
            contextSupport: true,
          },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false, linkSupport: true },
          typeDefinition: { dynamicRegistration: false, linkSupport: true },
          implementation: { dynamicRegistration: false, linkSupport: true },
          declaration: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
          },
          signatureHelp: {
            dynamicRegistration: false,
            signatureInformation: { documentationFormat: ["markdown", "plaintext"] },
          },
          formatting: { dynamicRegistration: false },
          rangeFormatting: { dynamicRegistration: false },
          codeAction: {
            dynamicRegistration: false,
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ["", "quickfix", "refactor", "source"] },
            },
          },
          rename: { dynamicRegistration: false, prepareSupport: true },
          documentHighlight: { dynamicRegistration: false },
          foldingRange: { dynamicRegistration: false },
          inlayHint: { dynamicRegistration: false },
          semanticTokens: {
            dynamicRegistration: false,
            requests: { full: true, range: false },
            formats: ["relative"],
            tokenTypes: [],
            tokenModifiers: [],
          },
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true,
            tagSupport: { valueSet: [1, 2] },
          },
        },
      },
      initializationOptions,
    });

    this.serverCapabilities = result?.capabilities ?? {};
    this.sendNotification("initialized", {});
  }

  private flushQueue() {
    while (this.messageQueue.length > 0) {
      const queued = this.messageQueue.shift();
      this.sendRaw(queued);
    }
  }

  /**
   * Dispatch an inbound JSON-RPC message.
   *
   * JSON-RPC distinguishes three kinds:
   *   - Response:      has `id` + (`result` | `error`), no `method`
   *   - Server request: has `id` + `method` (+ `params`)
   *   - Notification:  has `method`, no `id`
   *
   * The previous code keyed only on `id` presence and treated everything as a
   * response, which silently dropped server requests (or worse, resolved a
   * pending client request with a server-request payload when ids collided).
   */
  private handleIncoming(payload: any) {
    const hasMethod = typeof payload.method === "string";
    const hasId = payload.id !== undefined && payload.id !== null;
    const isResponse = !hasMethod && (payload.result !== undefined || payload.error !== undefined);

    if (isResponse) {
      const pending = this.pendingRequests.get(payload.id);
      if (pending) {
        if (payload.error) pending.reject(payload.error);
        else pending.resolve(payload.result);
        this.pendingRequests.delete(payload.id);
      }
      return;
    }

    if (hasId && hasMethod) {
      this.handleServerRequest(payload.id, payload.method, payload.params).catch((err) => {
        console.error(`[LSP Client] Server request handler threw for ${payload.method}:`, err);
      });
      return;
    }

    if (hasMethod) {
      this.handleNotification(payload.method, payload.params);
      return;
    }

    // Unknown shape — ignore.
  }

  /** Answer a server-initiated request and send the response back. */
  private async handleServerRequest(id: any, method: string, params: any): Promise<void> {
    let result: any = null;

    switch (method) {
      case "workspace/configuration": {
        // Return one entry per requested item. Some servers, notably jdtls,
        // re-read settings after initialization and can accidentally replace
        // their initialized preferences with null-ish values if the client
        // answers null here.
        const items: any[] = Array.isArray(params?.items) ? params.items : [];
        result = items.map((item) => this.getWorkspaceConfiguration(item?.section));
        break;
      }
      case "window/workDoneProgress/create": {
        // Server asks us to create a progress token; future $/progress
        // notifications keyed by this token are surfaced via onProgress.
        result = null;
        break;
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
        result = null;
        break;
      case "workspace/applyEdit": {
        // We don't auto-apply workspace edits from the server (user edits flow
        // through Monaco). Acknowledge honestly so the server can degrade.
        result = { applied: false, failedReason: "automatic edits are not applied by the editor" };
        break;
      }
      case "window/showMessageRequest": {
        // Respond "cancel" (null) — we don't surface server action prompts.
        result = null;
        break;
      }
      case "window/showDocument": {
        // Acknowledge; actual file navigation is handled by the editor's
        // openCodeEditor override on definition jumps.
        result = { success: true };
        break;
      }
      default:
        console.warn(`[LSP Client] Unhandled server request: ${method}`);
        result = null;
    }

    this.sendResponse(id, result);
  }

  private handleNotification(method: string, params: any) {
    switch (method) {
      case "textDocument/publishDiagnostics":
        if (params) {
          try {
            this.onDiagnostics?.({ uri: params.uri, diagnostics: params.diagnostics || [] });
          } catch {
            /* ignore */
          }
        }
        break;
      case "$/progress":
        this.handleProgress(params);
        break;
      case "window/logMessage":
      case "window/showMessage":
        // Surface to console; UI may hook onStatus/onProgress separately.
        if (params?.message) console.log(`[LSP ${this.lspKey}] ${params.message}`);
        break;
      case "telemetry/event":
        break;
      default:
        // Most notifications are server-only; ignore unknown ones.
        break;
    }
  }

  private handleProgress(params: any) {
    if (!params) return;
    const token = params.token;
    const value = params.value;
    if (!value) return;

    let event: LspProgressEvent | null = null;
    if (value.kind === "begin") {
      event = { token, kind: "begin", title: value.title, message: value.message, percentage: value.percentage };
    } else if (value.kind === "report") {
      event = { token, kind: "report", message: value.message, percentage: value.percentage };
    } else if (value.kind === "end") {
      event = { token, kind: "end", message: value.message };
    }
    if (event) {
      try {
        this.onProgress?.(event);
      } catch {
        /* ignore */
      }
      if (value.kind === "begin" || value.kind === "report") {
        const pct = typeof value.percentage === "number" ? value.percentage : undefined;
        this.setStatus({
          state: "indexing",
          message: value.message || value.title,
          percent: pct,
        });
      } else if (value.kind === "end") {
        this.setStatus({ state: "ready" });
      }
    }
  }

  public sendRequest(method: string, params: any, timeoutMs?: number): Promise<any> {
    const id = ++this.requestCounter;
    const msg = { jsonrpc: "2.0", id, method, params };
    const timeout = timeoutMs ?? TIMEOUTS[method] ?? DEFAULT_TIMEOUT;

    return new Promise((resolve, reject) => {
      // Arm the timeout + pending entry only once we can actually send, so the
      // timeout measures "waiting for the server's response" rather than
      // "waiting for the server to boot" (boot/indexing latency is surfaced via
      // ready()/onStatus instead). This also prevents a queued request from
      // sitting in pendingRequests forever with no timer if connect stalls.
      const armAndSend = () => {
        const timer = setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error(`LSP Request ${method} (id: ${id}) timed out after ${timeout}ms`));
          }
        }, timeout);
        this.pendingRequests.set(id, {
          resolve: (res) => {
            clearTimeout(timer);
            resolve(res);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        this.sendRaw(msg);
      };

      if (this.isOpen()) {
        armAndSend();
      } else {
        this.connect()
          .then(() => {
            // Connect succeeded; if the caller already gave up (reject fired
            // elsewhere) pendingRequests won't have this id yet, so just send.
            armAndSend();
          })
          .catch((err) => {
            if (this.pendingRequests.has(id)) {
              this.pendingRequests.delete(id);
            }
            reject(err);
          });
      }
    });
  }

  public sendNotification(method: string, params: any) {
    const msg = { jsonrpc: "2.0", method, params };
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendRaw(msg);
    } else {
      this.messageQueue.push(msg);
      this.connect().catch(() => {});
    }
  }

  /** Send a response to a server-initiated request (echoes its id). */
  private sendResponse(id: any, result: any) {
    const msg = { jsonrpc: "2.0", id, result };
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendRaw(msg);
    }
  }

  private sendRaw(msg: any) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "lsp_message", payload: msg }));
    }
  }

  // ── Document synchronization ──────────────────────────────────────

  public openModel(uri: string, languageId: string, version: number, text: string) {
    if (this.activeModels.has(uri)) return;
    this.activeModels.add(uri);
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  public changeModel(uri: string, version: number, text: string) {
    if (!this.activeModels.has(uri)) return;
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  public closeModel(uri: string) {
    if (!this.activeModels.has(uri)) return;
    this.activeModels.delete(uri);
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  public hasModel(uri: string): boolean {
    return this.activeModels.has(uri);
  }

  // ── Capabilities ──────────────────────────────────────────────────

  /** Map an LSP method to its capability flag in serverCapabilities. */
  private static capabilityFor(method: string): string | null {
    const map: Record<string, string> = {
      "textDocument/completion": "completionProvider",
      "textDocument/hover": "hoverProvider",
      "textDocument/definition": "definitionProvider",
      "textDocument/declaration": "declarationProvider",
      "textDocument/typeDefinition": "typeDefinitionProvider",
      "textDocument/implementation": "implementationProvider",
      "textDocument/references": "referencesProvider",
      "textDocument/documentSymbol": "documentSymbolProvider",
      "textDocument/signatureHelp": "signatureHelpProvider",
      "textDocument/formatting": "documentFormattingProvider",
      "textDocument/rangeFormatting": "documentRangeFormattingProvider",
      "textDocument/codeAction": "codeActionProvider",
      "textDocument/rename": "renameProvider",
      "textDocument/prepareRename": "renameProvider",
      "textDocument/documentHighlight": "documentHighlightProvider",
      "textDocument/foldingRange": "foldingRangeProvider",
      "textDocument/inlayHint": "inlayHintProvider",
      "textDocument/semanticTokens/full": "semanticTokensProvider",
    };
    return map[method] ?? null;
  }

  /** True if the server advertised support for the given LSP method. */
  public supports(method: string): boolean {
    const cap = LspConnection.capabilityFor(method);
    if (!cap) return true; // unknown methods: assume supported, let it fail otherwise
    const v = this.serverCapabilities?.[cap];
    return v === true || (typeof v === "object" && v !== null);
  }

  private getInitializationOptions(rootUri: string): any {
    if (this.lspKey !== "java") return {};

    const settings = this.getJavaSettings();
    return {
      // JDT LS reads this from initializationOptions, not just from the LSP
      // InitializeParams.workspaceFolders field. Supplying both prevents its
      // rootPaths preference from being left null before didOpen.
      workspaceFolders: [rootUri],
      settings,
    };
  }

  private getWorkspaceConfiguration(section?: string): any {
    if (this.lspKey === "java") {
      const settings = this.getJavaSettings();
      if (!section) return settings;
      if (section === "java") return settings.java;
      if (section.startsWith("java.")) {
        return section
          .split(".")
          .slice(1)
          .reduce((value: any, key: string) => value?.[key], settings.java);
      }
    }
    return {};
  }

  private getJavaSettings(): any {
    return {
      java: {
        import: {
          gradle: { enabled: true, wrapper: { enabled: true } },
          maven: { enabled: true },
        },
        configuration: {
          updateBuildConfiguration: "interactive",
        },
        completion: {
          enabled: true,
        },
        referencesCodeLens: {
          enabled: false,
        },
        implementationCodeLens: "none",
        signatureHelp: {
          enabled: true,
        },
        contentProvider: {
          preferred: "fernflower",
        },
      },
    };
  }

  public dispose() {
    if (this.socket) {
      this.socket.close();
    }
  }
}

export { LspConnection };

/**
 * Connection registry + factory. Knows nothing about Monaco models/editors —
 * callers resolve an `LspConnection` by lspKey or filePath and wire callbacks.
 */
export class LspService {
  private static connections = new Map<string, LspConnection>();

  /** Look up an existing live connection for an lspKey (no side effects). */
  public static getConnectionForLspKey(lspKey: string): LspConnection | null {
    const workspacePath = useWorkspaceStore.getState().rootPath;
    if (!workspacePath) return null;
    const key = `${lspKey}:${workspacePath}`;
    const conn = this.connections.get(key);
    return conn ?? null;
  }

  /** Existing live connection for a Monaco language id (used by providers). */
  public static getConnectionForModel(monacoId: string): LspConnection | null {
    const lspKey = getLspKeyFromMonacoId(monacoId);
    if (!lspKey) return null;
    return this.getConnectionForLspKey(lspKey);
  }

  /** Get-or-create + connect a server for the given file's language. */
  public static async ensureConnection(filePath: string): Promise<LspConnection | null> {
    if (!LSP_RUNTIME_ENABLED) return null;
    const store = useWorkspaceStore.getState();
    const lspSettings = store.lspSettings;
    const workspacePath = store.rootPath;
    if (!lspSettings || !lspSettings.enabled || !workspacePath) return null;

    const lspKey = getLspKeyFromPath(filePath);
    if (!lspKey || !LSP_SETTINGS_KEYS.has(lspKey)) return null;

    const serverConf = lspSettings.servers?.[lspKey];
    if (!serverConf || !serverConf.serverPath) return null;

    return this.ensureConnectionForLspKey(lspKey, workspacePath, serverConf.serverPath, serverConf.args || []);
  }

  /** Get-or-create + connect a server for a Monaco language id. */
  public static async ensureConnectionForModel(
    monacoId: string
  ): Promise<LspConnection | null> {
    if (!LSP_RUNTIME_ENABLED) return null;
    const lspKey = getLspKeyFromMonacoId(monacoId);
    if (!lspKey) return null;
    const store = useWorkspaceStore.getState();
    const lspSettings = store.lspSettings;
    const workspacePath = store.rootPath;
    if (!lspSettings || !lspSettings.enabled || !workspacePath) return null;
    const serverConf = lspSettings.servers?.[lspKey];
    if (!serverConf || !serverConf.serverPath) return null;
    return this.ensureConnectionForLspKey(lspKey, workspacePath, serverConf.serverPath, serverConf.args || []);
  }

  private static async ensureConnectionForLspKey(
    lspKey: string,
    workspacePath: string,
    serverPath: string,
    args: string[]
  ): Promise<LspConnection | null> {
    const key = `${lspKey}:${workspacePath}`;
    let conn = this.connections.get(key);
    if (!conn) {
      conn = new LspConnection(lspKey, workspacePath, serverPath, args);
      this.connections.set(key, conn);
    }
    try {
      await conn.connect();
      return conn;
    } catch (err: any) {
      const msg = err?.message || (typeof err === "string" ? err : "Connection failed");
      console.warn(`[LSP Client] Failed to connect to server for ${lspKey}: ${msg}`);
      return null;
    }
  }

  /** Drop a connection (e.g. on workspace switch). */
  public static disposeAll() {
    for (const conn of this.connections.values()) {
      conn.dispose();
    }
    this.connections.clear();
  }
}
