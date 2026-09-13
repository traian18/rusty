import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROTOCOL_VERSION,
  negotiateProtocol,
  parseAgentMessage,
  unwrapEnvelope,
  validateEnvelope,
} from "../../../shared/agent-protocol";

const validEnvelope = {
  protocolVersion: AGENT_PROTOCOL_VERSION,
  conversationId: "conversation-1",
  runId: "run-1",
  messageId: "message-1",
  agentId: "agent-1",
  sequence: 1,
  timestamp: "2026-07-21T10:00:00.000Z",
  type: "token",
  payload: { content: "hello" },
};

test("validates and unwraps a modern envelope", () => {
  assert.deepEqual(validateEnvelope(validEnvelope), validEnvelope);
  assert.deepEqual(unwrapEnvelope(validEnvelope), {
    type: "token",
    content: "hello",
    protocolVersion: 2,
    conversationId: "conversation-1",
    runId: "run-1",
    messageId: "message-1",
    correlationId: undefined,
    agentId: "agent-1",
    parentAgentId: undefined,
    sequence: 1,
    timestamp: "2026-07-21T10:00:00.000Z",
  });
});

test("rejects incomplete modern envelopes at the boundary", () => {
  const parsed = parseAgentMessage({ ...validEnvelope, runId: "" });
  assert.equal(parsed.kind, "invalid");
  if (parsed.kind === "invalid") assert.equal(parsed.error.error.code, "PROTOCOL_INVALID_MESSAGE");
});

test("selects the highest mutually supported version", () => {
  assert.equal(negotiateProtocol({ type: "protocol.hello", supportedVersions: [1, 2], capabilities: [] }), 2);
  assert.equal(negotiateProtocol({ type: "protocol.hello", supportedVersions: [1], capabilities: [] }), undefined);
});

test("rejects un-enveloped (legacy) messages -- nothing in this codebase produces them anymore", () => {
  const parsed = parseAgentMessage({ type: "agent_chat", tabId: "tab-1" });
  assert.equal(parsed.kind, "invalid");
  if (parsed.kind === "invalid") assert.equal(parsed.error.error.code, "PROTOCOL_INVALID_MESSAGE");
});

test("returns a structured error for unsupported envelope versions", () => {
  const parsed = parseAgentMessage({ ...validEnvelope, protocolVersion: 99 });
  assert.equal(parsed.kind, "invalid");
  if (parsed.kind === "invalid") assert.equal(parsed.error.error.code, "PROTOCOL_UNSUPPORTED_VERSION");
});
