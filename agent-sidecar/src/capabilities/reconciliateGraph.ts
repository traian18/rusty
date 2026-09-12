import path from "path";
import { WebSocket } from "ws";
import { resolveHarness } from "../services/harness";
import { request, safeSend, validateRpcResponse } from "../services/websocket";
import { createUsageReporter } from "../services/usageBroadcast";

// Same rationale as globalExplore.ts/reconciliateEdge.ts: this capability's
// per-file runToolLoop call has no activePiRuns-backed cancellation of its
// own, and shouldAbort's old "has the per-run socket closed" check no longer
// trips once every capability shares one agentHarnessClient connection.
const activeGraphReconciliations = new Set<string>();
const cancelledGraphReconciliations = new Set<string>();

/** Real cancellation for a reconciliate_graph run: returns whether one was active. */
export function stopGraphReconciliation(tabId: string): boolean {
  const wasActive = activeGraphReconciliations.has(tabId);
  cancelledGraphReconciliations.add(tabId);
  return wasActive;
}

interface ReconciliationNode {
  id: string;
  name?: string;
  prompt?: string;
  chatHistory?: unknown[];
  modifiedFiles?: string[];
  originalFileContents?: Record<string, string>;
  generatedFileContents?: Record<string, string>;
}

interface OverlappingFileContext {
  path: string;
  currentVfsContent: string;
  tasks: Array<{
    id: string;
    name: string;
    instructions: string;
    chatHistory: unknown[];
    originalContent?: string;
    generatedContent?: string;
  }>;
}

interface NormalizedWorkspaceFile {
  /** Active-workspace destination used for reconciliation ownership and Apply. */
  workspacePath: string;
  /** Exact existing VFS key used to read the task's current in-memory content. */
  vfsPath: string;
}

const MAX_TASK_INSTRUCTION_CHARS = 4_000;
const MAX_TASK_CHAT_MESSAGES = 4;
const MAX_TASK_CHAT_CHARS = 4_000;
const MAX_RECONCILIATION_CHAT_MESSAGES = 4;
const MAX_RECONCILIATION_CHAT_CHARS = 4_000;

function truncateContextText(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[...older context truncated...]`;
}

function compactChatHistory(history: unknown[], maxMessages: number, maxChars: number): string[] {
  const messages = history.slice(-maxMessages).map((entry) => {
    if (entry && typeof entry === "object") {
      const role = "role" in entry ? String((entry as any).role || "message") : "message";
      const content = "content" in entry ? (entry as any).content : entry;
      return `${role}: ${truncateContextText(content, maxChars)}`;
    }
    return truncateContextText(entry, maxChars);
  });

  const compacted: string[] = [];
  let remaining = maxChars;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index];
    const kept = message.slice(Math.max(0, message.length - remaining));
    compacted.unshift(kept);
    remaining -= kept.length;
  }
  return compacted;
}

/** Build a context payload for exactly one overlapping file. */
function compactFileContext(file: OverlappingFileContext): Record<string, unknown> {
  const includedVersions = new Map<string, string>();
  return {
    path: file.path,
    currentVfsContent: file.currentVfsContent,
    tasks: file.tasks.map((task) => {
      let generatedVersion: Record<string, unknown>;
      if (task.generatedContent === undefined) {
        generatedVersion = { available: false };
      } else if (task.generatedContent === file.currentVfsContent) {
        generatedVersion = { available: true, sameAsCurrentVfs: true };
      } else if (includedVersions.has(task.generatedContent)) {
        generatedVersion = {
          available: true,
          sameAsTask: includedVersions.get(task.generatedContent),
        };
      } else {
        includedVersions.set(task.generatedContent, task.id);
        generatedVersion = { available: true, content: task.generatedContent };
      }

      return {
        id: task.id,
        name: task.name,
        instructions: truncateContextText(task.instructions, MAX_TASK_INSTRUCTION_CHARS),
        recentChat: compactChatHistory(task.chatHistory, MAX_TASK_CHAT_MESSAGES, MAX_TASK_CHAT_CHARS),
        generatedVersion,
      };
    }),
  };
}

/**
 * Accept an active-workspace path or a stale absolute VFS key from the same
 * project directory. Saved canvases can retain the latter after a home/workspace
 * parent directory changes, so preserve it for the VFS read while rebasing the
 * destination to the currently open workspace.
 */
function normalizeWorkspaceFile(workspaceRoot: string, filePath: string): NormalizedWorkspaceFile {
  if (!workspaceRoot?.trim()) throw new Error("No workspace root is available for reconciliation.");
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("A file path is required.");

  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return { workspacePath: resolved, vfsPath: resolved };
  }

  if (path.isAbsolute(filePath)) {
    const workspaceDirectory = path.basename(root);
    const pathRoot = path.parse(resolved).root;
    const components = path.relative(pathRoot, resolved).split(path.sep).filter(Boolean);
    const workspaceIndex = components.lastIndexOf(workspaceDirectory);
    if (workspaceIndex >= 0 && workspaceIndex < components.length - 1) {
      const rebasedPath = path.resolve(root, ...components.slice(workspaceIndex + 1));
      const rebasedRelative = path.relative(root, rebasedPath);
      if (rebasedRelative && !rebasedRelative.startsWith("..") && !path.isAbsolute(rebasedRelative)) {
        return { workspacePath: rebasedPath, vfsPath: resolved };
      }
    }
  }

  throw new Error(`Reconciliation file must be inside the workspace: ${filePath}`);
}

function resolveWorkspaceFile(workspaceRoot: string, filePath: string): string {
  return normalizeWorkspaceFile(workspaceRoot, filePath).workspacePath;
}

function normalizeFileSources(
  workspaceRoot: string,
  fileSources: Record<string, string> | undefined,
): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [workspacePath, vfsPath] of Object.entries(fileSources || {})) {
    const destination = normalizeWorkspaceFile(workspaceRoot, workspacePath).workspacePath;
    const source = normalizeWorkspaceFile(workspaceRoot, vfsPath);
    if (source.workspacePath !== destination) {
      throw new Error(`VFS source does not match its active workspace file: ${vfsPath}`);
    }
    normalized.set(destination, source.vfsPath);
  }
  return normalized;
}

function normalizeDuplicateEntries(
  workspaceRoot: string,
  duplicateFiles: Record<string, string[]>,
): Array<[string, string[]]> {
  const groups = new Map<string, Set<string>>();
  for (const [filePath, taskIds] of Object.entries(duplicateFiles || {})) {
    const workspacePath = resolveWorkspaceFile(workspaceRoot, filePath);
    const owners = groups.get(workspacePath) || new Set<string>();
    for (const taskId of taskIds || []) owners.add(taskId);
    groups.set(workspacePath, owners);
  }
  return Array.from(groups, ([filePath, owners]) => [filePath, Array.from(owners)]);
}

function contentAtPath(
  contents: Record<string, string> | undefined,
  workspaceRoot: string,
  resolvedPath: string,
): string | undefined {
  for (const [filePath, content] of Object.entries(contents || {})) {
    try {
      if (resolveWorkspaceFile(workspaceRoot, filePath) === resolvedPath) return content;
    } catch {
      // Ignore stale or invalid snapshot keys; they cannot describe this overlap.
    }
  }
  return undefined;
}

/** Build the exact model input from the live VFS and each colliding task's saved version. */
export async function buildOverlappingFileContext(options: {
  workspaceRoot: string;
  duplicateFiles: Record<string, string[]>;
  nodes: ReconciliationNode[];
  fileSources?: Record<string, string>;
  readVfsFile: (absolutePath: string) => Promise<string>;
}): Promise<OverlappingFileContext[]> {
  const nodesById = new Map(options.nodes.map((node) => [node.id, node]));
  const sources = normalizeFileSources(options.workspaceRoot, options.fileSources);
  const duplicateEntries = normalizeDuplicateEntries(options.workspaceRoot, options.duplicateFiles);

  return Promise.all(duplicateEntries.map(async ([filePath, taskIds]) => {
    const resolvedPath = resolveWorkspaceFile(options.workspaceRoot, filePath);
    const currentVfsContent = await options.readVfsFile(sources.get(resolvedPath) || resolvedPath);
    const tasks = taskIds.map((taskId) => {
      const node = nodesById.get(taskId);
      return {
        id: taskId,
        name: node?.name || "Unnamed Task",
        instructions: node?.prompt || "",
        chatHistory: Array.isArray(node?.chatHistory) ? node.chatHistory : [],
        originalContent: contentAtPath(node?.originalFileContents, options.workspaceRoot, resolvedPath),
        generatedContent: contentAtPath(node?.generatedFileContents, options.workspaceRoot, resolvedPath),
      };
    });

    return { path: resolvedPath, currentVfsContent, tasks };
  }));
}

export async function reconciliateGraph(ws: WebSocket, data: any): Promise<void> {
  const { tabId, model, nodes, workspaceRoot, customProvider, duplicateFiles, fileSources, chatHistory, userMessage } = data;
  console.log(`WebSocket [Server] reconciliate_graph starting for tab: ${tabId}, userMessage: ${userMessage || "none"}`);

  const reconciliationStreamId = `__reconciliation__:${tabId}`;
  const finalizedFiles = new Set<string>();
  const modelModifiedFiles = new Set<string>();
  let activeFilePath: string | undefined;
  const sendLog = (message: string) => {
    console.log(`[ReconciliateGraph] ${message}`);
    safeSend(ws, { type: "log", nodeId: reconciliationStreamId, message });
  };
  activeGraphReconciliations.add(tabId);
  cancelledGraphReconciliations.delete(tabId);

  try {
    const formattedNodes: ReconciliationNode[] = Array.isArray(nodes) ? nodes : [];
    const normalizedSources = normalizeFileSources(workspaceRoot, fileSources);
    const duplicateEntries = normalizeDuplicateEntries(workspaceRoot, duplicateFiles || {});
    const allTaskFilePaths = new Map<string, string>();
    for (const node of formattedNodes) {
      for (const filePath of node.modifiedFiles || []) {
        const normalized = normalizeWorkspaceFile(workspaceRoot, filePath);
        const source = normalizedSources.get(normalized.workspacePath) || normalized.vfsPath;
        const existingSource = allTaskFilePaths.get(normalized.workspacePath);
        if (!existingSource || source === normalized.workspacePath) {
          allTaskFilePaths.set(normalized.workspacePath, source);
        }
      }
    }
    for (const [filePath] of duplicateEntries) {
      const normalized = normalizeWorkspaceFile(workspaceRoot, filePath);
      if (!allTaskFilePaths.has(normalized.workspacePath)) {
        allTaskFilePaths.set(
          normalized.workspacePath,
          normalizedSources.get(normalized.workspacePath) || normalized.vfsPath,
        );
      }
    }
    if (allTaskFilePaths.size === 0) {
      throw new Error("No task-owned VFS files are available to reconcile.");
    }

    const requestVfsFile = async (resolvedPath: string): Promise<string> => {
      const res = await request(ws, {
        type: "read_file",
        runId: reconciliationStreamId,
        payload: { path: resolvedPath },
        validateResponse: validateRpcResponse,
      });
      if (res.error) throw new Error(String(res.error));
      return String(res.content ?? "");
    };

    const persistReconciledFile = async (resolvedPath: string, content: string): Promise<string> => {
      const res = await request(ws, {
        type: "write_file",
        runId: reconciliationStreamId,
        payload: { path: resolvedPath, content },
        validateResponse: validateRpcResponse,
      });
      if (res.error) throw new Error(String(res.error));
      finalizedFiles.add(resolvedPath);
      allTaskFilePaths.set(resolvedPath, resolvedPath);
      return `File successfully finalized under the reconciliation owner in the canvas VFS: ${resolvedPath}`;
    };

    const toolsForFile = (targetPath: string) => {
      const readVfsTool = {
        name: "read_file",
        description: "Re-read the current canvas VFS version of this one overlapping file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "The exact supplied overlapping file path" },
          },
          required: ["path"],
        },
        execute: async ({ path: filePath }: { path: string }) => {
          const resolvedPath = resolveWorkspaceFile(workspaceRoot, filePath);
          if (resolvedPath !== targetPath) {
            throw new Error(`This reconciliation case can only read ${targetPath}`);
          }
          sendLog(`AI re-reading VFS file: ${filePath}`);
          return requestVfsFile(allTaskFilePaths.get(targetPath) || targetPath);
        },
      };

      const writeVfsTool = {
        name: "write_file",
        description: "Replace this one overlapping file in the canvas VFS with its complete reconciled content.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "The exact supplied overlapping file path" },
            content: { type: "string", description: "Complete replacement file content" },
          },
          required: ["path", "content"],
        },
        execute: async ({ path: filePath, content }: { path: string; content: string }) => {
          const resolvedPath = resolveWorkspaceFile(workspaceRoot, filePath);
          if (resolvedPath !== targetPath) {
            throw new Error(`This reconciliation case can only change ${targetPath}`);
          }

          const currentContent = await requestVfsFile(allTaskFilePaths.get(targetPath) || targetPath);
          if (currentContent === content) {
            sendLog(`AI reviewed VFS file without changing it: ${filePath}`);
            return `No write was needed because ${targetPath} already has that content.`;
          }

          sendLog(`AI modifying VFS file: ${filePath}`);
          modelModifiedFiles.add(targetPath);
          return persistReconciledFile(targetPath, content);
        },
      };

      return [readVfsTool, writeVfsTool];
    };

    const systemPrompt = `You are a code reconciliation model inside a spatial development canvas called Rusty.

WHAT HAPPENED:
The user broke a larger plan into small, bounded task nodes. Each node executed independently with its own specific instructions and produced its own version of certain files. The file you are about to receive was touched by multiple task nodes — meaning each of them had a legitimate requirement for that file and produced their own implementation of it.

YOUR JOB — SYNTHESIS, NOT ARBITRATION:
You are not picking a winner. You are not fixing a merge conflict. You are producing a single version of the file that simultaneously satisfies the requirements of every task node that touched it. Think of it as: "what would this file look like if one developer had read all the task instructions and implemented all of them together?"

HOW TO APPROACH IT:
1. Read each task's instructions carefully. Understand what that task needed this file to do.
2. Read each task's generated version. Understand how it chose to implement its requirement.
3. The current VFS content is the last task's version — it may satisfy some requirements but not others.
4. Produce a final version that implements everything all tasks required. Do not omit any task's contribution unless it directly contradicts another (in which case, apply the one that best fits the overall intent).
5. If the current VFS version already satisfies all task requirements with no gaps, do not rewrite it — just confirm it.

RULES:
- You may only read and write the single file supplied to you. No other files.
- Write the complete file — never a partial edit, snippet, or diff.
- Write to the exact supplied path only.
- Do not run builds, tests, or shell commands. All writes go to the VFS via 'write_file'.
- Finish with a concise summary: what each task required, what changed, and why.

Workspace root: ${workspaceRoot || "unknown"}
`;

    (ws as any).__activeAgentTabId = reconciliationStreamId;
    let response: string;
    const reviewedFiles: string[] = [];
    if (duplicateEntries.length > 0) {
      const modelReference = model || customProvider?.models?.find((item: any) => item.supported !== false)?.id || "";
      if (!modelReference) throw new Error("No model is selected. Configure one in LLM Setup.");
      const usageReporter = createUsageReporter(ws, {
        workspaceRoot,
        surface: "graph_reconciliation",
        nodeId: reconciliationStreamId,
        tabId,
        model: modelReference,
        provider: customProvider?.id,
      });
      sendLog(`Reviewing ${duplicateEntries.length} overlapping file${duplicateEntries.length === 1 ? "" : "s"} one at a time with ${modelReference}.`);
      const priorChat = Array.isArray(chatHistory)
        ? (userMessage ? chatHistory.slice(0, -1) : chatHistory)
        : [];
      const recentReconciliationChat = compactChatHistory(
        priorChat,
        MAX_RECONCILIATION_CHAT_MESSAGES,
        MAX_RECONCILIATION_CHAT_CHARS,
      );
      const reports: string[] = [];

      for (let index = 0; index < duplicateEntries.length; index += 1) {
        const [filePath, taskIds] = duplicateEntries[index];
        activeFilePath = filePath;
        sendLog(`Case ${index + 1}/${duplicateEntries.length}: loading only ${filePath}.`);
        const [fileContext] = await buildOverlappingFileContext({
          workspaceRoot,
          duplicateFiles: { [filePath]: taskIds },
          nodes: formattedNodes,
          fileSources,
          readVfsFile: requestVfsFile,
        });
        reviewedFiles.push(fileContext.path);
        const taskCount = fileContext.tasks.length;
        const taskNames = fileContext.tasks.map((t) => t.name).join(", ");
        const defaultMessage = `This file was modified by ${taskCount} task node${taskCount === 1 ? "" : "s"} (${taskNames}). Each task had its own bounded instructions and produced its own version. Produce a single version of this file that satisfies all ${taskCount === 1 ? "its" : "their"} requirements simultaneously.`;
        const promptText = `${userMessage?.trim() || defaultMessage}

${recentReconciliationChat.length > 0 ? `Recent reconciliation conversation (bounded):\n${recentReconciliationChat.join("\n\n")}\n\n` : ""}File modified by multiple task nodes — full context below:
${JSON.stringify(compactFileContext(fileContext), null, 2)}`;

        try {
          const fileReport = await resolveHarness(customProvider).runToolLoop({
            modelReference,
            customProvider,
            systemPrompt,
            userMessage: promptText,
            tools: toolsForFile(fileContext.path),
            sendLog,
            sendToken: () => {},
            maxRounds: 12,
            // A complete write is terminal for this single-file case. Avoid a
            // second provider request that would duplicate the full file in
            // the tool-call transcript and consume the context window again.
            returnAfterToolNames: ["write_file"],
            cwd: workspaceRoot,
            // Each file is an independent case. Relevant history is already
            // bounded in the prompt so provider adapters cannot re-expand it.
            history: [],
            shouldAbort: () => ws.readyState !== WebSocket.OPEN || cancelledGraphReconciliations.has(tabId),
            onUsage: usageReporter,
          });
          reports.push(`${fileContext.path}\n${truncateContextText(fileReport, 4_000)}`);
          if (!finalizedFiles.has(fileContext.path)) {
            const finalContent = await requestVfsFile(allTaskFilePaths.get(fileContext.path) || fileContext.path);
            sendLog(`Finalizing reviewed collision file: ${fileContext.path}`);
            await persistReconciledFile(fileContext.path, finalContent);
          }
          safeSend(ws, {
            type: "reconciliation_file_complete",
            tabId,
            filePath: fileContext.path,
            taskIds,
            modified: modelModifiedFiles.has(fileContext.path),
            response: truncateContextText(fileReport, 4_000),
          });
          activeFilePath = undefined;
        } catch (error: any) {
          safeSend(ws, {
            type: "reconciliation_file_error",
            tabId,
            filePath: fileContext.path,
            taskIds,
            error: error.message || String(error),
          });
          throw new Error(`Failed while reconciling ${fileContext.path}: ${error.message || String(error)}`);
        }
      }
      response = truncateContextText(reports.join("\n\n---\n\n"), 24_000);
    } else {
      response = "No unreconciled overlapping task files were supplied. Ordinary changed files remain TaskNode-owned for Apply Rusty.";
      sendLog("No pending overlap cases require model review.");
    }

    const reconciledFiles = Array.from(finalizedFiles);
    const modifiedFiles = Array.from(modelModifiedFiles);
    sendLog(modifiedFiles.length > 0
      ? `Reconciliation changed ${modifiedFiles.length} collision file${modifiedFiles.length === 1 ? "" : "s"} and recorded ${reconciledFiles.length} completed case${reconciledFiles.length === 1 ? "" : "s"}.`
      : `Reconciliation recorded ${reconciledFiles.length} completed collision case${reconciledFiles.length === 1 ? "" : "s"}; no model edits were required.`);

    safeSend(ws, {
      type: "reconciliation_graph_complete",
      tabId,
      response: String(response || "Reconciliation complete."),
      reviewedFiles,
      reconciledFiles,
      modifiedFiles,
    });
  } catch (err: any) {
    console.error("WebSocket [Server] reconciliate_graph error:", err);
    safeSend(ws, {
      type: "reconciliation_graph_error",
      tabId,
      filePath: activeFilePath,
      error: err.message,
    });
  } finally {
    activeGraphReconciliations.delete(tabId);
    cancelledGraphReconciliations.delete(tabId);
  }
}
