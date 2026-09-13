/**
 * TAB_POLICIES — the authoritative declaration of how every tab type behaves:
 * identity, uniqueness, mount lifetime, close guards, and cleanup.
 *
 * This replaces the old dead `src/components/tabs/TabRegistry.ts` plus the
 * hard-coded singleton array that used to live inside the editor slice. That
 * array omitted `metrics`, so metrics tabs silently duplicated; declaring
 * uniqueness here makes that class of drift impossible — a tab type without a
 * policy is a compile error.
 *
 * Store-side only: no React, no Tauri, no store imports.
 */

import {
  canonicalizeFilePath,
  canvasTabIdentity,
  fileTabIdentity,
  gitDiffTabIdentity,
  gitHistoryTabIdentity,
  nextCanvasId,
  resolveAgainstRoot,
  taskTabIdentity,
} from "./identity";
// A pure factory whose own imports are type-only, so this creates no runtime
// cycle and keeps one definition of "empty canvas context" for both the store
// and this policy table.
import { createEmptyCanvasContext } from "../store/canvasHelpers";
import type {
  CloseGuard,
  KeepAlive,
  SingletonTabType,
  TabDomainState,
  TabOfType,
  TabPolicy,
  TabPolicyTable,
  TabType,
} from "./types";

function basename(path: string): string {
  const canonical = canonicalizeFilePath(path);
  const index = canonical.lastIndexOf("/");
  return index === -1 ? canonical : canonical.slice(index + 1);
}

/**
 * Every singleton's identity is its own type name, so `openTab`'s
 * `tabs.find(t => t.id === identity)` doubles as the singleton check with no
 * special-casing anywhere.
 */
function singleton<K extends SingletonTabType>(
  type: K,
  label: string,
  keepAlive: KeepAlive = "active-only",
): TabPolicy<K> {
  return {
    type,
    uniqueness: "global",
    getIdentity: () => type,
    label: () => label,
    // `request` is annotated structurally because TypeScript cannot reduce
    // `Extract<OpenTabRequest, { type: K }>` while `K` is still generic, even
    // though every singleton request carries an optional `title`.
    create: (request: { title?: string }, id: string) =>
      ({
        id,
        type,
        title: request.title ?? label,
        status: "idle",
        dirty: false,
      }) as TabOfType<K>,
    keepAlive,
    closable: true,
  };
}

const agent: TabPolicy<"agent"> = {
  ...singleton(
    "agent",
    "Agent",
    // Stays mounted because the agent's WebSocket is owned by the component
    // and dies with it. That ownership itself is unchanged by PR 7 (a
    // deliberate scope decision -- see the PR 7 plan) since `keepAlive:
    // "always"` already ties this component's mount lifetime to the tab's
    // own lifetime; what PR 7 commit 2 fixes is narrower: closing this tab
    // mid-run had no confirmation at all (isBusy/beforeClose below).
    "always",
  ),
  seedOnCreate: (tab, state) => ({
    agentChats: { ...state.agentChats, [tab.id]: [] },
  }),
  isBusy: (tab, state) => !!state.busyAgentTabIds[tab.id],
  beforeClose: (tab, state) => {
    if (state.busyAgentTabIds[tab.id]) {
      return { kind: "confirm", reason: "running", tabId: tab.id, title: tab.title };
    }
    return { kind: "allow" };
  },
  pruneOnClose: (tab, state) => {
    const { [tab.id]: _chat, ...agentChats } = state.agentChats;
    const { [tab.id]: _stream, ...agentStreams } = state.agentStreams;
    const { [tab.id]: _perm, ...agentPermissionRequests } = state.agentPermissionRequests;
    const { [tab.id]: _busy, ...busyAgentTabIds } = state.busyAgentTabIds;
    return { agentChats, agentStreams, agentPermissionRequests, busyAgentTabIds };
  },
};

const file: TabPolicy<"file"> = {
  type: "file",
  uniqueness: "resource",
  getIdentity: (request, ctx) => fileTabIdentity(request.path, ctx.rootPath),
  label: (request) => basename(request.path),
  create: (request, id, ctx) => ({
    id,
    type: "file",
    title: request.title ?? basename(request.path),
    status: "idle",
    dirty: false,
    path: resolveAgainstRoot(request.path, ctx.rootPath),
    line: request.line,
  }),
  /**
   * `request.line ?? existing.line` deliberately PRESERVES the previous line
   * when a re-open does not name one: opening a file you already have open
   * (from the tree, say) should not yank the caret back to line 1.
   *
   * Known limitation: requesting the SAME line twice does not re-scroll,
   * because FileTab's scroll effect is keyed on `[tab.line]` and the value is
   * unchanged. A monotonic `navRevision` would fix it; out of scope here.
   */
  merge: (existing, request) => {
    const line = request.line ?? existing.line;
    const title = request.title ?? existing.title;
    if (line === existing.line && title === existing.title) return existing;
    return { ...existing, line, title };
  },
  keepAlive: "active-only",
  closable: true,
};

const canvas: TabPolicy<"canvas"> = {
  type: "canvas",
  uniqueness: "resource",
  getIdentity: (request, ctx) =>
    canvasTabIdentity(request.canvasId ?? nextCanvasId([...ctx.existingIds, ...ctx.existingCanvasIds])),
  label: (request) => request.title ?? "Untitled Pipeline",
  create: (request, id) => ({
    id,
    type: "canvas",
    title: request.title ?? "Untitled Pipeline",
    status: "idle",
    dirty: false,
    canvasId: id,
  }),
  seedOnCreate: (tab, state) => ({
    canvasContexts: { ...state.canvasContexts, [tab.id]: createEmptyCanvasContext() },
    canvasHistories: { ...state.canvasHistories, [tab.id]: { past: [], future: [] } },
  }),
  keepAlive: "while-busy",
  isBusy: (tab, state) =>
    Object.values(state.canvasContexts[tab.id]?.nodeStatus ?? {}).some(
      (status) => status === "running",
    ),
  closable: true,
  beforeClose: (tab, state) => {
    const context = state.canvasContexts[tab.id];
    // A canvas with no context has nothing to lose. Guarding here is also what
    // removes the unguarded dereference the old close flow had after stopping
    // running nodes.
    if (!context) return { kind: "allow" };
    if (Object.values(context.nodeStatus ?? {}).some((status) => status === "running")) {
      return { kind: "confirm", reason: "running", tabId: tab.id, title: tab.title };
    }
    if (!context.hasBeenSaved && (context.nodes.length > 0 || context.edges.length > 0)) {
      return { kind: "confirm", reason: "unsaved", tabId: tab.id, title: tab.title };
    }
    return { kind: "allow" };
  },
  pruneOnClose: (tab, state) => {
    const { [tab.id]: _context, ...canvasContexts } = state.canvasContexts;
    const { [tab.id]: _history, ...canvasHistories } = state.canvasHistories;
    return { canvasContexts, canvasHistories };
  },
};

const task: TabPolicy<"task"> = {
  type: "task",
  uniqueness: "resource",
  getIdentity: (request) => taskTabIdentity(request.canvasId, request.taskNodeId),
  label: (request) => request.title ?? "Task",
  create: (request, id) => ({
    id,
    type: "task",
    title: request.title ?? "Task",
    status: "idle",
    dirty: false,
    canvasId: request.canvasId,
    taskNodeId: request.taskNodeId,
  }),
  keepAlive: "while-busy",
  isBusy: (tab, state) =>
    state.canvasContexts[tab.canvasId]?.nodeStatus?.[tab.taskNodeId] === "running",
  // REFACTOR_PLAN.md PR 7 commit 2 bonus consistency fix: reuses this
  // policy's own existing isBusy predicate (unlike agent, task never
  // needed a new store field for this -- the running-node status it
  // already reads from canvasContexts was always here).
  beforeClose: (tab, state) => {
    if (state.canvasContexts[tab.canvasId]?.nodeStatus?.[tab.taskNodeId] === "running") {
      return { kind: "confirm", reason: "running", tabId: tab.id, title: tab.title };
    }
    return { kind: "allow" };
  },
  closable: true,
};

const gitHistory: TabPolicy<"git-history"> = {
  type: "git-history",
  uniqueness: "resource",
  getIdentity: (request, ctx) =>
    gitHistoryTabIdentity(request.repoPath ?? ctx.rootPath, request.path),
  label: (request) => (request.path ? `History: ${basename(request.path)}` : "Git Graph"),
  create: (request, id, ctx) => ({
    id,
    type: "git-history",
    title: request.title ?? gitHistory.label(request),
    status: "idle",
    dirty: false,
    repoPath: canonicalizeFilePath(request.repoPath ?? ctx.rootPath),
    path: request.path ? canonicalizeFilePath(request.path) : undefined,
  }),
  keepAlive: "active-only",
  closable: true,
};

const gitDiff: TabPolicy<"git-diff"> = {
  type: "git-diff",
  uniqueness: "resource",
  getIdentity: (request, ctx) =>
    gitDiffTabIdentity({
      repoPath: request.repoPath ?? ctx.rootPath,
      path: request.path,
      diffType: request.diffType,
      commitHash: request.commitHash,
    }),
  label: (request) => {
    const name = basename(request.path);
    if (request.diffType === "commit") return `${name} (${(request.commitHash ?? "").slice(0, 7)})`;
    return `${name} (${request.diffType === "staged" ? "Index" : "Workspace"})`;
  },
  create: (request, id, ctx) => ({
    id,
    type: "git-diff",
    title: request.title ?? gitDiff.label(request),
    status: "idle",
    dirty: false,
    repoPath: canonicalizeFilePath(request.repoPath ?? ctx.rootPath),
    path: canonicalizeFilePath(request.path),
    diffType: request.diffType,
    commitHash: request.commitHash,
  }),
  // Safe to unmount: GitDiffTab is read-only and refetches from its props.
  keepAlive: "active-only",
  closable: true,
};

export const TAB_POLICIES: TabPolicyTable = {
  onboarding: singleton("onboarding", "Welcome to Rusty"),
  workspace: singleton("workspace", "Workspaces"),
  settings: singleton("settings", "Settings"),
  "llm-setup": singleton("llm-setup", "LLM Integrations"),
  skills: singleton("skills", "Skills"),
  "mcp-integration": singleton("mcp-integration", "MCP Integration"),
  metrics: singleton("metrics", "Token Metrics"),
  agent,
  file,
  canvas,
  task,
  "git-history": gitHistory,
  "git-diff": gitDiff,
};

export function getTabPolicy<K extends TabType>(type: K): TabPolicy<K> {
  return TAB_POLICIES[type];
}

/** Whether a tab should stay mounted while inactive. */
export function shouldKeepMounted(
  tab: { id: string; type: TabType },
  state: TabDomainState,
): boolean {
  const policy = getTabPolicy(tab.type);
  if (policy.keepAlive === "always") return true;
  if (policy.keepAlive === "while-busy") {
    return policy.isBusy?.(tab as never, state) ?? false;
  }
  return false;
}

/**
 * Domain state to install alongside a newly created tab; `{}` when the policy
 * declares none. Like `pruneForClosedTab`, policies return whole maps.
 */
export function seedForNewTab(
  tab: { id: string; type: TabType },
  state: TabDomainState,
): Partial<TabDomainState> {
  return getTabPolicy(tab.type).seedOnCreate?.(tab as never, state) ?? {};
}

export function pruneForClosedTab(
  tab: { id: string; type: TabType },
  state: TabDomainState,
): Partial<TabDomainState> {
  return getTabPolicy(tab.type).pruneOnClose?.(tab as never, state) ?? {};
}

export function closeGuardFor(
  tab: { id: string; type: TabType; title: string },
  state: TabDomainState,
): CloseGuard {
  const policy = getTabPolicy(tab.type);
  if (!policy.closable) return { kind: "allow" };
  return policy.beforeClose?.(tab as never, state) ?? { kind: "allow" };
}
