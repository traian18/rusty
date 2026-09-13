import { beforeEach, describe, expect, it } from "vitest";
import { AgentHarnessClient, type AgentTransport, type RunEvent } from "./agentHarnessClient";
import { AGENT_PROTOCOL_VERSION, parseAgentMessage, unwrapEnvelope } from "../../shared/agent-protocol";

/**
 * PR 4c commit 3: proves AgentTransport is a real abstraction (something
 * other than a real WebSocket can drive AgentHarnessClient end to end), not
 * just a rename of the WebSocket type the client used to hardcode. Every
 * test below constructs its client with `createWebSocket: () => fake`, and
 * never touches a real socket.
 */
class FakeTransport implements AgentTransport {
  readyState = 0; // WebSocket.CONNECTING
  sent: unknown[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3; // WebSocket.CLOSED
    this.onclose?.(undefined);
  }

  /** Test helper: simulate the transport finishing its own connect step. */
  simulateOpen(): void {
    this.readyState = 1; // WebSocket.OPEN
    this.onopen?.(undefined);
  }

  /** Test helper: simulate a message arriving from the sidecar. */
  simulateMessage(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

function makeEnvelope(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    conversationId: "conversation-1",
    runId: "run-1",
    messageId: "message-1",
    agentId: "sidecar",
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: "token",
    payload: { content: "hi" },
    ...overrides,
  };
}

describe("AgentHarnessClient over a fake AgentTransport", () => {
  let transport: FakeTransport;
  let client: AgentHarnessClient;

  beforeEach(() => {
    transport = new FakeTransport();
    client = new AgentHarnessClient({ createWebSocket: () => transport });
  });

  it("completes the protocol.hello / protocol.welcome handshake over the fake transport", async () => {
    const connectPromise = client.connect();
    transport.simulateOpen();
    expect(transport.sent).toEqual([
      { type: "protocol.hello", supportedVersions: [AGENT_PROTOCOL_VERSION], capabilities: expect.any(Array) },
    ]);
    transport.simulateMessage({ type: "protocol.welcome", protocolVersion: AGENT_PROTOCOL_VERSION, capabilities: [], connectionId: "conn-1" });
    await connectPromise;
    expect(client.getConnectionState()).toBe("connected");
    expect(client.getConnectionId()).toBe("conn-1");
  });

  it("sends a properly enveloped message for startRun, through nothing but the fake transport", async () => {
    const connectPromise = client.connect();
    transport.simulateOpen();
    transport.simulateMessage({ type: "protocol.welcome", protocolVersion: AGENT_PROTOCOL_VERSION, capabilities: [], connectionId: "conn-1" });
    await connectPromise;

    await client.startRun({ type: "agent_chat", runId: "run-1", conversationId: "conversation-1" });

    const sentEnvelope = transport.sent[1] as Record<string, unknown>;
    expect(sentEnvelope).toMatchObject({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: "agent_chat",
      runId: "run-1",
      conversationId: "conversation-1",
      sequence: 1,
    });
  });

  // PR 4c commit 8: a contract test, not a characterization test -- it feeds
  // the envelope AgentHarnessClient itself actually put on the wire (not a
  // hand-built fixture) through the very same parseAgentMessage/unwrapEnvelope
  // functions the sidecar's server.ts dispatch loop calls on every inbound
  // message, so it fails if the client's construction ever stops producing
  // something the shared parser accepts as "modern".
  it("the envelope AgentHarnessClient actually sends parses as the sidecar would parse it", async () => {
    const connectPromise = client.connect();
    transport.simulateOpen();
    transport.simulateMessage({ type: "protocol.welcome", protocolVersion: AGENT_PROTOCOL_VERSION, capabilities: [], connectionId: "conn-1" });
    await connectPromise;

    await client.startRun({ type: "agent_chat", runId: "run-1", conversationId: "conversation-1" });
    const wireMessage = transport.sent[1];

    const parsed = parseAgentMessage(wireMessage);
    expect(parsed.kind).toBe("modern");
    if (parsed.kind !== "modern") throw new Error("expected a modern envelope");
    expect(parsed.value.runId).toBe("run-1");
    expect(parsed.value.type).toBe("agent_chat");

    const flat = unwrapEnvelope(parsed.value);
    expect(flat).toMatchObject({ type: "agent_chat", runId: "run-1", conversationId: "conversation-1" });
  });

  it("delivers a modern envelope from the fake transport to the run's subscriber", async () => {
    const connectPromise = client.connect();
    transport.simulateOpen();
    transport.simulateMessage({ type: "protocol.welcome", protocolVersion: AGENT_PROTOCOL_VERSION, capabilities: [], connectionId: "conn-1" });
    await connectPromise;

    const received: RunEvent[] = [];
    client.subscribe("run-1", (event) => received.push(event));

    transport.simulateMessage(makeEnvelope());

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "token", runId: "run-1", content: "hi" });
  });

  it("drops a duplicate envelope (same sequence) delivered twice by the fake transport", async () => {
    const connectPromise = client.connect();
    transport.simulateOpen();
    transport.simulateMessage({ type: "protocol.welcome", protocolVersion: AGENT_PROTOCOL_VERSION, capabilities: [], connectionId: "conn-1" });
    await connectPromise;

    const received: RunEvent[] = [];
    client.subscribe("run-1", (event) => received.push(event));

    transport.simulateMessage(makeEnvelope({ sequence: 1 }));
    transport.simulateMessage(makeEnvelope({ sequence: 1, messageId: "message-1-retransmit" }));

    expect(received).toHaveLength(1);
  });

  it("surfaces a sequence-gap diagnostic when the fake transport skips a sequence number", async () => {
    const connectPromise = client.connect();
    transport.simulateOpen();
    transport.simulateMessage({ type: "protocol.welcome", protocolVersion: AGENT_PROTOCOL_VERSION, capabilities: [], connectionId: "conn-1" });
    await connectPromise;

    const diagnostics: RunEvent[] = [];
    client.subscribeAll((event) => {
      if (event.type === "client.sequence_gap") diagnostics.push(event);
    });

    transport.simulateMessage(makeEnvelope({ sequence: 1 }));
    transport.simulateMessage(makeEnvelope({ sequence: 3, messageId: "message-3" }));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ runId: "run-1", expected: 2, received: 3 });
  });
});
