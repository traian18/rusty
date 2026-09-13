// ============================================================
// errors.ts — One error-code shape, replacing the 3 incompatible
// ones that exist in this codebase today:
//
//   1. Protocol-level errors: a nested `error.code` object
//      (ProtocolError, envelope.ts) -- PROTOCOL_INVALID_MESSAGE /
//      PROTOCOL_UNSUPPORTED_VERSION.
//   2. generateTaskNodes.ts's lone top-level `errorCode` string field
//      (EMPTY_MODEL_RESPONSE / INVALID_TASK_JSON) -- the only
//      capability that has one at all.
//   3. RpcErrorCode (agent-sidecar/src/services/websocket.ts) --
//      thrown as an internal JS error class, never reaches the wire.
//
// PR 4a, additive only: this defines the one shape capability error
// events should converge on (`AgentErrorCode` + `AgentError`), it does
// not change what any capability emits today. PR 4b's per-capability
// commits add a `code` field using this shape as each one migrates;
// until then, 8 of 9 capabilities' error events still carry no code
// at all, exactly as documented in events.ts.
// ============================================================

/** Protocol-level codes, unchanged from envelope.ts's ProtocolError. */
export type ProtocolErrorCode = "PROTOCOL_INVALID_MESSAGE" | "PROTOCOL_UNSUPPORTED_VERSION";

/** Reverse-RPC codes, mirroring agent-sidecar/src/services/websocket.ts's RpcErrorCode. */
export type RpcErrorCode =
  | "RPC_TIMEOUT"
  | "RPC_DISCONNECTED"
  | "RPC_WRONG_OWNER"
  | "RPC_DUPLICATE_RESPONSE"
  | "RPC_LATE_RESPONSE"
  | "RPC_INVALID_PAYLOAD"
  | "RPC_SEND_FAILED";

/**
 * Capability-level codes: today only generateTaskNodes.ts's errorCode
 * exists (EMPTY_MODEL_RESPONSE / INVALID_TASK_JSON). Others are added
 * here as PR 4b gives each capability real error codes; a generic
 * fallback covers a capability that hasn't been migrated yet.
 */
export type CapabilityErrorCode =
  | "EMPTY_MODEL_RESPONSE"
  | "INVALID_TASK_JSON"
  | "CAPABILITY_FAILED";

export type AgentErrorCode = ProtocolErrorCode | RpcErrorCode | CapabilityErrorCode;

/** The one error shape every capability's error event should converge on. */
export interface AgentError {
  code: AgentErrorCode;
  message: string;
}
