/** WebSocket transport helpers and socket-owned reverse RPC. */

import { randomUUID } from "node:crypto";
import fs from "fs";
import path from "path";
import { WebSocket } from "ws";
import { AgentEnvelope, AGENT_PROTOCOL_VERSION, isRecord, RpcError, RpcErrorCode } from "../../../shared/agent-protocol";
import { harnessTelemetry } from "./observability";

// RpcErrorCode and RpcError now live in shared/agent-protocol (errors.ts /
// rpc.ts) so both runtimes can share the shape; re-exported here so this
// module's existing importers (e.g. websocket.test.ts) are unaffected.
export type { RpcErrorCode };
export { RpcError };

export interface RpcRequestOptions<TResponse> {
  type: string;
  payload: Record<string, unknown>;
  runId: string;
  timeoutMs?: number;
  validateResponse: (value: unknown) => TResponse;
}

export interface PendingRequest<TResponse = unknown> {
  ws: WebSocket;
  runId: string;
  type: string;
  createdAt: number;
  resolver: (response: unknown) => void;
  rejecter: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export type RpcResolution =
  | { status: "resolved"; requestId: string }
  | { status: "wrong_owner" | "duplicate" | "late" | "invalid"; requestId: string; error: RpcError };

export const pendingRequests = new Map<string, PendingRequest>();

const PENDING_REQUEST_TIMEOUT_MS = 30_000;
const SETTLED_REQUEST_RETENTION_MS = 5 * 60_000;
const settledRequests = new Map<string, { settledAt: number; outcome: "resolved" | "rejected" }>();
const protocolConnections = new WeakMap<WebSocket, {
  connectionId: string;
  version: number;
  sequences: Map<string, number>;
}>();
const BACKPRESSURE_THRESHOLD_BYTES = 512 * 1024;
const BACKPRESSURE_MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const PRIORITY_TYPES = new Set([
  "agent_question",
  "agent_chat_complete",
  "agent_chat_error",
  "inline_chat_complete",
  "inline_chat_error",
  "read_file",
  "write_file",
  "write_plan",
  "command_permission_request",
]);
interface BackpressureState {
  queue: Array<{ payload: Record<string, unknown>; bytes: number; priority: boolean }>;
  bytes: number;
  timer?: NodeJS.Timeout;
}
const backpressureStates = new WeakMap<WebSocket, BackpressureState>();

export function getNextId(): string {
  return randomUUID();
}

function rpcLog(event: string, fields: Record<string, unknown>): void {
  console.log("WebSocket [RPC]", JSON.stringify({ event, ...fields }));
}

function rememberSettlement(requestId: string, outcome: "resolved" | "rejected"): void {
  const now = Date.now();
  settledRequests.set(requestId, { settledAt: now, outcome });
  for (const [id, entry] of settledRequests) {
    if (now - entry.settledAt > SETTLED_REQUEST_RETENTION_MS) settledRequests.delete(id);
  }
}

function describeSendError(ws: WebSocket): string {
  const labels: Record<number, string> = { 0: "CONNECTING", 1: "OPEN", 2: "CLOSING", 3: "CLOSED" };
  return `WebSocket is not open (readyState: ${labels[ws.readyState] || ws.readyState}).`;
}

export function enableProtocolConnection(ws: WebSocket, connectionId: string, version: number): void {
  protocolConnections.set(ws, { connectionId, version, sequences: new Map() });
}

export function sendProtocolControl(ws: WebSocket, payload: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error(describeSendError(ws));
  ws.send(JSON.stringify(payload));
}

function envelopeForSocket(ws: WebSocket, value: Record<string, unknown>): AgentEnvelope | Record<string, unknown> {
  const connection = protocolConnections.get(ws);
  if (!connection || typeof value.type !== "string" || value.type.startsWith("protocol.")) return value;

  const runId = String(value.runId || value.tabId || value.nodeId || value.sessionId || connection.connectionId);
  const conversationId = String(value.conversationId || value.tabId || value.nodeId || runId);
  const currentSequence = connection.sequences.get(runId) || 0;
  const sequence = currentSequence + 1;
  connection.sequences.set(runId, sequence);
  const { type, protocolVersion: _protocolVersion, messageId: _messageId, sequence: _sequence, timestamp: _timestamp, ...payload } = value;
  return {
    protocolVersion: connection.version || AGENT_PROTOCOL_VERSION,
    conversationId,
    runId,
    messageId: randomUUID(),
    correlationId: typeof value.correlationId === "string"
      ? value.correlationId
      : typeof value.requestId === "string" && String(type).endsWith("_response")
        ? value.requestId
        : undefined,
    agentId: typeof value.agentId === "string" ? value.agentId : "harness",
    parentAgentId: typeof value.parentAgentId === "string" ? value.parentAgentId : undefined,
    sequence,
    timestamp: new Date().toISOString(),
    type: String(type),
    payload,
  };
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error(describeSendError(ws));
  const outgoing = isRecord(payload) ? envelopeForSocket(ws, payload) : payload;
  ws.send(JSON.stringify(outgoing));
}

/**
 * Atomically registers and sends a reverse-RPC request. Registration always
 * happens first, so even a synchronous test socket response can be resolved.
 */
export function request<TResponse>(
  ws: WebSocket,
  options: RpcRequestOptions<TResponse>,
): Promise<TResponse> {
  const requestId = getNextId();
  const createdAt = Date.now();
  const timeoutMs = options.timeoutMs ?? PENDING_REQUEST_TIMEOUT_MS;

  return new Promise<TResponse>((resolve, reject) => {
    const rejectAndClean = (error: Error) => {
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      rememberSettlement(requestId, "rejected");
      rpcLog("rejected", {
        requestId,
        type: options.type,
        runId: options.runId,
        elapsedMs: Date.now() - createdAt,
        code: error instanceof RpcError ? error.code : undefined,
      });
      harnessTelemetry.increment(`rpc.${error instanceof RpcError ? error.code.toLowerCase() : "rejected"}`);
      harnessTelemetry.duration(`rpc.${options.type}.duration_ms`, Date.now() - createdAt);
      harnessTelemetry.gauge("rpc.pending", pendingRequests.size);
      reject(error);
    };

    const timer = setTimeout(() => {
      rejectAndClean(new RpcError(
        "RPC_TIMEOUT",
        `Request timed out after ${timeoutMs}ms.`,
        requestId,
      ));
    }, timeoutMs);

    const pending: PendingRequest<TResponse> = {
      ws,
      runId: options.runId,
      type: options.type,
      createdAt,
      timer,
      rejecter: rejectAndClean,
      resolver: (value) => {
        if (!pendingRequests.has(requestId)) return;
        try {
          const validated = options.validateResponse(value);
          clearTimeout(timer);
          pendingRequests.delete(requestId);
          rememberSettlement(requestId, "resolved");
          rpcLog("resolved", {
            requestId,
            type: options.type,
            runId: options.runId,
            elapsedMs: Date.now() - createdAt,
          });
          harnessTelemetry.increment(`rpc.${options.type}.completed`);
          harnessTelemetry.duration(`rpc.${options.type}.duration_ms`, Date.now() - createdAt);
          harnessTelemetry.gauge("rpc.pending", pendingRequests.size);
          resolve(validated);
        } catch (error) {
          rejectAndClean(error instanceof RpcError
            ? error
            : new RpcError("RPC_INVALID_PAYLOAD", "RPC response payload failed validation.", requestId, { cause: error }));
        }
      },
    };

    pendingRequests.set(requestId, pending);
    harnessTelemetry.increment(`rpc.${options.type}.started`);
    harnessTelemetry.gauge("rpc.pending", pendingRequests.size);
    rpcLog("started", { requestId, type: options.type, runId: options.runId, timeoutMs });

    try {
      sendJson(ws, {
        type: options.type,
        requestId,
        runId: options.runId,
        ...options.payload,
      });
    } catch (error) {
      rejectAndClean(new RpcError(
        "RPC_SEND_FAILED",
        `Failed to send RPC request: ${error instanceof Error ? error.message : String(error)}`,
        requestId,
        { cause: error },
      ));
    }
  });
}

/** Resolve a response only when it belongs to the exact originating socket and run. */
export function resolvePendingResponse(ws: WebSocket, response: unknown): RpcResolution {
  if (!response || typeof response !== "object" || typeof (response as any).requestId !== "string") {
    const requestId = response && typeof response === "object" ? String((response as any).requestId || "") : "";
    return {
      status: "invalid",
      requestId,
      error: new RpcError("RPC_INVALID_PAYLOAD", "RPC response is missing a requestId.", requestId),
    };
  }

  const value = response as Record<string, unknown>;
  const requestId = value.requestId as string;
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    const settled = settledRequests.get(requestId);
    const code = settled ? "RPC_DUPLICATE_RESPONSE" : "RPC_LATE_RESPONSE";
    const status = settled ? "duplicate" : "late";
    const error = new RpcError(code, `${status === "duplicate" ? "Duplicate" : "Late or unknown"} RPC response ${requestId}.`, requestId);
    rpcLog(status, { requestId, code });
    harnessTelemetry.increment(`rpc.${status}`);
    return { status, requestId, error };
  }

  if (pending.ws !== ws) {
    const error = new RpcError("RPC_WRONG_OWNER", `RPC response ${requestId} came from a different socket.`, requestId);
    rpcLog("wrong_owner", { requestId, type: pending.type, runId: pending.runId, code: error.code });
    harnessTelemetry.increment("rpc.wrong_owner");
    return { status: "wrong_owner", requestId, error };
  }

  // Legacy clients do not echo runId yet. When present, it must match.
  if (typeof value.runId === "string" && value.runId !== pending.runId) {
    const error = new RpcError("RPC_INVALID_PAYLOAD", `RPC response ${requestId} belongs to a different run.`, requestId);
    pending.rejecter(error);
    return { status: "invalid", requestId, error };
  }

  pending.resolver(response);
  return { status: "resolved", requestId };
}

/** Reject all pending reverse-RPC requests owned by a disconnected socket. */
export function cleanupPendingRequests(ws: WebSocket): void {
  const owned = [...pendingRequests.entries()].filter(([, requestEntry]) => requestEntry.ws === ws);
  for (const [requestId, pending] of owned) {
    pending.rejecter(new RpcError(
      "RPC_DISCONNECTED",
      "WebSocket client disconnected before the response was received.",
      requestId,
    ));
  }
  if (owned.length > 0) rpcLog("socket_cleanup", { count: owned.length });
  harnessTelemetry.gauge("rpc.pending", pendingRequests.size);
  protocolConnections.delete(ws);
  const pressure = backpressureStates.get(ws);
  if (pressure?.timer) clearTimeout(pressure.timer);
  backpressureStates.delete(ws);
}

function scheduleBackpressureFlush(ws: WebSocket, state: BackpressureState): void {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (ws.readyState !== WebSocket.OPEN) {
      state.queue = [];
      state.bytes = 0;
      return;
    }
    while (state.queue.length > 0 && ws.bufferedAmount < BACKPRESSURE_THRESHOLD_BYTES) {
      const next = state.queue.shift()!;
      state.bytes -= next.bytes;
      try {
        sendJson(ws, next.payload);
        harnessTelemetry.increment("transport.delayed_sent");
      } catch {
        harnessTelemetry.increment("transport.send_failed");
        break;
      }
    }
    harnessTelemetry.gauge("transport.queued_bytes", state.bytes);
    if (state.queue.length > 0) scheduleBackpressureFlush(ws, state);
  }, 10);
  state.timer.unref?.();
}

function enqueueWithBackpressure(ws: WebSocket, payload: Record<string, unknown>): boolean {
  const state = backpressureStates.get(ws) || { queue: [], bytes: 0 };
  backpressureStates.set(ws, state);
  const type = String(payload.type || "unknown");
  const priority = PRIORITY_TYPES.has(type) || type.endsWith("_error") || type.endsWith("_complete");

  if (type === "token" || type === "inline_chat_token") {
    const previous = state.queue.at(-1);
    if (previous && previous.payload.type === type
      && previous.payload.runId === payload.runId
      && previous.payload.tabId === payload.tabId
      && typeof previous.payload.content === "string"
      && typeof payload.content === "string"
      && previous.payload.content.length < 32_000) {
      const addedBytes = Buffer.byteLength(payload.content);
      previous.payload.content += payload.content;
      previous.bytes += addedBytes;
      state.bytes += addedBytes;
      harnessTelemetry.increment("transport.token_coalesced");
      scheduleBackpressureFlush(ws, state);
      return true;
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (state.bytes + bytes > BACKPRESSURE_MAX_QUEUE_BYTES) {
    if (!priority) {
      harnessTelemetry.increment("transport.low_priority_dropped");
      return false;
    }
    for (let index = 0; index < state.queue.length && state.bytes + bytes > BACKPRESSURE_MAX_QUEUE_BYTES;) {
      if (!state.queue[index].priority) {
        state.bytes -= state.queue[index].bytes;
        state.queue.splice(index, 1);
        harnessTelemetry.increment("transport.low_priority_dropped");
      } else {
        index++;
      }
    }
  }
  if (state.bytes + bytes > BACKPRESSURE_MAX_QUEUE_BYTES) {
    harnessTelemetry.increment("transport.priority_overflow");
    try {
      sendJson(ws, payload);
      harnessTelemetry.increment("transport.priority_preserved");
      return true;
    } catch {
      harnessTelemetry.increment("transport.send_failed");
      return false;
    }
  }
  state.queue.push({ payload, bytes, priority });
  state.bytes += bytes;
  harnessTelemetry.increment("transport.delayed");
  harnessTelemetry.gauge("transport.queued_bytes", state.bytes);
  scheduleBackpressureFlush(ws, state);
  return true;
}

/** Best-effort event send. Reverse RPC must use request() so failures reject callers. */
export function safeSend(ws: WebSocket, payload: unknown): boolean {
  try {
    if (isRecord(payload)) {
      const pressure = backpressureStates.get(ws);
      if (ws.bufferedAmount >= BACKPRESSURE_THRESHOLD_BYTES || (pressure?.queue.length || 0) > 0) {
        return enqueueWithBackpressure(ws, payload);
      }
    }
    sendJson(ws, payload);
    if (isRecord(payload)) harnessTelemetry.increment(`transport.sent.${String(payload.type || "unknown")}`);
    return true;
  } catch (err: any) {
    console.error("WebSocket [Server] Send failed:", err);
    harnessTelemetry.increment("transport.send_failed");
    try {
      fs.appendFileSync(
        path.join(process.cwd(), "sidecar_error.log"),
        `[${new Date().toISOString()}] WebSocket Send Error: ${err?.stack || err}\n\n`,
      );
    } catch (logErr) {
      console.error("Failed to write to sidecar_error.log:", logErr);
    }
    return false;
  }
}

/** Runtime boundary validator for the legacy flat RPC response shape. */
export function validateRpcResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object response.");
  }
  const response = value as Record<string, unknown>;
  if (typeof response.requestId !== "string") throw new Error("Expected requestId to be a string.");
  if (response.error !== undefined && typeof response.error !== "string") throw new Error("Expected error to be a string.");
  return response;
}

/** Test-only reset for the process-global RPC registry. */
export function resetRpcStateForTests(): void {
  for (const pending of pendingRequests.values()) clearTimeout(pending.timer);
  pendingRequests.clear();
  settledRequests.clear();
}

export function getBackpressureStateForTests(ws: WebSocket): { queuedItems: number; queuedBytes: number } {
  const state = backpressureStates.get(ws);
  return { queuedItems: state?.queue.length || 0, queuedBytes: state?.bytes || 0 };
}
