import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { agentChat } from "./agentChat";
import { executeNode } from "./executeNode";
import { generateSkill } from "./generateSkill";
import { generateTaskNodes } from "./generateTaskNodes";
import { globalExplore } from "./globalExplore";
import { inlineChat } from "./inlineChat";
import { reconciliateEdge } from "./reconciliateEdge";
import { reconciliateGraph } from "./reconciliateGraph";
import { testBuild } from "./testBuild";

/**
 * PR 4c commit 6: every capability handler validates its required fields at
 * the top (using shared/agent-protocol/validation.ts's helpers) before doing
 * any real work -- these were the untyped `data: any` boundary the checklist
 * flagged as having zero validation. One test per handler pins the reject
 * path: an incomplete payload gets a structured `*_error` reply and nothing
 * else (no harness call, no state registered), rather than proceeding on
 * `undefined` fields.
 */
function fakeWs(): { ws: WebSocket; sent: any[] } {
  const sent: any[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: (payload: string) => sent.push(JSON.parse(payload)),
  } as unknown as WebSocket;
  return { ws, sent };
}

test("executeNode rejects a payload missing nodeId/instructions/model/workspaceRoot", async () => {
  const { ws, sent } = fakeWs();
  await executeNode(ws, { instructions: "do it" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "execution_error");
});

test("globalExplore rejects a payload missing prompt/workspaceRoot", async () => {
  const { ws, sent } = fakeWs();
  await globalExplore(ws, { nodeId: "node-1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "global_explore_error");
});

test("reconciliateEdge rejects a payload missing sourceTaskId/targetTaskId/workspaceRoot", async () => {
  const { ws, sent } = fakeWs();
  await reconciliateEdge(ws, { edgeId: "edge-1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "reconciliation_error");
});

test("reconciliateGraph rejects a payload missing workspaceRoot", async () => {
  const { ws, sent } = fakeWs();
  await reconciliateGraph(ws, { tabId: "tab-1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "reconciliation_graph_error");
});

test("agentChat rejects a payload missing message/workspaceRoot", async () => {
  const { ws, sent } = fakeWs();
  await agentChat(ws, { tabId: "tab-1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "agent_chat_error");
});

test("inlineChat rejects a payload missing context.filePath", async () => {
  const { ws, sent } = fakeWs();
  await inlineChat(ws, { sessionId: "s-1", message: "hi", model: "m", workspaceRoot: "/tmp", context: {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "inline_chat_error");
});

test("generateSkill rejects a payload missing description", async () => {
  const { ws, sent } = fakeWs();
  await generateSkill(ws, { runId: "run-1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "generate_skill_error");
});

test("generateTaskNodes rejects a payload missing requestId", async () => {
  const { ws, sent } = fakeWs();
  await generateTaskNodes(ws, { nodeId: "node-1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "generate_task_nodes_error");
});

test("testBuild rejects a payload missing workspaceRoot", async () => {
  const { ws, sent } = fakeWs();
  await testBuild(ws, { tabId: "tab-1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "test_build_error");
});
