// ============================================================
// commands.ts — What each of the 9 capabilities' start-run
// payload actually contains today.
//
// PR 4a, additive only: this documents the *current* wire shape
// (the field names each agent-sidecar/src/capabilities/*.ts file
// destructures out of its untyped `data: any` today), it does not
// rename anything. The per-capability field that identifies "which
// run is this" is called out explicitly in a comment on each type --
// most of them are NOT named `runId` on the wire yet, even though the
// envelope wrapping every message already carries a real `runId`
// (see envelope.ts's AgentEnvelope). PR 4b renames these to a shared
// vocabulary one capability at a time; until then, AgentCommand is a
// map of reality, not aspiration.
//
// Fields typed `unknown` are payloads owned by the frontend app
// (skills, MCP server configs, LSP settings, provider records, chat
// history) that this shared package intentionally does not import,
// to avoid coupling a Node-and-browser-shared module to app-specific
// store types.
// ============================================================

export interface ExecuteNodeCommand {
  type: "execute_node";
  /** Routing id -- NOT the envelope runId. */
  nodeId: string;
  instructions: string;
  model: string;
  workspaceRoot: string;
  inputFiles?: unknown[];
  customProvider?: unknown;
  globalContext?: unknown;
  contextDescriptions?: unknown;
  chatHistory?: unknown[];
  skill?: unknown;
  mcpContext?: unknown[];
  upstreamTaskContext?: unknown[];
  lspSettings?: unknown;
}

export interface AgentChatCommand {
  type: "agent_chat";
  /** Routing id -- NOT the envelope runId. */
  tabId: string;
  message: string;
  model: string;
  workspaceRoot: string;
  chatHistory?: unknown[];
  customProvider?: unknown;
  skill?: unknown;
  lspSettings?: unknown;
  mcpServers?: unknown[];
  planOnly?: boolean;
  vfsOnly?: boolean;
}

export interface GlobalExploreCommand {
  type: "global_explore";
  /** Routing id -- NOT the envelope runId. */
  nodeId: string;
  prompt: string;
  workspaceRoot: string;
  model: string;
  chatHistory?: unknown[];
  customProvider?: unknown;
  mcpServers?: unknown[];
  planOnly?: boolean;
}

export interface ReconciliateEdgeCommand {
  type: "reconciliate_edge";
  /** Routing id -- NOT the envelope runId. */
  edgeId: string;
  sourceTaskId: string;
  targetTaskId: string;
  modifiedFiles: unknown[];
  userMessage?: string;
  chatHistory?: unknown[];
  workspaceRoot: string;
  model: string;
  sourcePrompt?: string;
  targetPrompt?: string;
  customProvider?: unknown;
}

export interface ReconciliateGraphCommand {
  type: "reconciliate_graph";
  /** Routing id -- NOT the envelope runId. */
  tabId: string;
  model: string;
  nodes: unknown[];
  workspaceRoot: string;
  customProvider?: unknown;
  duplicateFiles?: unknown[];
  fileSources?: unknown;
  chatHistory?: unknown[];
  userMessage?: string;
}

export interface GenerateSkillCommand {
  type: "generate_skill";
  description: string;
  model: string;
  customProvider?: unknown;
}

export interface GenerateTaskNodesCommand {
  type: "generate_task_nodes";
  /** Routing id -- NOT the envelope runId. */
  requestId: string;
  nodeId: string;
  model: string;
  customProvider?: unknown;
}

export interface TestBuildCommand {
  type: "test_build";
  /** Routing id -- NOT the envelope runId. */
  tabId: string;
  buildCommand: string;
  workspaceRoot: string;
  reconciledFiles: unknown[];
  model: string;
  customProvider?: unknown;
}

export interface InlineChatCommand {
  type: "inline_chat";
  /** Routing id -- NOT the envelope runId. */
  sessionId: string;
  message: string;
  model: string;
  workspaceRoot: string;
  customProvider?: unknown;
  history?: unknown[];
  context?: unknown;
}

export type AgentCommand =
  | ExecuteNodeCommand
  | AgentChatCommand
  | GlobalExploreCommand
  | ReconciliateEdgeCommand
  | ReconciliateGraphCommand
  | GenerateSkillCommand
  | GenerateTaskNodesCommand
  | TestBuildCommand
  | InlineChatCommand;
