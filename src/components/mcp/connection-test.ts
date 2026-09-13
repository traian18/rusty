// ============================================================
// connection-test.ts — Connection test types, probe functions,
// orchestrator, and the useConnectionTest hook.
//
// REFACTOR_PLAN.md PR 3c: all three transports now run a REAL test
// against the sidecar's POST /mcp/test route (mcpTestService.ts),
// which connects, performs the `initialize` handshake, and lists
// tools via the same mcpClient.ts machinery the app uses at runtime --
// on demand only (this button), never a startup step. Before this,
// stdio was a 450ms simulated sleep that always reported success,
// websocket was a URL-format check that never opened a socket, and
// http/sse used `fetch(..., {mode: "no-cors"})`, whose opaque response
// couldn't distinguish a 200 from a 500.
// ============================================================

import { useState, useCallback } from "react";
import type { UseFormWatch } from "react-hook-form";
import type { McpFormValues } from "./types";
import { isValidUrl, toServerConfig } from "./form-utils";
import { mcpTestService } from "../../services/mcpTestService";

// ───────────────────── Types ─────────────────────────────

/** Result of a single connection probe. */
export type ProbeResult = { status: "success" | "error"; message: string };

/** Subset of form values needed to validate before running a connection
    test -- the real test itself needs the FULL form (toServerConfig
    converts all of it into a real McpServerConfig, including args/env/
    auth, which validation alone doesn't need). */
export type McpFormTestValues = Pick<
  McpFormValues,
  "transportType" | "url" | "command" | "timeout"
>;

/** Visual state of the connection test UI section. */
export type TestState =
  | { status: "idle" }
  | { status: "testing"; message: string }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

// ───────────────────── Validation ────────────────────────

/**
 * Validates inputs before running a connection test.
 * Returns an error message string, or null if inputs are valid.
 */
export function validateTestInputs(values: McpFormTestValues): string | null {
  const { transportType, url, command } = values;

  if (transportType === "stdio") {
    if (!command.trim()) return "Enter a command before testing.";
    return null;
  }

  if (!url.trim() || !isValidUrl(url)) {
    return "Enter a valid URL before testing.";
  }

  return null;
}

// ───────────────────── Orchestrator ──────────────────────

/** Formats a successful test's message from the real tool list. */
function successMessage(result: { toolCount: number; tools: string[] }): string {
  const toolList = result.tools.length > 0 ? `: ${result.tools.join(", ")}` : "";
  return `Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available${toolList}.`;
}

/**
 * Runs a real connection test against the sidecar's POST /mcp/test route
 * (mcpTestService.ts) -- validates first, then converts the FULL form
 * values into a real McpServerConfig (toServerConfig, form-utils.ts) so
 * the test exercises the actual configured transport, args, env, and auth,
 * not a stripped-down subset of it.
 */
export async function runConnectionTest(
  values: McpFormValues,
): Promise<ProbeResult> {
  const validationError = validateTestInputs(values);
  if (validationError) {
    return { status: "error", message: validationError };
  }

  try {
    const result = await mcpTestService.testConnection(toServerConfig(values));
    return { status: "success", message: successMessage(result) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }
}

// ───────────────────── React hook ────────────────────────

/**
 * Hook that manages the connection test state and handler.
 *
 * Reads the current transport type, URL, command, and timeout from
 * the form via `watch`, then delegates to `runConnectionTest`.
 */
export function useConnectionTest(
  watch: UseFormWatch<McpFormValues>,
): { test: TestState; handleTest: () => Promise<void> } {
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const handleTest = useCallback(async () => {
    setTest({ status: "testing", message: "Testing connection..." });
    const result = await runConnectionTest(watch());
    setTest(result);
  }, [watch]);

  return { test, handleTest };
}
