// ============================================================
// envelope.ts — Wire envelope, protocol handshake, and the
// version/capability negotiation for the agent WebSocket protocol.
//
// Moved verbatim from the old shared/agentProtocol.ts (PR 4a) as the
// first step of splitting that one file into shared/agent-protocol/.
//
// See SEMANTICS.md for what each envelope field (conversationId, runId,
// messageId, correlationId, agentId/parentAgentId, sequence) identifies
// and how they relate to one another.
// ============================================================

export const AGENT_PROTOCOL_VERSION = 2 as const;
export const SUPPORTED_AGENT_PROTOCOL_VERSIONS = [AGENT_PROTOCOL_VERSION] as const;

export const AGENT_PROTOCOL_CAPABILITIES = [
  "rpc",
  "run-sequences",
  "delegation-controls",
  "event-replay",
] as const;

export type AgentProtocolCapability = typeof AGENT_PROTOCOL_CAPABILITIES[number];
export type AgentTerminalState = "completed" | "failed" | "cancelled" | "timed_out" | "disconnected";

export interface AgentEnvelope<TPayload = unknown> {
  protocolVersion: number;
  conversationId: string;
  runId: string;
  messageId: string;
  correlationId?: string;
  agentId: string;
  parentAgentId?: string;
  sequence: number;
  timestamp: string;
  type: string;
  payload: TPayload;
}

export interface ProtocolHello {
  type: "protocol.hello";
  supportedVersions: number[];
  capabilities: string[];
}

export interface ProtocolWelcome {
  type: "protocol.welcome";
  protocolVersion: number;
  capabilities: AgentProtocolCapability[];
  connectionId: string;
}

export interface ProtocolError {
  type: "protocol.error";
  error: {
    code: "PROTOCOL_INVALID_MESSAGE" | "PROTOCOL_UNSUPPORTED_VERSION";
    message: string;
    supportedVersions: readonly number[];
  };
}

export type ParsedAgentMessage =
  | { kind: "hello"; value: ProtocolHello }
  | { kind: "modern"; value: AgentEnvelope }
  | { kind: "invalid"; error: ProtocolError };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function protocolError(code: ProtocolError["error"]["code"], message: string): ParsedAgentMessage {
  return {
    kind: "invalid",
    error: {
      type: "protocol.error",
      error: { code, message, supportedVersions: SUPPORTED_AGENT_PROTOCOL_VERSIONS },
    },
  };
}

export function validateEnvelope(value: unknown): AgentEnvelope {
  if (!isRecord(value)) throw new Error("Envelope must be an object.");
  const requiredStrings = ["conversationId", "runId", "messageId", "agentId", "timestamp", "type"] as const;
  if (!Number.isInteger(value.protocolVersion) || Number(value.protocolVersion) <= 0) {
    throw new Error("protocolVersion must be a positive integer.");
  }
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || !String(value[field]).trim()) throw new Error(`${field} must be a non-empty string.`);
  }
  if (!Number.isInteger(value.sequence) || Number(value.sequence) < 0) throw new Error("sequence must be a non-negative integer.");
  if (Number.isNaN(Date.parse(String(value.timestamp)))) throw new Error("timestamp must be an ISO timestamp.");
  if (value.correlationId !== undefined && typeof value.correlationId !== "string") throw new Error("correlationId must be a string.");
  if (value.parentAgentId !== undefined && typeof value.parentAgentId !== "string") throw new Error("parentAgentId must be a string.");
  return value as unknown as AgentEnvelope;
}

export function parseAgentMessage(value: unknown): ParsedAgentMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return protocolError("PROTOCOL_INVALID_MESSAGE", "Message must be an object with a string type.");
  }
  if (value.type === "protocol.hello") {
    if (!Array.isArray(value.supportedVersions) || !value.supportedVersions.every(Number.isInteger)) {
      return protocolError("PROTOCOL_INVALID_MESSAGE", "supportedVersions must be an integer array.");
    }
    if (!Array.isArray(value.capabilities) || !value.capabilities.every((item) => typeof item === "string")) {
      return protocolError("PROTOCOL_INVALID_MESSAGE", "capabilities must be a string array.");
    }
    return { kind: "hello", value: value as unknown as ProtocolHello };
  }
  if ("protocolVersion" in value) {
    try {
      const envelope = validateEnvelope(value);
      if (!SUPPORTED_AGENT_PROTOCOL_VERSIONS.includes(envelope.protocolVersion as typeof AGENT_PROTOCOL_VERSION)) {
        return protocolError("PROTOCOL_UNSUPPORTED_VERSION", `Protocol version ${envelope.protocolVersion} is not supported.`);
      }
      return { kind: "modern", value: envelope };
    } catch (error) {
      return protocolError("PROTOCOL_INVALID_MESSAGE", error instanceof Error ? error.message : String(error));
    }
  }
  return protocolError(
    "PROTOCOL_INVALID_MESSAGE",
    "Message is missing protocolVersion -- un-enveloped (legacy) messages are no longer accepted."
  );
}

export function negotiateProtocol(hello: ProtocolHello): number | undefined {
  return [...hello.supportedVersions]
    .sort((left, right) => right - left)
    .find((version) => SUPPORTED_AGENT_PROTOCOL_VERSIONS.includes(version as typeof AGENT_PROTOCOL_VERSION));
}

export function unwrapEnvelope(envelope: AgentEnvelope): Record<string, unknown> {
  const payload = isRecord(envelope.payload) ? envelope.payload : { value: envelope.payload };
  return {
    type: envelope.type,
    ...payload,
    protocolVersion: envelope.protocolVersion,
    conversationId: envelope.conversationId,
    runId: envelope.runId,
    messageId: envelope.messageId,
    correlationId: envelope.correlationId,
    agentId: envelope.agentId,
    parentAgentId: envelope.parentAgentId,
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
  };
}
