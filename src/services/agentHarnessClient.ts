import {
  AGENT_PROTOCOL_CAPABILITIES,
  AGENT_PROTOCOL_VERSION,
  AgentEnvelope,
  isRecord,
  parseAgentMessage,
  unwrapEnvelope,
} from "../../shared/agent-protocol";
import { SIDECAR_WS_URL } from "../config/sidecar";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";
export type RunEvent = Record<string, unknown> & { type: string; runId: string };
export type RunEventListener = (event: RunEvent) => void;
export type Unsubscribe = () => void;

export interface StartRunInput extends Record<string, unknown> {
  type: string;
  conversationId?: string;
  runId?: string;
  agentId?: string;
}

export interface RunHandle {
  conversationId: string;
  runId: string;
  cancel: () => Promise<void>;
  subscribe: (listener: RunEventListener) => Unsubscribe;
}

/**
 * The raw socket surface AgentHarnessClient actually uses -- deliberately
 * narrower than a full connect/send/subscribe/disconnect protocol-level
 * transport (see REFACTOR_PLAN.md PR 4c's notes on this). The client keeps
 * every line of its own handshake, sequencing, and reconnection logic;
 * this interface only lets that logic be driven by something other than a
 * real `WebSocket` (e.g. an in-memory fake in tests). A real `WebSocket`
 * already structurally satisfies this, so the default construction path
 * needs no adapter.
 */
export interface AgentTransport {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `any` (not
  // `unknown`) is required here so a real WebSocket's own more specific
  // handler types (e.g. `(ev: Event) => any`) remain structurally assignable.
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
}

export class AgentHarnessClientError extends Error {
  constructor(public readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AgentHarnessClientError";
    if (options && "cause" in options) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

export interface AgentHarnessClientOptions {
  endpoint?: string;
  createWebSocket?: (url: string) => AgentTransport;
  handshakeTimeoutMs?: number;
  maxReconnectAttempts?: number;
}

export class AgentHarnessClient {
  private socket?: AgentTransport;
  private state: ConnectionState = "disconnected";
  private connectPromise?: Promise<void>;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private intentionallyDisconnected = false;
  private readonly listeners = new Map<string, Set<RunEventListener>>();
  private readonly allListeners = new Set<RunEventListener>();
  private readonly outgoingSequences = new Map<string, number>();
  private readonly incomingSequences = new Map<string, number>();
  private selectedCapabilities: string[] = [];
  private connectionId = "";

  private readonly endpoint: string;
  private readonly createWebSocket: (url: string) => AgentTransport;
  private readonly handshakeTimeoutMs: number;
  private readonly maxReconnectAttempts: number;

  constructor(options: AgentHarnessClientOptions = {}) {
    this.endpoint = options.endpoint || SIDECAR_WS_URL;
    this.createWebSocket = options.createWebSocket || ((url) => new WebSocket(url));
    // A real WebSocket already structurally satisfies AgentTransport (send,
    // close, readyState, on{open,message,error,close}) -- no adapter needed.
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 6;
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  getCapabilities(): readonly string[] {
    return this.selectedCapabilities;
  }

  getConnectionId(): string {
    return this.connectionId;
  }

  connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.state === "connected") return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.intentionallyDisconnected = false;
    this.state = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = this.createWebSocket(this.endpoint);
      this.socket = socket;
      let welcomed = false;
      const timer = setTimeout(() => {
        if (welcomed) return;
        socket.close(1002, "Protocol handshake timed out.");
        reject(new AgentHarnessClientError("HANDSHAKE_TIMEOUT", "Agent sidecar protocol handshake timed out."));
      }, this.handshakeTimeoutMs);

      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: "protocol.hello",
          supportedVersions: [AGENT_PROTOCOL_VERSION],
          capabilities: [...AGENT_PROTOCOL_CAPABILITIES],
        }));
      };
      socket.onmessage = (event) => {
        let value: unknown;
        try {
          value = JSON.parse(String(event.data));
        } catch (error) {
          this.emitDiagnostic("client.invalid_json", { error: String(error) });
          return;
        }
        if (isRecord(value) && value.type === "protocol.welcome") {
          welcomed = true;
          clearTimeout(timer);
          this.state = "connected";
          this.reconnectAttempt = 0;
          this.selectedCapabilities = Array.isArray(value.capabilities)
            ? value.capabilities.filter((item): item is string => typeof item === "string")
            : [];
          this.connectionId = typeof value.connectionId === "string" ? value.connectionId : "";
          this.connectPromise = undefined;
          resolve();
          return;
        }
        if (isRecord(value) && value.type === "protocol.error") {
          const message = isRecord(value.error) && typeof value.error.message === "string"
            ? value.error.message
            : "Agent protocol negotiation failed.";
          clearTimeout(timer);
          reject(new AgentHarnessClientError("PROTOCOL_ERROR", message));
          return;
        }
        this.handleIncoming(value);
      };
      socket.onerror = () => {
        if (!welcomed) {
          clearTimeout(timer);
          this.connectPromise = undefined;
          reject(new AgentHarnessClientError("CONNECTION_FAILED", "Could not connect to the agent sidecar."));
        }
      };
      socket.onclose = () => {
        clearTimeout(timer);
        this.socket = undefined;
        this.connectPromise = undefined;
        this.state = "disconnected";
        if (!welcomed) reject(new AgentHarnessClientError("CONNECTION_CLOSED", "Agent sidecar connection closed during handshake."));
        if (!this.intentionallyDisconnected) this.scheduleReconnect();
      };
    });
    return this.connectPromise;
  }

  disconnect(): void {
    this.intentionallyDisconnected = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(1000, "Client disconnected.");
    this.socket = undefined;
    this.connectPromise = undefined;
    this.state = "disconnected";
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    await this.connect();
    const runId = input.runId || crypto.randomUUID();
    const conversationId = input.conversationId || String(input.tabId || input.nodeId || runId);
    this.sendEnvelope({ ...input, runId, conversationId });
    return {
      conversationId,
      runId,
      cancel: () => this.cancelRun(runId, input),
      subscribe: (listener) => this.subscribe(runId, listener),
    };
  }

  async cancelRun(runId: string, routing: Record<string, unknown> = {}): Promise<void> {
    await this.connect();
    // Every capability's stop message today follows `${type}_stop`
    // (agent_chat -> agent_chat_stop, inline_chat -> inline_chat_stop,
    // generate_task_nodes -> generate_task_nodes_stop, and now
    // execute_node -> execute_node_stop) -- this used to be a hardcoded
    // 3-way switch that silently fell back to "agent_chat_stop" for any
    // other capability, which did not generalize. As PR 4b adds a real stop
    // message for each remaining capability, this needs no further changes.
    const requestType = String(routing.type || "agent_chat");
    const cancelType = `${requestType}_stop`;
    this.sendEnvelope({ ...routing, type: cancelType, runId });
  }

  async respondToQuestion(input: { runId: string; requestId: string; answer: string }): Promise<void> {
    await this.connect();
    this.sendEnvelope({ type: "agent_question_response", ...input });
  }

  async send(input: StartRunInput): Promise<void> {
    await this.connect();
    this.sendEnvelope(input);
  }

  async respondToRpc(requestEvent: RunEvent, payload: Record<string, unknown>): Promise<void> {
    await this.connect();
    const requestId = String(requestEvent.requestId || "");
    if (!requestId) throw new AgentHarnessClientError("INVALID_RPC_REQUEST", "RPC request event is missing requestId.");
    this.sendEnvelope({
      type: `${requestEvent.type}_response`,
      ...payload,
      runId: requestEvent.runId,
      requestId,
      correlationId: requestId,
    });
  }

  async replayRun(workspaceRoot: string, runId: string, afterSequence = 0): Promise<{ events: unknown[]; state: unknown }> {
    await this.connect();
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let timer: number | undefined;
      const unsubscribe = this.subscribe(runId, (event) => {
        if (event.requestId !== requestId) return;
        if (event.type === "run_events_error") {
          if (timer !== undefined) window.clearTimeout(timer);
          unsubscribe();
          reject(new AgentHarnessClientError("EVENT_REPLAY_FAILED", String(event.error || "Run event replay failed.")));
        } else if (event.type === "run_events_result") {
          if (timer !== undefined) window.clearTimeout(timer);
          unsubscribe();
          resolve({ events: Array.isArray(event.events) ? event.events : [], state: event.state });
        }
      });
      timer = window.setTimeout(() => {
        unsubscribe();
        reject(new AgentHarnessClientError("EVENT_REPLAY_TIMEOUT", "Run event replay timed out."));
      }, 10_000);
      this.sendEnvelope({ type: "run_events_query", workspaceRoot, runId, requestId, afterSequence });
    });
  }

  subscribe(runId: string, listener: RunEventListener): Unsubscribe {
    const listeners = this.listeners.get(runId) || new Set<RunEventListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  subscribeAll(listener: RunEventListener): Unsubscribe {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  }

  private sendEnvelope(value: StartRunInput): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.state !== "connected") {
      throw new AgentHarnessClientError("NOT_CONNECTED", "Agent harness client is not connected.");
    }
    const { type, conversationId = String(value.runId), runId = crypto.randomUUID(), agentId = "user", ...payload } = value;
    const sequence = (this.outgoingSequences.get(runId) || 0) + 1;
    this.outgoingSequences.set(runId, sequence);
    const envelope: AgentEnvelope = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      conversationId,
      runId,
      messageId: crypto.randomUUID(),
      correlationId: typeof value.correlationId === "string" ? value.correlationId : undefined,
      agentId,
      sequence,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    this.socket.send(JSON.stringify(envelope));
  }

  private handleIncoming(value: unknown): void {
    const parsed = parseAgentMessage(value);
    if (parsed.kind === "invalid" || parsed.kind === "hello") {
      this.emitDiagnostic("client.invalid_message", { detail: parsed.kind === "invalid" ? parsed.error.error.message : "Unexpected hello." });
      return;
    }
    const flat = unwrapEnvelope(parsed.value);
    if (typeof flat.type !== "string") return;
    const runId = parsed.value.runId;
    const previous = this.incomingSequences.get(runId) || 0;
    if (parsed.value.sequence <= previous) return;
    if (previous > 0 && parsed.value.sequence > previous + 1) {
      this.emitDiagnostic("client.sequence_gap", { runId, expected: previous + 1, received: parsed.value.sequence });
    }
    this.incomingSequences.set(runId, parsed.value.sequence);
    const event = { ...flat, type: flat.type, runId } as RunEvent;
    for (const listener of this.listeners.get(runId) || []) listener(event);
    for (const listener of this.allListeners) listener(event);
  }

  private emitDiagnostic(type: string, payload: Record<string, unknown>): void {
    const event = { type, runId: String(payload.runId || "client"), ...payload } as RunEvent;
    for (const listener of this.allListeners) listener(event);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.emitDiagnostic("client.reconnect_exhausted", { attempts: this.reconnectAttempt });
      return;
    }
    this.reconnectAttempt += 1;
    this.state = "reconnecting";
    const delayMs = Math.min(10_000, 250 * 2 ** (this.reconnectAttempt - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => this.emitDiagnostic("client.reconnect_failed", { error: String(error) }));
    }, delayMs);
  }
}

export const agentHarnessClient = new AgentHarnessClient();
