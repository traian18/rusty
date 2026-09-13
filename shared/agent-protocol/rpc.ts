// ============================================================
// rpc.ts — The reverse-RPC shapes shared between client and sidecar:
// the RpcError class (moved here from agent-sidecar/src/services/
// websocket.ts, which re-exports it unchanged so its existing
// importers are unaffected), and the 5 reverse-RPC request/response
// shapes PR 4's checklist named -- read_file, write_file,
// command-permission, and agent-question -- each previously either
// untyped (read_file/write_file: raw Record<string, unknown> duck-
// typing) or declared locally (CommandPermissionRequest in
// commandPermissionService.ts, AgentQuestion in ChatInput.tsx) rather
// than in one shared home. Both of those files re-export their type
// from here unchanged so existing importers are unaffected.
//
// RpcErrorCode itself lives in errors.ts, alongside the other two
// error-code vocabularies this package is unifying.
// ============================================================

import type { RpcErrorCode } from "./errors";

export class RpcError extends Error {
  constructor(
    public readonly code: RpcErrorCode,
    message: string,
    public readonly requestId: string,
    options?: { cause?: unknown },
  ) {
    // Built without passing `options` to `super()`: the two-argument
    // Error constructor (ErrorOptions.cause) needs an ES2022+ lib, which
    // the frontend's tsconfig doesn't set (this file now compiles under
    // both the sidecar's ES2022 config and the frontend's ES2020 one).
    super(message);
    this.name = "RpcError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

// ------------------------------------------------------------
// read_file / write_file -- the VFS reverse-RPC pair a running agent
// uses to read/write a file through the host app rather than its own
// filesystem access. Requests arrive as run events (see RunEvent in
// agentHarnessClient.ts); responses are sent back via
// AgentHarnessClient.respondToRpc, which itself supplies type/
// requestId/runId/correlationId -- so the response shapes below cover
// only the payload callers hand to respondToRpc.
// ------------------------------------------------------------

export interface ReadFileRpcRequest {
  type: "read_file";
  requestId: string;
  runId: string;
  path: string;
}

export interface WriteFileRpcRequest {
  type: "write_file";
  requestId: string;
  runId: string;
  path: string;
  content: string;
}

export interface ReadFileRpcResponse {
  content?: string;
  error?: string;
}

export interface WriteFileRpcResponse {
  error?: string;
}

export function isReadFileRpcRequest(value: { type: unknown }): value is ReadFileRpcRequest {
  return value.type === "read_file";
}

export function isWriteFileRpcRequest(value: { type: unknown }): value is WriteFileRpcRequest {
  return value.type === "write_file";
}

// ------------------------------------------------------------
// command-permission -- a running agent asking the user to approve a
// shell command before it runs. Moved from
// src/services/commandPermissionService.ts (re-exported unchanged
// from there).
// ------------------------------------------------------------

export type CommandPermissionDecision = "deny" | "allow_once" | "allow_session";
export type CommandRisk = "normal" | "elevated" | "destructive";
export type CommandSessionGrantScope = "executable" | "exact_command";

export interface CommandPermissionRequest {
  requestId: string;
  sessionId: string;
  command: { program: string; args: string[]; cwd: string; timeoutMs: number };
  risk: CommandRisk;
  sessionGrantScope: CommandSessionGrantScope;
  sessionGrantProgram: string;
  description: string;
}

// ------------------------------------------------------------
// agent-question -- a running agent asking the user a multiple-choice
// clarifying question. Moved from src/components/ui/ChatInput.tsx
// (re-exported unchanged from there).
// ------------------------------------------------------------

export interface AgentQuestion {
  requestId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
}
