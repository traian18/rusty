/**
 * MCP (Model Context Protocol) Client
 *
 * Lightweight client for the MCP JSON-RPC protocol. Supports the four transports
 * defined in the integration config:
 *   - http  : Streamable HTTP (POST JSON-RPC; response is JSON or SSE)
 *   - sse   : Legacy SSE (GET stream + POST to endpoint event URL)
 *   - websocket : JSON-RPC over WebSocket frames
 *   - stdio : JSON-RPC over a spawned process stdin/stdout (newline-delimited)
 *
 * Exposes `createMcpTools(server, sendLog)` which connects, performs the
 * `initialize` handshake, lists tools, and returns tool descriptors compatible
 * with the sidecar's LLM tool-calling loop (name / description / inputSchema /
 * execute). Tool names are namespaced as `mcp__<server>__<tool>` to avoid
 * collisions with built-in tools.
 */

import { spawn, ChildProcess } from "child_process";
import { WebSocket } from "ws";

export interface McpServerConfig {
  name: string;
  enabled: boolean;
  transport: {
    type: "sse" | "http" | "stdio" | "websocket";
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
  auth: {
    type: "none" | "apiKey" | "bearer" | "oauth2";
    header?: string;
    value?: string;
    token?: string;
  };
  timeout: number;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
  execute: (args: any) => Promise<string>;
}

export interface McpToolsResult {
  tools: McpTool[];
  dispose: () => void;
}

type SendLog = (message: string) => void;

/** Replace ${ENV_VAR} references with process.env values. */
function resolveEnv(input: string): string {
  if (!input) return "";
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] || "");
}

function buildHeaders(server: any): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(server.headers || {}),
    ...(server.transport?.headers || {})
  };
  const auth = server.auth || { type: "none" };
  if (auth.type === "apiKey" && auth.header) {
    headers[auth.header] = resolveEnv(auth.value || "");
  } else if (auth.type === "bearer") {
    headers["Authorization"] = `Bearer ${resolveEnv(auth.token || "")}`;
  }
  return headers;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

let rpcIdCounter = 1;
function nextId(): number {
  return rpcIdCounter++;
}

/**
 * Parse an SSE-formatted text body into the first JSON-RPC `message` event payload.
 * Streamable HTTP responses may return either a plain JSON body or an SSE stream
 * where the result is delivered as `event: message\ndata: {...}`.
 */
function parseSseOrJson(body: string): JsonRpcResponse | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return null;
    }
  }
  // SSE: split on blank lines, find a `message` event block.
  const blocks = body.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let isMessage = true; // default treat as message if no event line
    let dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        isMessage = line.slice(6).trim() === "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (isMessage && dataLines.length > 0) {
      try {
        return JSON.parse(dataLines.join("\n")) as JsonRpcResponse;
      } catch {
        // ignore malformed block
      }
    }
  }
  return null;
}

abstract class McpClient {
  abstract rpc(method: string, params?: any): Promise<any>;
  abstract notify(method: string, params?: any): Promise<void>;
  abstract close(): void;

  async initialize(): Promise<void> {
    const result = await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rusty-sidecar", version: "1.0.0" },
    });
    // Best-effort capability negotiation.
    await this.notify("notifications/initialized", {}).catch(() => {});
    void result;
  }

  async listTools(): Promise<any[]> {
    const result = await this.rpc("tools/list", {});
    return (result && result.tools) || [];
  }

  async callTool(name: string, args: any): Promise<string> {
    const result = await this.rpc("tools/call", { name, arguments: args || {} });
    const content = result && result.content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) => (typeof c === "string" ? c : c && c.type === "text" ? c.text : JSON.stringify(c)))
        .join("\n");
    }
    return typeof result === "string" ? result : JSON.stringify(result);
  }
}

/** Streamable HTTP / SSE-legacy transport. */
class HttpMcpClient extends McpClient {
  private url: string;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private postEndpoint: string | null = null; // for legacy SSE transport

  constructor(server: any) {
    super();
    this.url = server.transport?.url || server.url || "";
    this.headers = buildHeaders(server);
    this.timeoutMs = server.timeout || 30000;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** For legacy SSE transport: open the GET stream to discover the POST endpoint. */
  private async discoverEndpoint(): Promise<void> {
    if (this.postEndpoint !== null) return;
    try {
      const res = await this.fetchWithTimeout(this.url, { method: "GET", headers: this.headers });
      const text = await res.text();
      const match = text.match(/event:\s*endpoint\s*\ndata:\s*(.+)/i);
      if (match) {
        this.postEndpoint = match[1].trim();
        return;
      }
    } catch {
      // ignore — fall back to posting directly to the configured URL
    }
    this.postEndpoint = this.url;
  }

  async rpc(method: string, params?: any): Promise<any> {
    await this.discoverEndpoint();
    const targetUrl = this.postEndpoint || this.url;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id: nextId(), method, params };
    const res = await this.fetchWithTimeout(targetUrl, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${body || res.statusText}`);
    }
    const bodyText = await res.text();
    const parsed = parseSseOrJson(bodyText);
    if (!parsed) throw new Error("MCP HTTP: unreadable response body");
    if (parsed.error) throw new Error(`MCP error: ${parsed.error.message}`);
    return parsed.result;
  }

  async notify(method: string, params?: any): Promise<void> {
    const targetUrl = this.postEndpoint || this.url;
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    await this.fetchWithTimeout(targetUrl, { method: "POST", headers: this.headers, body }).catch(() => {});
  }

  close(): void {
    // HTTP is stateless; nothing to close.
  }
}

/** stdio transport: spawn a child process and speak JSON-RPC over stdin/stdout. */
class StdioMcpClient extends McpClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buffer = "";

  constructor(private server: any) {
    super();
  }

  private ensureProcess(): void {
    if (this.proc) return;
    const cmd = this.server.transport?.command || this.server.command;
    if (!cmd) throw new Error("stdio MCP server missing command");
    const args = this.server.transport?.args || this.server.args || [];
    const env = { ...process.env };
    const envSource = this.server.transport?.env || this.server.env || {};
    for (const [k, v] of Object.entries(envSource)) {
      env[k] = resolveEnv(v as string);
    }
    this.proc = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stdout?.setEncoding("utf-8");
    this.proc.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(`MCP error: ${msg.error.message}`));
            else resolve(msg.result);
          }
        } catch {
          // ignore non-JSON lines (server logs on stderr)
        }
      }
    });

    this.proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString().trim();
      if (text) console.log(`[MCP stdio:${this.server.name}:stderr] ${text}`);
    });

    this.proc.on("error", (err) => {
      const pending = Array.from(this.pending.values());
      this.pending.clear();
      pending.forEach((p) => p.reject(err));
    });

    this.proc.on("close", (code) => {
      const pending = Array.from(this.pending.values());
      this.pending.clear();
      pending.forEach((p) => p.reject(new Error(`MCP stdio process exited (code ${code})`)));
      this.proc = null;
    });
  }

  async rpc(method: string, params?: any): Promise<any> {
    this.ensureProcess();
    if (!this.proc || !this.proc.stdin) throw new Error("MCP stdio process not writable");
    const id = nextId();
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio rpc timeout: ${method}`));
      }, this.server.timeout || 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc!.stdin!.write(JSON.stringify(req) + "\n");
    });
  }

  async notify(method: string, params?: any): Promise<void> {
    this.ensureProcess();
    if (!this.proc || !this.proc.stdin) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void {
    try { this.proc?.stdin?.end(); } catch { /* ignore */ }
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
  }
}

/** WebSocket transport: JSON-RPC over ws frames. */
class WebSocketMcpClient extends McpClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  constructor(private server: any) {
    super();
  }

  private ensureSocket(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const url = this.server.transport?.url || this.server.url;
      if (!url) { reject(new Error("websocket MCP missing url")); return; }
      const ws = new WebSocket(url, { headers: buildHeaders(this.server) } as any);
      this.ws = ws;
      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as JsonRpcResponse;
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve: r, reject: rj } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) rj(new Error(`MCP error: ${msg.error.message}`));
            else r(msg.result);
          }
        } catch {
          // ignore
        }
      });
      ws.on("error", (err) => {
        const pending = Array.from(this.pending.values());
        this.pending.clear();
        pending.forEach((p) => p.reject(err));
      });
      ws.on("close", () => {
        const pending = Array.from(this.pending.values());
        this.pending.clear();
        pending.forEach((p) => p.reject(new Error("MCP websocket closed")));
        this.ws = null;
      });
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
  }

  async rpc(method: string, params?: any): Promise<any> {
    await this.ensureSocket();
    const id = nextId();
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ws timeout: ${method}`)); }, this.server.timeout || 30000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws!.send(JSON.stringify(req));
    });
  }

  async notify(method: string, params?: any): Promise<void> {
    await this.ensureSocket().catch(() => {});
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  close(): void {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}

function createClient(server: any): McpClient {
  const type = server.transport?.type || server.type;
  if (type === "stdio") return new StdioMcpClient(server);
  if (type === "websocket") return new WebSocketMcpClient(server);
  return new HttpMcpClient(server); // http + sse
}

export interface McpTestResult {
  toolCount: number;
  tools: string[];
}

/**
 * A real connectivity test (REFACTOR_PLAN.md PR 3c) -- connects, performs
 * the `initialize` handshake, lists tools, and disposes. Deliberately
 * separate from `createMcpTools`: that function's own try/catch
 * unconditionally swallows any connect failure into `{tools: [],
 * dispose: noop}` (see below), which is exactly right for a capability
 * that must degrade gracefully rather than crash a run, but exactly wrong
 * for a "Test Connection" button -- the caller needs the real thrown
 * error (connection refused, auth failed, timeout) to show the user, not
 * a silent "zero tools" success. This function does not swallow; on
 * failure it throws and still closes the client in `finally`.
 */
export async function testMcpConnection(server: any): Promise<McpTestResult> {
  if (server.enabled === false) {
    throw new Error(`MCP server "${server.name || "unnamed"}" is disabled.`);
  }
  const client = createClient(server);
  try {
    await client.initialize();
    const rawTools = await client.listTools();
    return { toolCount: rawTools.length, tools: rawTools.map((t: any) => t.name) };
  } finally {
    client.close();
  }
}

/**
 * Connect to an MCP server, perform the initialize handshake, list its tools,
 * and return LLM-compatible tool descriptors. Each tool's `execute` calls the
 * remote `tools/call` method.
 */
export async function createMcpTools(server: any, sendLog: SendLog, serverNameFallback?: string): Promise<McpToolsResult> {
  const noop: SendLog = sendLog || (() => {});
  const serverName = server.name || serverNameFallback || "mcp_server";
  const enabled = server.enabled !== false;
  if (!enabled) {
    noop(`MCP server "${serverName}" is disabled — skipping.`);
    return { tools: [], dispose: () => {} };
  }

  const client = createClient(server);
  const prefix = `mcp__${serverName}__`;

  try {
    const transportType = server.transport?.type || server.type || "http";
    noop(`Connecting to MCP server "${serverName}" (${transportType})...`);
    await client.initialize();
    const rawTools = await client.listTools();
    noop(`MCP "${serverName}" exposed ${rawTools.length} tool(s).`);

    const tools: McpTool[] = rawTools.map((t: any) => ({
      name: `${prefix}${t.name}`,
      description: `[MCP:${serverName}] ${t.description || t.name}`,
      inputSchema: t.inputSchema || { type: "object", properties: {} },
      execute: async (args: any) => {
        try {
          noop(`MCP call: ${serverName}/${t.name}`);
          return await client.callTool(t.name, args);
        } catch (err: any) {
          return `MCP tool "${t.name}" failed: ${err.message}`;
        }
      },
    }));

    return {
      tools,
      dispose: () => client.close(),
    };
  } catch (err: any) {
    noop(`MCP connect failed for "${serverName}": ${err.message}`);
    client.close();
    return { tools: [], dispose: () => {} };
  }
}
