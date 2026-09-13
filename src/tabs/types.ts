/**
 * Tab type system: the single source of truth for what a tab IS.
 *
 * Layering rule (see ARCHITECTURE.md): this file and its siblings in
 * `src/tabs/` — except `views.tsx` — must never import React, the store, or
 * Tauri. The store imports `policy.ts`; the view imports `views.tsx`. Two
 * tables keyed by the same `TabType` is what lets tab behavior be declared in
 * one place without the store reaching into the view layer.
 *
 * The domain-type imports below are `import type` only, so the apparent cycle
 * with `src/store/types.ts` (which imports `TabInstance` from here) is erased
 * at compile time and never exists at runtime.
 */

import type {
  AgentMessage,
  AgentPermissionRequest,
  CanvasContext,
  CanvasHistory,
} from "../store/types";

export type TabType =
  | "onboarding"
  | "workspace"
  | "settings"
  | "llm-setup"
  | "skills"
  | "mcp-integration"
  | "metrics"
  | "agent"
  | "file"
  | "canvas"
  | "task"
  | "git-history"
  | "git-diff";

/** Tab types that may only ever have one instance, identified by the type name itself. */
export type SingletonTabType =
  | "onboarding"
  | "workspace"
  | "settings"
  | "llm-setup"
  | "skills"
  | "mcp-integration"
  | "metrics"
  | "agent";

export type TabStatus = "idle" | "busy" | "error";

export type DiffKind = "staged" | "unstaged" | "commit";

interface TabBase {
  /**
   * Also the canonical identity. There is deliberately no separate `identity`
   * field: nothing persists tabs, and no tab type uses `multiple` uniqueness
   * today, so `id === identity` for every live tab. Splitting them would mean
   * keeping two values in sync at every call site for no present benefit;
   * adding `identity` later is a purely additive change.
   */
  id: string;
  title: string;
  status: TabStatus;
  dirty: boolean;
}

/**
 * A live tab. Discriminated on `type`, with per-type fields named for what
 * they actually are — this replaces the old `Tab.key`, which meant a file
 * path, a canvas id, or a task node id depending on `type`.
 */
/**
 * Distributed so each singleton type is its own union member. Writing this as
 * `TabBase & { type: SingletonTabType }` would make it a SINGLE member with a
 * union-typed discriminant, and `Extract<TabInstance, { type: "agent" }>`
 * would then resolve to `never`.
 */
type SingletonTabInstance = {
  [K in SingletonTabType]: TabBase & { type: K };
}[SingletonTabType];

export type TabInstance =
  | SingletonTabInstance
  | (TabBase & { type: "file"; path: string; line?: number })
  | (TabBase & { type: "canvas"; canvasId: string })
  | (TabBase & { type: "task"; canvasId: string; taskNodeId: string })
  | (TabBase & { type: "git-history"; repoPath: string; path?: string })
  | (TabBase & {
      type: "git-diff";
      repoPath: string;
      path: string;
      diffType: DiffKind;
      commitHash?: string;
    });

export type TabOfType<K extends TabType> = Extract<TabInstance, { type: K }>;

/**
 * What a call site passes to `openTab`. Everything but the resource itself is
 * optional — `title` defaults to the policy's label, which is what removes the
 * hard-coded tab titles that used to live at every call site.
 */
/** Distributed for the same reason as `SingletonTabInstance` above. */
type SingletonTabRequest = {
  [K in SingletonTabType]: { type: K; title?: string };
}[SingletonTabType];

export type OpenTabRequest =
  | SingletonTabRequest
  | { type: "file"; path: string; line?: number; title?: string }
  | { type: "canvas"; canvasId?: string; title?: string }
  | { type: "task"; canvasId: string; taskNodeId: string; title?: string }
  | { type: "git-history"; repoPath?: string; path?: string; title?: string }
  | {
      type: "git-diff";
      repoPath?: string;
      path: string;
      diffType: DiffKind;
      commitHash?: string;
      title?: string;
    };

export type RequestOfType<K extends TabType> = Extract<OpenTabRequest, { type: K }>;

/**
 * Ambient state the slice supplies to policies, so call sites never have to
 * thread it. `existingCanvasIds` is separate from `existingIds` because canvas
 * contexts outlive their tabs (a closed canvas may still be re-openable).
 */
export interface TabResolveContext {
  rootPath: string;
  existingIds: readonly string[];
  existingCanvasIds: readonly string[];
}

/**
 * The per-tab-id domain state a policy may inspect or prune. `WorkspaceState`
 * satisfies this structurally, so slices pass `state` directly and tests pass
 * a literal — neither needs to know about the other's full shape.
 */
export interface TabDomainState {
  canvasContexts: Record<string, CanvasContext>;
  canvasHistories: Record<string, CanvasHistory>;
  agentChats: Record<string, AgentMessage[]>;
  agentStreams: Record<string, string>;
  agentPermissionRequests: Record<string, AgentPermissionRequest[]>;
  /** Which Agent tabs currently have an active run (REFACTOR_PLAN.md PR 7
      commit 2) -- lets the `agent` tab policy's `isBusy`/`beforeClose`
      confirm a mid-stream close the same way `canvas`'s already does,
      without needing a ref into AgentTab.tsx's own component state. */
  busyAgentTabIds: Record<string, boolean>;
}

export type Uniqueness = "global" | "resource" | "multiple";

/**
 * - `active-only`: unmount as soon as the tab is not active.
 * - `while-busy`:  stay mounted while `isBusy` reports work in flight.
 * - `always`:      never unmount while the tab is open.
 */
export type KeepAlive = "active-only" | "while-busy" | "always";

/**
 * The result of a close guard. Deliberately a plain value, not a promise: the
 * guard is pure and never blocks, and the view decides how to render a
 * confirmation.
 */
export type CloseGuard =
  | { kind: "allow" }
  | { kind: "confirm"; reason: "running" | "unsaved"; tabId: string; title: string };

export interface TabPolicy<K extends TabType = TabType> {
  type: K;
  uniqueness: Uniqueness;
  /** Pure and stable across calls. Not consulted for `multiple` uniqueness. */
  getIdentity: (request: RequestOfType<K>, ctx: TabResolveContext) => string;
  /** Default title, used when the request does not supply one. */
  label: (request: RequestOfType<K>) => string;
  create: (request: RequestOfType<K>, id: string, ctx: TabResolveContext) => TabOfType<K>;
  /**
   * Called when `openTab` resolves to a tab that already exists. Return
   * `existing` unchanged to make the re-open a pure activation.
   */
  merge?: (existing: TabOfType<K>, request: RequestOfType<K>) => TabOfType<K>;
  /**
   * Domain state to install alongside a NEWLY created tab. Never runs on
   * re-open, which is what stops a second `openTab` from wiping the state the
   * first one accumulated.
   */
  seedOnCreate?: (tab: TabOfType<K>, state: TabDomainState) => Partial<TabDomainState>;
  keepAlive: KeepAlive;
  closable: boolean;
  /** Only consulted when `keepAlive === "while-busy"`. */
  isBusy?: (tab: TabOfType<K>, state: TabDomainState) => boolean;
  beforeClose?: (tab: TabOfType<K>, state: TabDomainState) => CloseGuard;
  /** Pure store pruning, merged into the same `set()` that removes the tab. */
  pruneOnClose?: (tab: TabOfType<K>, state: TabDomainState) => Partial<TabDomainState>;
  // Non-store cleanup deliberately lives in `effects.ts`, not here: it needs
  // service imports, and keeping this table free of them is what stops a
  // store -> policy -> service -> store runtime cycle.
}

export type TabPolicyTable = { [K in TabType]: TabPolicy<K> };
