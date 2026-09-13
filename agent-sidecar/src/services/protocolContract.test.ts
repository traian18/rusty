import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { enableProtocolConnection, safeSend } from "./websocket";
import { AGENT_PROTOCOL_VERSION, parseAgentMessage, unwrapEnvelope } from "../../../shared/agent-protocol";

/**
 * PR 4c commit 8: the counterpart to agentHarnessClient.test.ts's contract
 * test. Both sides import the same parseAgentMessage/unwrapEnvelope today
 * (there is no separate client-side parser to diverge from), so the real
 * value here isn't cross-checking two independent implementations -- it's
 * feeding the sidecar's own real outgoing construction (safeSend ->
 * envelopeForSocket, reached only by actually enabling a protocol
 * connection, not a hand-built fixture envelope) through the exact
 * parse/unwrap path AgentHarnessClient.handleIncoming() calls on every
 * inbound message, including its sequence numbering.
 */
function fakeWs(): { ws: WebSocket; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (payload: string) => sent.push(JSON.parse(payload)),
  } as unknown as WebSocket;
  return { ws, sent };
}

test("a sidecar-enveloped message parses and unwraps exactly as AgentHarnessClient.handleIncoming would", () => {
  const { ws, sent } = fakeWs();
  enableProtocolConnection(ws, "connection-1", AGENT_PROTOCOL_VERSION);

  safeSend(ws, { type: "token", nodeId: "run-1", content: "hello" });
  safeSend(ws, { type: "token", nodeId: "run-1", content: "world" });

  assert.equal(sent.length, 2);

  const first = parseAgentMessage(sent[0]);
  assert.equal(first.kind, "modern");
  if (first.kind !== "modern") return;
  assert.equal(first.value.runId, "run-1");
  assert.equal(first.value.sequence, 1);
  assert.deepEqual(unwrapEnvelope(first.value).content, "hello");

  const second = parseAgentMessage(sent[1]);
  assert.equal(second.kind, "modern");
  if (second.kind !== "modern") return;
  // The client's incomingSequences bookkeeping only accepts a sequence
  // strictly greater than the last one seen for this runId -- 2 following 1
  // is exactly what it needs to not treat this as a duplicate or a gap.
  assert.equal(second.value.sequence, 2);
  assert.deepEqual(unwrapEnvelope(second.value).content, "world");
});

test("a sidecar message with no enabled protocol connection is rejected the same way an un-enveloped message is", () => {
  const { ws, sent } = fakeWs();
  // No enableProtocolConnection call -- envelopeForSocket (internal to
  // websocket.ts) only wraps messages for sockets it recognizes, so this
  // sends the bare, un-enveloped payload, exactly like the pre-protocol
  // "legacy" shape PR 4c commit 1 made parseAgentMessage reject outright.
  safeSend(ws, { type: "token", nodeId: "run-1", content: "hello" });

  assert.equal(sent.length, 1);
  const parsed = parseAgentMessage(sent[0]);
  assert.equal(parsed.kind, "invalid");
  if (parsed.kind !== "invalid") return;
  assert.equal(parsed.error.error.code, "PROTOCOL_INVALID_MESSAGE");
});
