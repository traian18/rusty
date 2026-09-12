// ============================================================
// index.ts — Public surface of @rusty/agent-protocol.
//
// Re-exports everything the old top-level shared/agentProtocol.ts
// exported (unchanged), so its 4 existing importers keep working
// once they're repointed here. New modules (commands, events,
// errors, rpc, validation) are added incrementally in later PR 4a
// commits and re-exported from here as they land.
// ============================================================

export * from "./envelope";
export * from "./capabilities";
export * from "./commands";
export * from "./events";
export * from "./errors";
export * from "./rpc";
export * from "./validation";
