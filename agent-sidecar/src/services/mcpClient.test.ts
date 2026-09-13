import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { testMcpConnection } from "./mcpClient";

/**
 * REFACTOR_PLAN.md PR 3c: testMcpConnection is the real-connectivity
 * counterpart to createMcpTools, deliberately NOT swallowing a connect
 * failure -- these tests pin exactly that contrast.
 */

test("testMcpConnection throws immediately for a disabled server, without attempting any transport", async () => {
  await assert.rejects(
    () => testMcpConnection({ name: "disabled-server", enabled: false, transport: { type: "http", url: "http://127.0.0.1:1" } }),
    /disabled/,
  );
});

test("testMcpConnection resolves with the real tool count against a live JSON-RPC HTTP server", async () => {
  const server = http.createServer((req, res) => {
    // HttpMcpClient's discoverEndpoint() does a GET first (legacy-SSE
    // endpoint discovery) before ever POSTing JSON-RPC -- respond
    // harmlessly so it falls back to POSTing this same URL directly.
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("");
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { capabilities: {} } }));
      } else if (parsed.method === "notifications/initialized") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } else if (parsed.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { tools: [{ name: "read_file" }, { name: "write_file" }] },
        }));
      } else {
        res.writeHead(404).end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const result = await testMcpConnection({
      name: "test-http-server",
      enabled: true,
      transport: { type: "http", url: `http://127.0.0.1:${port}` },
      auth: { type: "none" },
      timeout: 5000,
    });
    assert.equal(result.toolCount, 2);
    assert.deepEqual(result.tools, ["read_file", "write_file"]);
  } finally {
    server.close();
  }
});

test("testMcpConnection propagates the real error instead of swallowing it, unlike createMcpTools", async () => {
  // Nothing is listening on this port -- a genuine connection failure.
  await assert.rejects(
    () => testMcpConnection({
      name: "unreachable-server",
      enabled: true,
      transport: { type: "http", url: "http://127.0.0.1:1" },
      auth: { type: "none" },
      timeout: 2000,
    }),
  );
});
