/**
 * Rusty Agent Sidecar Server
 * 
 * Architectural Overview:
 * 
 *    ┌────────────────────────────────────────────────────────────────────
 *    │                      Rusty Frontend                      │
 *    └─────────────────────────────────┬───────────────────────────┘
 *                                 │ (WebSocket on Port 4000)
 *                                 ▼
 *    ┌────────────────────────────────────────────────────────────────────
 *    │                   Agent Sidecar Server                   │
 *    │                                                          │
 *    │  - WebSocket connection accepts messages                 │
 *    │  - Routes message data.type to injected capability       │
 *    │                                                          │
 *    │       ┌─────────────┬──────────────────────────┬────────────────────────────┐         │
 *    │       │               │                        │         │
 *    │       ▼               ▼                        ▼         │
 *    │  execute_node   global_explore   reconciliate_edge       │
 *    │       │               │                        │         │
 *    │       └─────────────┴──────────────────────────┘         │
 *    │                       ▼                                  │
 *    │              Core Services Layer                         │
 *    │       ┌────────────────────────────────────┐         │
 *    │       │ - websocket (message queue & pairing)  │         │
 *    │       │ - tools (codebase search & VFS tools)  │         │
 *    │       │ - harness (one model/provider contract) │         │
 *    │       └────────────────────────────────────┘         │
 *    └──────────────────────────────────────────────────────────────────────
 * 
 * General Functionality:
 * Initializes Express endpoints and WebSocket Server. Upon connection, it maps 
 * incoming requests to modular capabilities injected into the WebSocket event loop, 
 * communicating with VFS tools and, for every provider, the single resolveHarness()
 * contract in services/harness/ (see /llm/models, /llm/test, /llm/quota below).
 */

import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import {
  AGENT_PROTOCOL_CAPABILITIES,
  negotiateProtocol,
  parseAgentMessage,
  unwrapEnvelope,
} from "../../shared/agent-protocol";

// Services
import { 
  cleanupPendingRequests, 
  enableProtocolConnection,
  resolvePendingResponse,
  safeSend,
  sendProtocolControl,
} from "./services/websocket";

// Capabilities
import { executeNode } from "./capabilities/executeNode";
import { stopPiAgentRun } from "./services/piAgentChat";
import { globalExplore, stopGlobalExploration } from "./capabilities/globalExplore";
import { reconciliateEdge, stopEdgeReconciliation } from "./capabilities/reconciliateEdge";
import { reconciliateGraph, stopGraphReconciliation } from "./capabilities/reconciliateGraph";
import { agentChat, stopAgentChatDelegations } from "./capabilities/agentChat";
import { generateSkill, stopSkillGeneration } from "./capabilities/generateSkill";
import { inlineChat } from "./capabilities/inlineChat";
import { generateTaskNodes, stopTaskNodeGeneration } from "./capabilities/generateTaskNodes";
import { testBuild, stopTestBuild } from "./capabilities/testBuild";
import { stopCommandsForSession } from "./services/commandExecution";
import { clearCommandSession } from "./services/commandPermissions";
import { resolveHarness } from "./services/harness";
import { testMcpConnection } from "./services/mcpClient";
import {
  getCopilotConnectionStatus,
  logoutCopilot,
  shutdownCopilotService,
  startCopilotLogin,
  discoverCopilotModels,
} from "./services/copilotService";
import {
  getCodexConnectionStatus,
  logoutCodex,
  shutdownCodexService,
  startCodexLogin,
  discoverCodexModels,
} from "./services/codexService";
import {
  discoverClaudeCodeModels,
  getClaudeCodeConnectionStatus,
  logoutClaudeCode,
  startClaudeCodeLogin,
} from "./services/claudeCodeService";
import { harnessTelemetry } from "./services/observability";
import { FileEventPersistence, replayRun } from "./services/eventPersistence";

dotenv.config();

// LSP Manager
import { LspManager } from "./services/lspManager";
import { LspInstaller } from "./services/lspInstaller";
import { getPackageSpec, listRegisteredLanguages } from "./services/lspRegistry";

// ── Global Process Crash Prevention & Logging ──────────────────────────
// If stdout/stderr itself is broken (e.g. this process was orphaned when its
// parent closed the pipe), console.error() below throws EPIPE - which is
// itself an uncaught exception, which logs again, which EPIPEs again,
// forever, at full CPU, until disk fills up. Once we see one I/O failure
// from logging, stop trying to log via that channel for the rest of the
// process lifetime instead of retrying indefinitely.
let consoleLoggingBroken = false;
let fileLoggingBroken = false;
const MAX_ERROR_LOG_BYTES = 20 * 1024 * 1024;
const errorLogPath = path.join(process.cwd(), "sidecar_error.log");

function safeLogCrash(label: string, detail: string) {
  if (!consoleLoggingBroken) {
    try {
      console.error(`CRITICAL [${label}]:`, detail);
    } catch {
      consoleLoggingBroken = true;
    }
  }
  if (fileLoggingBroken) return;
  try {
    const existingSize = fs.existsSync(errorLogPath) ? fs.statSync(errorLogPath).size : 0;
    if (existingSize > MAX_ERROR_LOG_BYTES) {
      fileLoggingBroken = true;
      return;
    }
    fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] ${label}: ${detail}\n\n`);
  } catch {
    fileLoggingBroken = true;
  }
}

process.on("uncaughtException", (error) => {
  safeLogCrash("Uncaught Exception", error?.stack || String(error));
});

process.on("unhandledRejection", (reason) => {
  const reasonStr = reason instanceof Error ? reason.stack || reason.message : String(reason);
  safeLogCrash("Unhandled Rejection", reasonStr);
});

const app = express();
const allowedOrigins = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  ...(process.env.RUSTY_WEBVIEW_ORIGIN ? [process.env.RUSTY_WEBVIEW_ORIGIN] : []),
]);
const isAllowedOrigin = (origin: string | undefined) => !origin || allowedOrigins.has(origin);

app.use(cors({
  origin(origin, callback) {
    callback(isAllowedOrigin(origin) ? null : new Error("Origin is not allowed by the Rusty sidecar."), isAllowedOrigin(origin));
  },
}));
app.use(express.json());

// Provider-aware endpoints keep authentication, catalog URLs, headers, and
// response normalization out of the WebView. Every provider's behavior is
// resolved through the same harness contract (services/harness/); this route
// layer never branches on provider.transport or provider.id itself.
app.post("/llm/models", async (req, res) => {
  try {
    const provider = req.body?.provider || {};
    const models = await resolveHarness(provider).discoverModels(provider);
    res.json({ models });
  } catch (err: any) {
    console.error("LLM model discovery error:", err?.message || err);
    res.status(502).json({ error: err?.message || "Failed to fetch provider models." });
  }
});

app.post("/llm/test", async (req, res) => {
  try {
    const provider = req.body?.provider || {};
    const result = await resolveHarness(provider).testConnection(provider);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("LLM connection test error:", err?.message || err);
    res.status(502).json({ error: err?.message || "Provider connection test failed." });
  }
});

app.post("/llm/quota", async (req, res) => {
  try {
    const provider = req.body?.provider || {};
    res.json(await resolveHarness(provider).fetchQuota(provider));
  } catch (err: any) {
    console.error("LLM quota discovery error:", err?.message || err);
    res.status(502).json({ error: err?.message || "Failed to fetch provider quota." });
  }
});

// A real connectivity test for MCP's "Test Connection" button
// (REFACTOR_PLAN.md PR 3c) -- on demand only, never a startup step. Reuses
// mcpClient.ts's own connect/initialize/listTools/dispose sequence, via
// testMcpConnection (deliberately not createMcpTools, which swallows a
// connect failure into a silent zero-tools success).
app.post("/mcp/test", async (req, res) => {
  try {
    const server = req.body?.server || {};
    const result = await testMcpConnection(server);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("MCP connection test error:", err?.message || err);
    res.status(502).json({ error: err?.message || "MCP connection test failed." });
  }
});

app.get("/llm/copilot/status", async (_req, res) => {
  res.json(await getCopilotConnectionStatus());
});

app.post("/llm/copilot/login", async (_req, res) => {
  try {
    res.status(202).json(await startCopilotLogin());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Could not start GitHub authorization." });
  }
});

app.post("/llm/copilot/logout", async (_req, res) => {
  try {
    res.json(await logoutCopilot());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Could not sign out of GitHub Copilot." });
  }
});

app.get("/llm/copilot/models", async (_req, res) => {
  try {
    res.json({ models: await discoverCopilotModels() });
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "Could not load GitHub Copilot models." });
  }
});

app.get("/llm/codex/status", async (_req, res) => {
  res.json(await getCodexConnectionStatus());
});

app.post("/llm/codex/login", async (_req, res) => {
  try {
    res.status(202).json(await startCodexLogin());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Could not start OpenAI authorization." });
  }
});

app.post("/llm/codex/logout", async (_req, res) => {
  try {
    res.json(await logoutCodex());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Could not sign out of OpenAI Codex." });
  }
});

app.get("/llm/codex/models", async (_req, res) => {
  try {
    res.json({ models: await discoverCodexModels() });
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "Could not load OpenAI Codex models." });
  }
});

app.get("/llm/claude-code/status", async (_req, res) => {
  res.json(await getClaudeCodeConnectionStatus());
});

app.post("/llm/claude-code/login", async (_req, res) => {
  try {
    res.status(202).json(await startClaudeCodeLogin());
  } catch (err: any) {
    console.error("Claude Code login error:", err?.stack || err);
    res.status(500).json({ error: err?.message || "Could not start Claude Code authorization." });
  }
});

app.post("/llm/claude-code/logout", async (_req, res) => {
  try {
    res.json(await logoutClaudeCode());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Could not sign out of Claude Code." });
  }
});

app.get("/llm/claude-code/models", async (_req, res) => {
  try {
    res.json({ models: await discoverClaudeCodeModels() });
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "Could not load Claude Code models." });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    ws.close(1008, "Origin is not allowed by the Rusty sidecar.");
    return;
  }
  const parsedUrl = new URL(req.url || "", "http://localhost");

  // LSP admin channel: install / detect language servers on demand.
  // NOTE: must be checked before /lsp because /lsp-admin starts with /lsp.
  if (parsedUrl.pathname.startsWith("/lsp-admin")) {
    console.log("WebSocket [LSP-Admin] Client connected");
    ws.on("message", async (messageStr: string) => {
      let data;
      try {
        data = JSON.parse(messageStr);
      } catch (e) {
        console.error("WebSocket [LSP-Admin] Invalid JSON", e);
        return;
      }

      try {
        if (data.type === "lsp_detect") {
          const { language, serverPath } = data;
          const spec = getPackageSpec(language);
          if (!spec) {
            ws.send(JSON.stringify({ type: "lsp_detect_result", language, detected: false, reason: "No registry entry" }));
            return;
          }
          const result = await LspInstaller.detect(language, serverPath || "");
          ws.send(JSON.stringify({ type: "lsp_detect_result", language, detected: result.detected, serverPath: result.serverPath, reason: result.reason }));
          return;
        }

        if (data.type === "lsp_detect_all") {
          const languages = listRegisteredLanguages();
          const results: any[] = [];
          for (const lang of languages) {
            const r = await LspInstaller.detect(lang, "");
            results.push({ language: lang, detected: r.detected, serverPath: r.serverPath });
          }
          ws.send(JSON.stringify({ type: "lsp_detect_all_result", results }));
          return;
        }

        if (data.type === "lsp_install") {
          const { language } = data;
          const spec = getPackageSpec(language);
          if (!spec) {
            ws.send(JSON.stringify({ type: "lsp_install_result", language, error: `No registry entry for language "${language}"` }));
            return;
          }
          try {
            const result = await LspInstaller.install(language, (event) => {
              ws.send(JSON.stringify({ type: "lsp_install_progress", language: event.language, stage: event.stage, message: event.message }));
            });
            ws.send(JSON.stringify({ type: "lsp_install_result", language: result.language, serverPath: result.serverPath, version: result.version }));
          } catch (err: any) {
            ws.send(JSON.stringify({ type: "lsp_install_result", language, error: err?.message || String(err) }));
          }
          return;
        }

        if (data.type === "lsp_list") {
          ws.send(JSON.stringify({ type: "lsp_list_result", languages: listRegisteredLanguages() }));
          return;
        }

        console.warn(`WebSocket [LSP-Admin] Unknown message type: ${data.type}`);
      } catch (err: any) {
        console.error(`WebSocket [LSP-Admin] Error handling ${data.type}:`, err);
      }
    });
    return;
  }

  // LSP runtime channel: connects a frontend editor to a language server process.
  if (parsedUrl.pathname.startsWith("/lsp")) {
    const language = parsedUrl.searchParams.get("language") || "";
    const workspacePath = parsedUrl.searchParams.get("workspacePath") || "";
    const serverPath = parsedUrl.searchParams.get("serverPath") || "";
    const argsStr = parsedUrl.searchParams.get("args") || "";
    let args: string[] = [];
    if (argsStr) {
      try {
        const parsedArgs = JSON.parse(argsStr);
        args = Array.isArray(parsedArgs) ? parsedArgs.map(String) : [];
      } catch {
        // Backward compatibility for older frontend builds that sent args as
        // a single space-delimited string. New builds send JSON so paths and
        // JVM arguments containing spaces survive the WebSocket URL intact.
        args = argsStr.split(" ").filter(Boolean);
      }
    }

    if (!language || !workspacePath || !serverPath) {
      console.error("WebSocket [LSP] Missing connection parameters:", { language, workspacePath, serverPath });
      ws.send(JSON.stringify({ type: "lsp_error", error: "Missing language, workspacePath or serverPath" }));
      ws.close();
      return;
    }

    console.log(`WebSocket [LSP] Client connected for ${language} in ${workspacePath}`);
    LspManager.getInstance().handleConnection(ws, language, workspacePath, serverPath, args);
    return;
  }

  console.log("WebSocket [Server] Client connected to Pi Sidecar");

  ws.on("error", (error) => {
    console.error("WebSocket [Server] Client connection error:", error);
    try {
      fs.appendFileSync(
        path.join(process.cwd(), "sidecar_error.log"),
        `[${new Date().toISOString()}] WebSocket Connection Error: ${error?.stack || error}\n\n`
      );
    } catch (logErr) {
      console.error("Failed to write to sidecar_error.log:", logErr);
    }
  });

  ws.on("message", async (messageStr: string) => {
    let rawData: unknown;
    try {
      rawData = JSON.parse(messageStr);
    } catch (e) {
      console.error("WebSocket [Server] Invalid JSON received", e);
      sendProtocolControl(ws, {
        type: "protocol.error",
        error: { code: "PROTOCOL_INVALID_MESSAGE", message: "Message is not valid JSON." },
      });
      return;
    }

    const parsedMessage = parseAgentMessage(rawData);
    if (parsedMessage.kind === "invalid") {
      sendProtocolControl(ws, parsedMessage.error);
      return;
    }
    if (parsedMessage.kind === "hello") {
      const selectedVersion = negotiateProtocol(parsedMessage.value);
      if (!selectedVersion) {
        sendProtocolControl(ws, {
          type: "protocol.error",
          error: {
            code: "PROTOCOL_UNSUPPORTED_VERSION",
            message: "Client and sidecar do not share a supported protocol version.",
            supportedVersions: [2],
          },
        });
        ws.close(1002, "Unsupported agent protocol version.");
        return;
      }
      const connectionId = randomUUID();
      sendProtocolControl(ws, {
        type: "protocol.welcome",
        protocolVersion: selectedVersion,
        capabilities: AGENT_PROTOCOL_CAPABILITIES.filter((capability) => parsedMessage.value.capabilities.includes(capability)),
        connectionId,
      });
      enableProtocolConnection(ws, connectionId, selectedVersion);
      return;
    }
    const data: any = parsedMessage.kind === "modern"
      ? unwrapEnvelope(parsedMessage.value)
      : parsedMessage.value;
    if (parsedMessage.kind === "legacy") {
      console.warn(`WebSocket [Protocol] Legacy message received: ${String(data.type || "unknown")}`);
    }

    console.log(`WebSocket [Server] Received message type: ${data.type}`);

    // Pair interactive tool responses with the originating Sidecar request.
    if (data.type === "read_file_response" || data.type === "write_file_response" || data.type === "write_plan_response" || data.type === "agent_question_response" || data.type === "command_permission_response") {
      console.log(`WebSocket [Server] Resolving pending request: ${data.requestId}`, { hasError: !!data.error });
      const resolution = resolvePendingResponse(ws, data);
      if (resolution.status !== "resolved") {
        console.warn(`WebSocket [Server] RPC response ${resolution.status}:`, resolution.error.code, resolution.requestId);
      }
      return;
    }

    // Inject capabilities
    try {
      if (data.type === "run_events_query") {
        if (typeof data.workspaceRoot !== "string" || typeof data.runId !== "string") {
          safeSend(ws, { type: "run_events_error", runId: String(data.runId || "invalid"), requestId: data.requestId, error: "workspaceRoot and runId are required." });
          return;
        }
        const events = await new FileEventPersistence(data.workspaceRoot).query(data.runId, {
          afterSequence: Number.isInteger(data.afterSequence) ? data.afterSequence : undefined,
        });
        safeSend(ws, {
          type: "run_events_result",
          runId: data.runId,
          requestId: data.requestId,
          events,
          state: replayRun(events, true),
        });
      } else if (data.type === "agent_chat_stop") {
        const stopped = await stopPiAgentRun(data.tabId, "Stop requested by user; cancelling all agent tasks.");
        const stoppedDelegations = await stopAgentChatDelegations(data.runId || data.tabId, "Stop requested by user.");
        const stoppedCommands = stopCommandsForSession(data.tabId);
        safeSend(ws, {
          type: "agent_chat_stopped",
          tabId: data.tabId,
          stopped,
          stoppedDelegations,
          stoppedCommands,
        });
      } else if (data.type === "inline_chat_stop") {
        const stopped = await stopPiAgentRun(data.sessionId, "Inline chat stopped by user.");
        safeSend(ws, { type: "inline_chat_stopped", sessionId: data.sessionId, stopped });
      } else if (data.type === "execute_node_stop") {
        // Task nodes run through the same runAgentic(tabId: nodeId, ...) path
        // as agent_chat/inline_chat, so the same activePiRuns registration
        // (piAgentChat.ts) already exists keyed by nodeId -- this is real
        // cancellation, not just closing the socket, mirroring the other two.
        const stopped = await stopPiAgentRun(data.nodeId, "Stop requested by user.");
        safeSend(ws, { type: "execute_node_stopped", nodeId: data.nodeId, stopped });
      } else if (data.type === "execute_node") {
        await executeNode(ws, data);
      } else if (data.type === "global_explore_stop") {
        // Unlike execute_node/agent_chat/inline_chat, global_explore's
        // runToolLoop has no activePiRuns-backed cancellation of its own --
        // shouldAbort only polls a real per-nodeId flag (see globalExplore.ts),
        // which this sets.
        const stopped = stopGlobalExploration(data.nodeId);
        safeSend(ws, { type: "global_explore_stopped", nodeId: data.nodeId, stopped });
      } else if (data.type === "global_explore") {
        await globalExplore(ws, data);
      } else if (data.type === "reconciliate_edge_stop") {
        const stopped = stopEdgeReconciliation(data.edgeId);
        safeSend(ws, { type: "reconciliate_edge_stopped", edgeId: data.edgeId, stopped });
      } else if (data.type === "reconciliate_edge") {
        await reconciliateEdge(ws, data);
      } else if (data.type === "reconciliate_graph_stop") {
        const stopped = stopGraphReconciliation(data.tabId);
        safeSend(ws, { type: "reconciliate_graph_stopped", tabId: data.tabId, stopped });
      } else if (data.type === "reconciliate_graph") {
        await reconciliateGraph(ws, data);
      } else if (data.type === "agent_chat") {
        await agentChat(ws, data);
      } else if (data.type === "inline_chat") {
        await inlineChat(ws, data);
      } else if (data.type === "generate_skill_stop") {
        const stopped = stopSkillGeneration(data.runId);
        safeSend(ws, { type: "generate_skill_stopped", runId: data.runId, stopped });
      } else if (data.type === "generate_skill") {
        await generateSkill(ws, data);
      } else if (data.type === "generate_task_nodes") {
        await generateTaskNodes(ws, data);
      } else if (data.type === "generate_task_nodes_stop") {
        const stopped = stopTaskNodeGeneration(data.requestId);
        safeSend(ws, { type: "generate_task_nodes_stopped", requestId: data.requestId, nodeId: data.nodeId, stopped });
      } else if (data.type === "test_build_stop") {
        const stopped = stopTestBuild(data.tabId);
        safeSend(ws, { type: "test_build_stopped", tabId: data.tabId, stopped });
      } else if (data.type === "test_build") {
        await testBuild(ws, data);
      } else if (data.type === "command_session_close") {
        stopCommandsForSession(data.sessionId);
        clearCommandSession(data.sessionId);
      } else {
        console.warn(`WebSocket [Server] Unknown message type: ${data.type}`);
      }
    } catch (err: any) {
      console.error(`WebSocket [Server] Error executing capability for type: ${data.type}`, err);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`WebSocket [Server] Client disconnected (code: ${code}, reason: "${reason ? reason.toString() : ""}"`);
    cleanupPendingRequests(ws);
    const activeRunIds = (ws as any).__activeAgentRunIds;
    if (activeRunIds instanceof Set) {
      for (const activeRunId of activeRunIds) {
        if (typeof activeRunId !== "string") continue;
        void stopPiAgentRun(activeRunId, "Client disconnected; cancelling all agent tasks.");
        void stopAgentChatDelegations(activeRunId, "Client disconnected.");
        stopCommandsForSession(activeRunId);
      }
    } else {
      const tabId = (ws as any).__activeAgentTabId;
      if (typeof tabId === "string") {
        void stopPiAgentRun(tabId, "Client disconnected; cancelling all agent tasks.");
        stopCommandsForSession(tabId);
      }
    }
  });
});

// Expose health status endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    mode: "sidecar",
    nodeVersion: process.versions.node,
    execPath: process.execPath
  });
});

app.get("/metrics", (_req, res) => {
  res.json(harnessTelemetry.snapshot());
});

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Pi sidecar server listening on 127.0.0.1:${PORT} with Node ${process.versions.node} (${process.execPath})`);
});

const shutdown = () => {
  void Promise.allSettled([shutdownCopilotService(), shutdownCodexService()]).finally(() => server.close());
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
