import { describe, it, expect } from "vitest";
import { classifyTerminalEvent } from "../../shared/agent-protocol";

// classifyTerminalEvent is a naming-convention bridge (PR 4a) that lets
// AgentTerminalState be used against today's 9 capabilities' inconsistent
// terminal event names before PR 4b rewrites each one to carry an explicit
// `state` field. These cases are drawn directly from the real event-type
// strings each agent-sidecar/src/capabilities/*.ts file emits today.
describe("classifyTerminalEvent", () => {
  it("classifies every capability's real *_complete event as completed", () => {
    for (const type of [
      "execution_complete",
      "agent_chat_complete",
      "global_explore_complete",
      "reconciliation_complete",
      "reconciliation_file_complete",
      "reconciliation_graph_complete",
      "generate_task_nodes_complete",
      "test_build_complete",
      "inline_chat_complete",
    ]) {
      expect(classifyTerminalEvent(type)).toBe("completed");
    }
  });

  it("classifies generate_skill_response (not named _complete) as completed too", () => {
    expect(classifyTerminalEvent("generate_skill_response")).toBe("completed");
  });

  it("classifies every capability's real *_error event as failed", () => {
    for (const type of [
      "execution_error",
      "agent_chat_error",
      "global_explore_error",
      "reconciliation_error",
      "reconciliation_file_error",
      "reconciliation_graph_error",
      "generate_skill_error",
      "generate_task_nodes_error",
      "test_build_error",
      "inline_chat_error",
    ]) {
      expect(classifyTerminalEvent(type)).toBe("failed");
    }
  });

  it("classifies the stop/stopped events the 3 cancellable capabilities emit today as cancelled", () => {
    expect(classifyTerminalEvent("agent_chat_stopped")).toBe("cancelled");
    expect(classifyTerminalEvent("inline_chat_stopped")).toBe("cancelled");
    expect(classifyTerminalEvent("generate_task_nodes_stopped")).toBe("cancelled");
    expect(classifyTerminalEvent("agent_chat_stop")).toBe("cancelled");
  });

  it("does NOT consult payload contents -- test_build_complete classifies as completed even when success is false", () => {
    // Documents today's real bug (events.ts's TestBuildCompleteEvent comment):
    // a failed build still reports via the _complete event name, and this
    // naming-convention classifier can't see the success:false flag inside
    // it. PR 4b's fix is a new event shape, not a smarter classifier.
    expect(classifyTerminalEvent("test_build_complete")).toBe("completed");
  });

  it("returns undefined for non-terminal events (progress/log/status)", () => {
    for (const type of ["token", "log", "node_status_change", "subagent_update", "generate_task_nodes_log", "test_build_iteration"]) {
      expect(classifyTerminalEvent(type)).toBeUndefined();
    }
  });

  it("returns undefined for a type string the convention can't classify", () => {
    expect(classifyTerminalEvent("protocol.hello")).toBeUndefined();
    expect(classifyTerminalEvent("")).toBeUndefined();
  });
});
