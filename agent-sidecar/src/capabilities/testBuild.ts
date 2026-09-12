/**
 * Test Build Capability
 *
 * Temporarily applies reconciled files to disk (managed by the frontend caller),
 * runs the user-specified build command, and if it fails, asks the model to
 * fix the reconciled files in-place before retrying — up to MAX_ATTEMPTS times.
 *
 * Protocol (frontend → sidecar):
 *   test_build   { tabId, buildCommand, workspaceRoot, reconciledFiles, model, customProvider }
 *
 * Protocol (sidecar → frontend):
 *   test_build_log       { streamId, message }
 *   test_build_iteration { streamId, attempt, maxAttempts }
 *   test_build_complete  { streamId, success, attempts, finalFiles }
 *   test_build_error     { streamId, error }
 */

import { WebSocket } from "ws";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { safeSend } from "../services/websocket";
import { executeCommand, stopCommandsForSession } from "../services/commandExecution";
import { callLlmWithToolsPiStreaming } from "../services/llmRuntime";
import type { NormalizedCommand } from "../services/commandPermissions";
import { createUsageReporter } from "../services/usageBroadcast";

const MAX_ATTEMPTS = 5;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const CMD_TIMEOUT_MS = 60_000;
const MAX_BUILD_OUTPUT_CHARS = 12_000;
const MAX_CMD_OUTPUT_CHARS = 8_000;

export function getTestBuildStreamId(tabId: string): string {
  return `__test_build__:${tabId}`;
}

// Same rationale as globalExplore.ts/reconciliateEdge.ts's fixes: the model
// fix-attempt call's shouldAbort only polled the per-run socket's readyState,
// which no longer trips per-run now every capability shares one connection.
// The build subprocess itself, though, already has real cancellation via
// executeCommand's own session tracking (keyed by streamId) --
// stopCommandsForSession kills the actual child process, not just a flag.
const activeTestBuilds = new Set<string>();
const cancelledTestBuilds = new Set<string>();

/** Real cancellation for a test_build run: kills any in-flight build/diagnostic
 *  subprocess and flags the model fix-attempt loop to stop. Returns whether a
 *  run was active. */
export function stopTestBuild(tabId: string): boolean {
  const wasActive = activeTestBuilds.has(tabId);
  cancelledTestBuilds.add(tabId);
  stopCommandsForSession(getTestBuildStreamId(tabId));
  return wasActive;
}

export async function testBuild(ws: WebSocket, data: any): Promise<void> {
  const { tabId, buildCommand, workspaceRoot, reconciledFiles, model, customProvider } = data;
  const streamId = getTestBuildStreamId(tabId);
  activeTestBuilds.add(tabId);
  cancelledTestBuilds.delete(tabId);

  const sendLog = (message: string) => {
    console.log(`[TestBuild] ${message}`);
    safeSend(ws, { type: "test_build_log", nodeId: streamId, message });
  };

  const sendError = (error: string) => {
    safeSend(ws, { type: "test_build_error", nodeId: streamId, error });
  };

  // ── Parse the build command ────────────────────────────────────────────
  const parts = String(buildCommand || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    sendError("No build command provided.");
    activeTestBuilds.delete(tabId);
    return;
  }

  const filePaths: string[] = Array.isArray(reconciledFiles)
    ? reconciledFiles.filter((p: any) => typeof p === "string")
    : [];
  if (!filePaths.length) {
    sendError("No reconciled files to test.");
    activeTestBuilds.delete(tabId);
    return;
  }

  const command: NormalizedCommand = {
    program: parts[0],
    args: parts.slice(1),
    cwd: String(workspaceRoot || "."),
    timeoutMs: BUILD_TIMEOUT_MS,
  };

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (ws.readyState !== WebSocket.OPEN || cancelledTestBuilds.has(tabId)) return;

      sendLog(`--- Build attempt ${attempt}/${MAX_ATTEMPTS} ---`);
      safeSend(ws, { type: "test_build_iteration", nodeId: streamId, attempt, maxAttempts: MAX_ATTEMPTS });

      let buildOutput = "";
      const result = await executeCommand(streamId, command, (_stream, content) => {
        sendLog(content.trimEnd());
        buildOutput += content;
        if (buildOutput.length > MAX_BUILD_OUTPUT_CHARS * 2) {
          buildOutput = buildOutput.slice(-MAX_BUILD_OUTPUT_CHARS);
        }
      });

      // ── Build passed ─────────────────────────────────────────────────
      if (result.exitCode === 0) {
        const finalFiles = await readDiskFiles(filePaths);
        sendLog(`Build passed after ${attempt} attempt${attempt === 1 ? "" : "s"}.`);
        safeSend(ws, { type: "test_build_complete", nodeId: streamId, success: true, attempts: attempt, finalFiles });
        return;
      }

      // ── Build failed ─────────────────────────────────────────────────
      const exitDesc = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "null"}`;
      sendLog(`Build failed (${exitDesc}).`);

      if (attempt === MAX_ATTEMPTS) break;

      sendLog("Calling model to diagnose and fix the build errors...");

      const truncatedOutput = buildOutput.length > MAX_BUILD_OUTPUT_CHARS
        ? `...(truncated)...\n${buildOutput.slice(-MAX_BUILD_OUTPUT_CHARS)}`
        : buildOutput;

      const systemPrompt = `You are a build error fixer. A set of reconciled source files has been applied to disk and the build failed.

Your job: read the relevant files, understand the errors, and write fixed versions.

Workspace: ${workspaceRoot}
Files you may modify (reconciled files only):
${filePaths.map((f) => `- ${f}`).join("\n")}

Rules:
- Only modify files from the list above.
- Write COMPLETE file contents — never partial edits or diffs.
- Do not add comments, documentation, or unrelated changes.
- Fix exactly what the build output indicates is broken, nothing more.
- If you are not sure about a fix, make the minimal safe change.
- You may run read-only diagnostic commands (e.g. tsc --noEmit, ls, cat) to gather more information before fixing.
- Do NOT run destructive commands (rm, git reset, etc.) or install/uninstall packages.`;

      const userMessage = `The build failed with the following output:

\`\`\`
${truncatedOutput}
\`\`\`

Read the affected files and fix the errors so the build passes.`;

      const readFileTool = {
        name: "read_file",
        description: "Read a file from disk.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Absolute or workspace-relative file path" } },
          required: ["path"],
        },
        execute: async ({ path: filePath }: { path: string }) => {
          const resolved = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
          sendLog(`Model reading: ${resolved}`);
          return await fsp.readFile(resolved, "utf-8");
        },
      };

      const runCommandTool = {
        name: "run_command",
        description: "Run a shell command in the workspace for diagnostic purposes (e.g. tsc --noEmit, ls, cat). Do not use for destructive operations or package installation.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to run (passed to sh -c)" },
          },
          required: ["command"],
        },
        execute: async ({ command: cmd }: { command: string }) => {
          sendLog(`Model running: ${cmd}`);
          const cmdParts = ["sh", "-c", cmd];
          const cmdSpec: NormalizedCommand = {
            program: cmdParts[0],
            args: cmdParts.slice(1),
            cwd: workspaceRoot,
            timeoutMs: CMD_TIMEOUT_MS,
          };
          let output = "";
          const cmdResult = await executeCommand(streamId, cmdSpec, (_stream, content) => {
            output += content;
            if (output.length > MAX_CMD_OUTPUT_CHARS * 2) {
              output = output.slice(-MAX_CMD_OUTPUT_CHARS);
            }
          });
          const truncated = output.length > MAX_CMD_OUTPUT_CHARS
            ? `...(truncated)...\n${output.slice(-MAX_CMD_OUTPUT_CHARS)}`
            : output;
          const exitInfo = cmdResult.timedOut ? " (timed out)" : ` (exit ${cmdResult.exitCode ?? "null"})`;
          return truncated + exitInfo;
        },
      };

      const filePathSet = new Set(filePaths);
      const writeFileTool = {
        name: "write_file",
        description: "Write a fixed version of a reconciled file to disk.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or workspace-relative file path" },
            content: { type: "string", description: "The complete fixed file content" },
          },
          required: ["path", "content"],
        },
        execute: async ({ path: filePath, content }: { path: string; content: string }) => {
          const resolved = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
          if (!filePathSet.has(resolved)) {
            throw new Error(`Only reconciled files may be modified. '${resolved}' is not in scope.`);
          }
          sendLog(`Model fixing: ${resolved} (${content.length} chars)`);
          await fsp.writeFile(resolved, content, "utf-8");
          return `Fixed: ${resolved}`;
        },
      };

      await callLlmWithToolsPiStreaming({
        modelReference: model,
        customProvider,
        systemPrompt,
        userMessage,
        tools: [readFileTool, writeFileTool, runCommandTool],
        sendLog,
        sendToken: (token) => safeSend(ws, { type: "test_build_token", nodeId: streamId, content: token }),
        maxRounds: 30,
        cwd: workspaceRoot,
        history: [],
        shouldAbort: () => ws.readyState !== WebSocket.OPEN || cancelledTestBuilds.has(tabId),
        onUsage: createUsageReporter(ws, {
          workspaceRoot,
          surface: "test_build",
          nodeId: streamId,
          tabId,
          model,
          provider: customProvider?.id,
        }),
      });

      sendLog("Model finished. Re-running build...");
    }

    // ── All attempts exhausted ─────────────────────────────────────────
    const finalFiles = await readDiskFiles(filePaths);
    sendLog(`Build did not pass after ${MAX_ATTEMPTS} attempts.`);
    safeSend(ws, { type: "test_build_complete", nodeId: streamId, success: false, attempts: MAX_ATTEMPTS, finalFiles });
  } catch (err: any) {
    console.error("[TestBuild] Unexpected error:", err);
    sendError(err?.message || String(err));
  } finally {
    activeTestBuilds.delete(tabId);
    cancelledTestBuilds.delete(tabId);
  }
}

async function readDiskFiles(paths: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const filePath of paths) {
    try {
      result[filePath] = await fsp.readFile(filePath, "utf-8");
    } catch {
      // File may not exist on disk yet
    }
  }
  return result;
}
