// ============================================================
// capabilities.ts — Names of the sidecar's 9 agent capabilities.
//
// This is the one place that lists them: commands.ts and events.ts
// key their per-capability types off this union, and the runId
// documentation in envelope.ts refers back to it.
// ============================================================

export const AGENT_CAPABILITIES = [
  "execute_node",
  "agent_chat",
  "global_explore",
  "reconciliate_edge",
  "reconciliate_graph",
  "generate_skill",
  "generate_task_nodes",
  "test_build",
  "inline_chat",
] as const;

export type AgentCapability = typeof AGENT_CAPABILITIES[number];
