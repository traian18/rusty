import type { McpServerConfig } from "../components/mcp/types";
import { request } from "./llmIntegrationService";

export interface McpTestResult {
  toolCount: number;
  tools: string[];
}

/**
 * A real MCP connectivity test (REFACTOR_PLAN.md PR 3c) -- POSTs to the
 * sidecar's /mcp/test route, which connects, performs the `initialize`
 * handshake, lists tools, and reports the real result or the real error.
 * Reuses llmIntegrationService.ts's `request()` directly (its
 * AbortSignal.timeout + TimeoutError handling) rather than duplicating
 * that ~15-line fetch wrapper.
 *
 * The timeout override is the server's OWN configured timeout (already up
 * to 30s per the MCP form) plus a small buffer for the sidecar's own
 * round-trip -- not `request()`'s static per-endpoint map, since a test
 * against a slow stdio spawn or a deliberately generous per-server
 * timeout needs to run at least as long as that server is configured to
 * allow.
 */
const TEST_TIMEOUT_BUFFER_MS = 5_000;

export const mcpTestService = {
  async testConnection(server: McpServerConfig): Promise<McpTestResult> {
    return request<McpTestResult>(
      "/mcp/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server }),
      },
      server.timeout + TEST_TIMEOUT_BUFFER_MS,
    );
  },
};
