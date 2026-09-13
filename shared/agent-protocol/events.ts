// ============================================================
// events.ts — What each of the 9 capabilities actually sends back
// to the client today: terminal (complete/error/stopped) events,
// documented as a discriminated union.
//
// PR 4a, additive only: same rule as commands.ts -- this describes
// today's real field names and event-type strings verbatim (including
// their inconsistencies: generate_skill's completion event isn't even
// named `_complete`, test_build's `_complete` event can carry
// `success: false`, and only generate_task_nodes has a top-level
// `errorCode`). Nothing here is wired to runtime code yet; PR 4b
// unifies these one capability at a time.
// ============================================================

import type { AgentTerminalState } from "./envelope";

export interface ExecutionCompleteEvent {
  type: "execution_complete";
  nodeId: string;
  result: { status: string; modified: string[]; response: string };
}
export interface ExecutionErrorEvent {
  type: "execution_error";
  nodeId: string;
  error: string;
}

export interface AgentChatCompleteEvent {
  type: "agent_chat_complete";
  tabId: string;
  runId: string;
  conversationId: string;
  response: string;
  modifiedFiles: string[];
}
export interface AgentChatErrorEvent {
  type: "agent_chat_error";
  tabId: string;
  runId: string;
  conversationId: string;
  error: string;
}

export interface GlobalExploreCompleteEvent {
  type: "global_explore_complete";
  nodeId: string;
  response: string;
  summary?: unknown;
}
export interface GlobalExploreErrorEvent {
  type: "global_explore_error";
  nodeId: string;
  error: string;
}

export interface ReconciliationCompleteEvent {
  type: "reconciliation_complete";
  edgeId: string;
  response: string;
}
export interface ReconciliationErrorEvent {
  type: "reconciliation_error";
  edgeId: string;
  error: string;
}

export interface ReconciliationFileCompleteEvent {
  type: "reconciliation_file_complete";
  tabId: string;
  filePath: string;
  taskIds: unknown;
  modified: boolean;
  response: string;
}
export interface ReconciliationFileErrorEvent {
  type: "reconciliation_file_error";
  tabId: string;
  filePath: string;
  taskIds: unknown;
  error: string;
}
export interface ReconciliationGraphCompleteEvent {
  type: "reconciliation_graph_complete";
  tabId: string;
  response: string;
  reviewedFiles: unknown;
  reconciledFiles: string[];
  modifiedFiles: string[];
}
export interface ReconciliationGraphErrorEvent {
  type: "reconciliation_graph_error";
  tabId: string;
  filePath?: string;
  error: string;
}

/** Not named `_complete` -- one of the inconsistencies PR 4b fixes. */
export interface GenerateSkillResponseEvent {
  type: "generate_skill_response";
  spec: unknown;
}
export interface GenerateSkillErrorEvent {
  type: "generate_skill_error";
  error: string;
}

export interface GenerateTaskNodesCompleteEvent {
  type: "generate_task_nodes_complete";
  requestId: string;
  nodeId: string;
  tasks: unknown[];
  contexts: unknown[];
  attempts: number;
}
/** The only capability with a top-level errorCode today. */
export interface GenerateTaskNodesErrorEvent {
  type: "generate_task_nodes_error";
  requestId: string;
  nodeId: string;
  errorCode?: "EMPTY_MODEL_RESPONSE" | "INVALID_TASK_JSON";
  attempts?: number;
  error: string;
}
/**
 * Emitted from two independent call sites (server.ts and
 * generateTaskNodes.ts) with two different field sets today --
 * `{requestId, nodeId, stopped}` vs `{requestId, nodeId, error}`.
 * This union documents both; PR 4b's fix unifies them to one shape.
 */
export type GenerateTaskNodesStoppedEvent =
  | { type: "generate_task_nodes_stopped"; requestId: string; nodeId: string; stopped: boolean }
  | { type: "generate_task_nodes_stopped"; requestId: string; nodeId: string; error: string };

/**
 * Carries `success: boolean` INSIDE the "complete" event, so a failed
 * build still reports as `_complete` today -- one of the
 * inconsistencies PR 4b fixes.
 */
export interface TestBuildCompleteEvent {
  type: "test_build_complete";
  nodeId: string;
  success: boolean;
  attempts: number;
  finalFiles: unknown;
}
export interface TestBuildErrorEvent {
  type: "test_build_error";
  nodeId: string;
  error: string;
}

export interface InlineChatCompleteEvent {
  type: "inline_chat_complete";
  sessionId: string;
  response: string;
}
export interface InlineChatErrorEvent {
  type: "inline_chat_error";
  sessionId: string;
  error: string;
}

export type AgentTerminalEvent =
  | ExecutionCompleteEvent
  | ExecutionErrorEvent
  | AgentChatCompleteEvent
  | AgentChatErrorEvent
  | GlobalExploreCompleteEvent
  | GlobalExploreErrorEvent
  | ReconciliationCompleteEvent
  | ReconciliationErrorEvent
  | ReconciliationFileCompleteEvent
  | ReconciliationFileErrorEvent
  | ReconciliationGraphCompleteEvent
  | ReconciliationGraphErrorEvent
  | GenerateSkillResponseEvent
  | GenerateSkillErrorEvent
  | GenerateTaskNodesCompleteEvent
  | GenerateTaskNodesErrorEvent
  | GenerateTaskNodesStoppedEvent
  | TestBuildCompleteEvent
  | TestBuildErrorEvent
  | InlineChatCompleteEvent
  | InlineChatErrorEvent;

/**
 * Classifies a raw event-type string into an AgentTerminalState by
 * *naming convention*, so replay/persistence code can use the shared
 * state without every capability's event shape being rewritten first.
 *
 * This is deliberately naive: it looks only at the type string, not
 * the payload, so e.g. `test_build_complete` with `success: false`
 * still classifies as "completed" today (the payload's `success` flag
 * is not consulted). PR 4b's per-capability migration replaces the
 * event shape with one carrying an explicit `state` field instead of
 * relying on this classifier at all; until then, this is the bridge
 * that lets `AgentTerminalState` be used against events that haven't
 * been migrated yet.
 *
 * Returns undefined for a non-terminal event (e.g. a token/log/status
 * event), or for a type string this convention can't classify.
 */
export function classifyTerminalEvent(eventType: string): AgentTerminalState | undefined {
  if (eventType.endsWith("_stopped") || eventType.endsWith("_stop")) return "cancelled";
  if (eventType.endsWith("_error")) return "failed";
  if (eventType.endsWith("_complete") || eventType.endsWith("_response")) return "completed";
  return undefined;
}
