import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION, AgentEnvelope } from "../../../shared/agent-protocol";
import { FileEventPersistence, replayRun } from "./eventPersistence";

let workspace = "";

test.beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rusty-events-"));
});

test.afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function event(runId: string, type: string, payload: unknown, agentId = "parent"): AgentEnvelope {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    conversationId: "conversation-1",
    runId,
    messageId: randomUUID(),
    agentId,
    sequence: 0,
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
}

test("appends concurrently with monotonic sequence assignment and query filters", async () => {
  const store = new FileEventPersistence(workspace);
  await Promise.all([
    store.append("run-1", event("run-1", "run.started", {})),
    store.append("run-1", event("run-1", "tool.started", {}, "child")),
    store.append("run-1", event("run-1", "run.completed", {})),
  ]);
  const all = await store.query("run-1");
  assert.deepEqual(all.map((item) => item.sequence), [1, 2, 3]);
  assert.equal((await store.query("run-1", { agentId: "child" })).length, 1);
  assert.equal((await store.query("run-1", { type: "run.completed" })).length, 1);
  assert.deepEqual((await store.query("run-1", { afterSequence: 1 })).map((item) => item.sequence), [2, 3]);
});

test("redacts secrets and truncates large strings before persistence", async () => {
  const store = new FileEventPersistence(workspace, { maxPayloadStringLength: 5 });
  await store.append("run-safe", event("run-safe", "tool.completed", { apiKey: "secret", output: "123456789" }));
  const [persisted] = await store.query("run-safe");
  assert.deepEqual(persisted.payload, { apiKey: "[REDACTED]", output: "12345\n[TRUNCATED 4 CHARACTERS]" });
});

test("recovers from a truncated final JSONL line", async () => {
  const store = new FileEventPersistence(workspace);
  await store.append("run-truncated", event("run-truncated", "run.started", {}));
  const runsRoot = path.join(workspace, ".rusty", "runs");
  const [directory] = await fs.readdir(runsRoot);
  await fs.appendFile(path.join(runsRoot, directory, "events.jsonl"), "{\"incomplete\":");
  const recovered = await store.query("run-truncated");
  assert.equal(recovered.length, 1);
});

test("replay reconstructs terminal and interrupted run state", () => {
  const events = [
    { ...event("run-1", "run.started", {}), sequence: 1 },
    { ...event("run-1", "delegation.started", {}), sequence: 2 },
    { ...event("run-1", "run.completed", {}), sequence: 3 },
  ];
  const completed = replayRun(events);
  assert.equal(completed.status, "completed");
  assert.equal(completed.delegations.length, 1);
  assert.equal(replayRun(events.slice(0, 2), true).status, "interrupted");
});

test("deleteRun removes persisted history", async () => {
  const store = new FileEventPersistence(workspace);
  await store.append("run-delete", event("run-delete", "run.started", {}));
  await store.deleteRun("run-delete");
  assert.deepEqual(await store.query("run-delete"), []);
});
