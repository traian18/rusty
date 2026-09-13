import type {
  Connection,
  Edge,
  Node,
  OnEdgesChange,
  OnNodesChange,
} from "@xyflow/react";
import type { McpServerConfig } from "../components/mcp/types";
import type { TypographyPreferences } from "../preferences/typography";
import type { KeyboardShortcutPreferences, ShortcutAction } from "../preferences/shortcuts";
import type { DrawerView } from "../preferences/shellLayout";
import type { OpenTabRequest, TabInstance } from "../tabs/types";
import type { StartupState } from "../startup/types";
import type { ProviderId, ProviderStatusEntry } from "../integrations/registryTypes";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ProviderModel {
  id: string;
  name: string;
  remoteId?: string;
  apiType?: string;
  baseUrl?: string;
  supported?: boolean;
  capabilities?: string[];
  reasoning?: boolean;
  reasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  thinkingLevelMap?: Record<string, string | null>;
  thinkingBudgets?: Record<string, number>;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiType: string;
  /** Subscription providers use their official local runtimes instead of Pi's HTTP adapters. */
  transport?: "http" | "github-copilot-sdk" | "openai-codex-app-server" | "anthropic-claude-agent-sdk";
  authType?: "bearer" | "anthropic" | "none" | "environment";
  catalogUrl?: string;
  models: ProviderModel[];
  /** ISO timestamp of the last successful discoverModels() call for this
      provider (REFACTOR_PLAN.md PR 3b). Absent means "never discovered" --
      what lets createIntegrationSlice's load-time merge stop conflating
      that with "discovered and legitimately empty" (a saved empty models
      array used to always fall back to the hardcoded defaults). Optional,
      so no PROVIDER_CONFIG_VERSION bump was needed to add it. */
  modelsFetchedAt?: string;
}

export type ProviderQuotaState = "available" | "unavailable" | "unauthenticated";

export interface ProviderQuotaWindow {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  unit?: "requests" | "tokens" | "credits";
  resetAt?: string;
  windowMinutes?: number;
  unlimited?: boolean;
  overage?: number;
  overageAllowed?: boolean;
}

export interface ProviderQuotaSnapshot {
  providerId: string;
  providerName: string;
  state: ProviderQuotaState;
  source: string;
  fetchedAt: string;
  plan?: string;
  account?: string;
  windows: ProviderQuotaWindow[];
  balance?: { formatted?: string; unlimited?: boolean };
  resetCreditsAvailable?: number;
  spendControlReached?: boolean;
  message?: string;
  manageUrl?: string;
}

/**
 * The integration registry's per-provider entry (REFACTOR_PLAN.md PR 3b).
 * Binds the generic ProviderStatusEntry (src/integrations/registryTypes.ts,
 * which cannot import this file -- see its own layering.test.ts) to this
 * app's concrete quota snapshot type, the same direction this file already
 * imports StartupState from ../startup/types.
 */
export type ProviderStatus = ProviderStatusEntry<ProviderQuotaSnapshot>;

export interface GeneratedTaskNodeSpec {
  key?: string;
  title: string;
  description: string;
  dependsOn?: string[];
}

export interface GeneratedContextNodeSpec {
  key?: string;
  title: string;
  content: string;
  taskKeys: string[];
}

export interface DevLog {
  id: string;
  type: "log" | "error" | "warn" | "system";
  text: string;
  timestamp: string;
}

/**
 * Unified with the previously-drifted copy in components/git/GitActions.ts
 * (REFACTOR_PLAN.md PR 5b commit 14) -- that file now re-exports this one
 * instead of declaring its own. "renamed" and "copied" both come from
 * git.rs's `-z` status parser (PR 5a commit 7); "copied" is new there.
 */
export interface GitFileStatus {
  path: string;
  name: string;
  status_type: "modified" | "added" | "deleted" | "untracked" | "renamed" | "copied";
}

export interface GitStatusResult {
  isRepo: boolean;
  currentBranch: string;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
}

/**
 * Mirrors git.rs's `GitHeadState` (REFACTOR_PLAN.md PR 5a commit 4), hand-
 * declared per this file's existing convention (no codegen) -- see
 * createGitSlice.ts for the snake_case-wire-to-camelCase-JS field mapping.
 * `mode` is `"branch"`, `"detached"`, or `"unborn"`; `branch` may still be
 * set when `mode === "unborn"` (a freshly `git init`-ed repo already points
 * HEAD at a named branch before the first commit exists), so the two are
 * independent signals, not mutually exclusive.
 */
export interface GitHeadState {
  mode: "branch" | "detached" | "unborn";
  branch: string | null;
  oid: string | null;
}

/** Mirrors git.rs's `SubmoduleState` (PR 5a commit 11). */
export interface SubmoduleState {
  changedGitlink: boolean;
  modifiedWorktree: boolean;
  untrackedContent: boolean;
}

/**
 * A discovered Git repository -- the opened workspace root, or one of its
 * linked worktrees/submodules (PR 5a commits 4-5). `id` is the canonicalized
 * `worktreePath`, the same convention `src/tabs/identity.ts`'s
 * `canonicalizeFilePath` already uses for tab identity -- not a hash.
 */
export interface GitRepository {
  id: string;
  worktreePath: string;
  gitDir: string;
  kind: "workspace" | "worktree" | "submodule";
  parentId: string | null;
  submodulePath: string | null;
  initialized: boolean;
  head: GitHeadState;
  /** Only present for an initialized `kind: "submodule"` entry. */
  submoduleState: SubmoduleState | null;
}

/**
 * Mirrors git.rs's `GitError` (PR 5a commit 2), the structured error every
 * git.rs command now rejects with instead of a bare string. Frontend call
 * sites should read `.message` for display (see gitErrors.ts's
 * `gitErrorMessage` helper) rather than stringifying the whole object.
 */
export interface GitError {
  operation: string;
  repository: string;
  exitCode: number | null;
  stderr: string;
  message: string;
}


export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool-result" | "console";
  content: string;
  timestamp: string;
  toolCalls?: AgentToolCall[];
  attachments?: { path: string; name: string }[];
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  status: "pending" | "approved" | "denied" | "executed" | "error";
  result?: string;
}

export interface AgentPermissionRequest {
  id: string;
  toolCall: AgentToolCall;
  description: string;
  timestamp: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  enabledTools: string[];
  preferredModel?: string;
  mcpServers: string[];
  isBuiltIn: boolean;
  /** If true, this skill is for internal/system use and must not appear in user-facing dropdowns. */
  isInternal?: boolean;
  icon?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  calls: number;
}

export interface UsageDaySummary {
  byModel: Record<string, UsageTotals>;
  total: UsageTotals;
}

export interface UsageSummary {
  byDay: Record<string, UsageDaySummary>;
  allTime: { byModel: Record<string, UsageTotals>; total: UsageTotals };
}

export type MetricsTimeframe =
  | { mode: "day"; day: string }
  | { mode: "range"; from: string; to: string }
  | { mode: "all-time" };


export interface GlobalChatMessage {
  id?: string;
  role: "user" | "assistant" | "system" | "console";
  content: string;
  timestamp: string;
  attachments?: { path: string; name: string; isDir?: boolean }[];
}

export interface ReconciliationLedgerEntry {
  path: string;
  status: "reconciled" | "error";
  sourceSignature: string;
  taskIds: string[];
  updatedAt: string;
  modified?: boolean;
  method?: "model" | "manual";
  response?: string;
  error?: string;
}

export interface ReconciliationSnapshot {
  /** Collision files currently owned by the reconciliation VFS node. */
  files: string[];
  originalFileContents: Record<string, string>;
  generatedFileContents: Record<string, string>;
  ledger?: Record<string, ReconciliationLedgerEntry>;
  updatedAt: string;
  response?: string;
}

export interface CanvasContext {
  nodes: Node[];
  edges: Edge[];
  nodeLogs: Record<string, string[]>;
  nodeStatus: Record<string, "idle" | "running" | "success" | "error">;
  globalChatHistory: Record<string, GlobalChatMessage[]>;
  edgeReconciliationStatus: Record<string, "idle" | "unreconciled" | "reconciled">;
  reconciliationSnapshot?: ReconciliationSnapshot;
  isPipelineApplied?: boolean;
  lastStickyColor?: string;
  hasBeenSaved?: boolean;
  /** When true, context nodes are hidden from the canvas unless they are connected to a task in `contextRevealedTasks`. */
  contextNodesHidden?: boolean;
  /** Task IDs whose connected context nodes should remain visible even when `contextNodesHidden` is true. */
  contextRevealedTasks?: string[];
}

export interface CanvasHistorySnapshot {
  nodes: Node[];
  edges: Edge[];
}

export interface CanvasHistory {
  past: CanvasHistorySnapshot[];
  future: CanvasHistorySnapshot[];
}

export interface LspServerConfig {
  serverPath: string;
  args: string[];
}

export interface LspSettings {
  enabled: boolean;
  servers: Record<string, LspServerConfig>;
}

export interface WorkspaceState {
  /** The startup coordinator's live lifecycle state (REFACTOR_PLAN.md PR
      3a). No consumers yet as of commit 9 -- AppBootstrapBoundary is wired
      to it in a later commit. */
  startupState: StartupState;
  setStartupState: (startupState: StartupState) => void;

  rootPath: string;
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  fileTree: any[];
  nodeLogs: Record<string, string[]>;
  globalContextSummary: string;
  globalChatHistory: Record<string, GlobalChatMessage[]>;
  nodeStatus: Record<string, "idle" | "running" | "success" | "error">;
  customProviders: CustomProvider[];
  activeCustomProviderId: string | null;
  activeModel: string;
  /** The integration registry (REFACTOR_PLAN.md PR 3b): one global source
      of provider auth/model/quota status, keyed by provider id. Absent
      entries read as {kind: "unknown"} via providerStatusOrUnknown
      (src/integrations/registryTypes.ts) -- no consumers yet as of the
      slice's own commit; the coordinator that populates it lands in a
      later commit. */
  providerStatus: Record<ProviderId, ProviderStatus>;
  setProviderStatus: (id: ProviderId, entry: ProviderStatus) => void;
  patchProviderStatus: (id: ProviderId, patch: Partial<ProviderStatus>) => void;
  /** @deprecated single-slot shim kept during the PR 5b migration (removed
      once every consumer moves to statusByRepositoryId -- commit 21); still
      the only source every existing consumer reads as of commit 15. */
  gitStatus: GitStatusResult | null;
  /** All repositories discovered under the current rootPath: the workspace
      root itself, its linked worktrees, and its submodules (recursively,
      for initialized ones) -- REFACTOR_PLAN.md PR 5b commit 15. Empty until
      discoverRepositories() has been called at least once for this
      rootPath. */
  repositories: GitRepository[];
  /** Keyed by GitRepository.id. Populated lazily, per repository, by
      loadRepositoryGitStatus -- unlike the deprecated single-slot
      `gitStatus`, nothing eagerly loads every repository's status just
      because discoverRepositories() ran. */
  statusByRepositoryId: Record<string, GitStatusResult>;
  /** The repository the Source Control UI (and anything scoped to "the
      current repo") should act on. Not yet wired to any consumer as of
      commit 15 -- SourceControl.tsx's own local activeRepo state moves
      here in commit 16. */
  activeRepositoryId: string | null;
  setActiveRepositoryId: (id: string | null) => void;
  /** Replaces the naive depth-3 filesystem walk (`scanSubprojects`, backed
      by the now-deleted git_scan_subprojects/scan_git_subdirs) with real
      Git-native discovery (git worktree list --porcelain + recursive
      submodule status). Wired up as SourceControl.tsx's RepoSelector
      source in commit 16. */
  discoverRepositories: () => Promise<void>;
  /** Loads git status for one discovered repository into
      statusByRepositoryId, keyed by its id -- the per-repository
      counterpart to the deprecated single-slot loadGitStatus. */
  loadRepositoryGitStatus: (repositoryId: string) => Promise<void>;
  lastRename: { originalPath: string; newPath: string } | null;
  setLastRename: (rename: { originalPath: string; newPath: string } | null) => void;
  collapseAllTrigger?: number;
  expandedPaths: Record<string, boolean>;
  revealPath: string | null;
  selectedEdgeId: string | null;
  edgeReconciliationStatus: Record<string, "idle" | "unreconciled" | "reconciled">;

  canvasContexts: Record<string, CanvasContext>;
  canvasHistories: Record<string, CanvasHistory>;
  onNodesChangeForTab: (tabId: string, changes: any[]) => void;
  onEdgesChangeForTab: (tabId: string, changes: any[]) => void;
  onConnectForTab: (tabId: string, connection: Connection) => void;
  updateCanvasContext: (tabId: string, updates: Partial<CanvasContext>) => void;
  loadCanvasTab: (data: any) => string;
  undoCanvasTab: (tabId: string) => void;
  redoCanvasTab: (tabId: string) => void;

  agentChats: Record<string, AgentMessage[]>;
  agentStreams: Record<string, string>;
  agentPermissionRequests: Record<string, AgentPermissionRequest[]>;
  addAgentMessage: (tabId: string, message: AgentMessage) => void;
  updateAgentMessage: (tabId: string, messageId: string, content: string) => void;
  setAgentMessages: (tabId: string, messages: AgentMessage[]) => void;
  clearAgentMessages: (tabId: string) => void;
  updateAgentStream: (tabId: string, content: string) => void;
  clearAgentStream: (tabId: string) => void;
  addAgentPermissionRequest: (tabId: string, request: AgentPermissionRequest) => void;
  resolveAgentPermission: (tabId: string, requestId: string, approved: boolean) => void;

  skills: Skill[];
  activeSkillId: string | null;
  addSkill: (skill: Skill) => void;
  updateSkill: (id: string, updates: Partial<Skill>) => void;
  deleteSkill: (id: string) => void;
  setActiveSkill: (id: string | null) => void;
  loadSkills: () => Promise<void>;

  metricsSummary: UsageSummary | null;
  metricsTimeframe: MetricsTimeframe;
  metricsLoading: boolean;
  metricsTodayTotal: number;
  /** Subscribes to live usage_update events exactly once (idempotent).
      Called from AppBootstrapBoundary, not at slice-creation time -- see
      ARCHITECTURE.md's "slice import-time purity". */
  initMetricsSubscription: () => void;
  loadMetricsSummary: () => Promise<void>;
  setMetricsTimeframe: (timeframe: MetricsTimeframe) => void;
  applyUsageUpdate: (runKey: string, cumulativeTotal: number) => void;

  mcpServers: Record<string, McpServerConfig>;
  setMcpServers: (servers: Record<string, McpServerConfig>) => void;
  addMcpServer: (server: McpServerConfig) => void;
  updateMcpServer: (name: string, updates: Partial<McpServerConfig>) => void;
  removeMcpServer: (name: string) => void;

  /**
   * Initializes to a constant and is hydrated from localStorage only via
   * hydrateTheme(), called from main.tsx before createRoot -- never at
   * slice-creation time. See ARCHITECTURE.md's "slice import-time purity".
   */
  activeThemeId: string;
  setActiveThemeId: (themeId: string) => void;
  hydrateTheme: () => void;
  /** Same hydration contract as hydrateTheme() above. */
  typographyPreferences: TypographyPreferences;
  setTypographyPreference: (key: keyof TypographyPreferences, value: number) => void;
  resetTypographyPreferences: () => void;
  hydrateTypography: () => void;
  /** Same hydration contract as hydrateTheme() above. */
  keyboardShortcuts: KeyboardShortcutPreferences;
  setKeyboardShortcut: (action: ShortcutAction, shortcut: string) => void;
  resetKeyboardShortcuts: () => void;
  hydrateShortcuts: () => void;

  setRootPath: (path: string) => void;
  /** Git status + skills + metrics for the current rootPath, settled
      together via Promise.allSettled so one throwing doesn't stop the
      others -- the shared tail setRootPath already ran; the startup
      workspace-restore step (REFACTOR_PLAN.md PR 3a) calls it too, which is
      what makes a restored workspace load metrics, not just fileTree. */
  loadWorkspaceData: () => Promise<void>;
  setGitStatus: (status: GitStatusResult | null) => void;
  loadGitStatus: (rootDir?: string) => Promise<void>;
  setFileTree: (tree: any[]) => void;
  resetForBranchChange: () => void;
  setSelectedNodeId: (id: string | null) => void;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (connection: Connection) => void;

  addContextNode: (x: number, y: number, fileContext?: { path: string; name: string; isDir: boolean }, tabId?: string) => void;
  addTaskNode: (x: number, y: number, tabId?: string) => void;
  addTaskNodesBatch: (
    tabId: string,
    anchorNodeId: string,
    tasks: GeneratedTaskNodeSpec[],
    contexts?: GeneratedContextNodeSpec[],
  ) => string[];
  addGlobalChatNode: (x: number, y: number, tabId?: string) => void;
  addMcpNode: (x: number, y: number, tabId?: string) => void;
  addStickyNode: (x: number, y: number, tabId?: string, color?: string) => void;
  addBoundaryNode: (x: number, y: number, tabId?: string) => void;
  updateTaskNode: (id: string, data: any) => void;
  updateNodePosition: (id: string, x: number, y: number) => void;
  deleteNode: (id: string) => void;
  addLog: (nodeId: string, message: string) => void;
  clearLogs: (nodeId: string) => void;
  setNodeStatus: (nodeId: string, status: "idle" | "running" | "success" | "error") => void;
  setGlobalContextSummary: (summary: string) => void;
  addGlobalChatMessage: (nodeId: string, message: GlobalChatMessage) => void;
  updateGlobalChatMessage: (nodeId: string, messageId: string, content: string) => void;
  clearGlobalChatHistory: (nodeId: string) => void;

  addCustomProvider: (provider: CustomProvider) => void;
  updateProviderSettings: (providerId: string, settings: Partial<Omit<CustomProvider, "id">>) => void;
  setActiveCustomProviderId: (id: string | null) => void;
  setActiveModel: (model: string) => void;

  devLogs: DevLog[];
  showDevConsole: boolean;
  addDevLog: (type: "log" | "error" | "warn" | "system", text: string) => void;
  clearDevLogs: () => void;
  setShowDevConsole: (show: boolean) => void;

  /**
   * Application-shell layout. `drawerOpen`/`drawerView`/`searchOpen` are
   * session-only by design; only `drawerWidth` persists (see
   * preferences/shellLayout.ts). `drawerWidth` initializes to a constant and
   * is hydrated from localStorage only via `hydrateUi()`, called from
   * AppBootstrapBoundary -- never at slice-creation time.
   */
  drawerOpen: boolean;
  drawerView: DrawerView;
  drawerWidth: number;
  searchOpen: boolean;
  hydrateUi: () => void;
  /** Opens on `view`, or switches to it; closes if already open on `view`. */
  toggleDrawerView: (view: DrawerView) => void;
  /** Opens on `view`. Unlike `toggleDrawerView`, never closes an open drawer. */
  openDrawer: (view: DrawerView) => void;
  closeDrawer: () => void;
  setDrawerWidth: (width: number) => void;
  setSearchOpen: (open: boolean) => void;

  terminalTabs: { id: string; name: string; type: "dev-logs" | "local"; cwd?: string }[];
  activeTerminalTabId: string | null;
  initTerminalState: (isDev: boolean) => void;
  addTerminalTab: (type: "dev-logs" | "local", cwd?: string) => void;
  closeTerminalTab: (id: string) => void;
  setActiveTerminalTabId: (id: string) => void;

  tabs: TabInstance[];
  activeTabId: string | null;
  /** Opens or focuses the tab for this request; returns its id. */
  openTab: (request: OpenTabRequest) => string;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<Omit<TabInstance, "id" | "type">>) => void;

  setPathExpanded: (path: string, expanded: boolean) => void;
  togglePathExpanded: (path: string) => void;
  collapseAllFolders: () => void;
  revealFileInTree: (filePath: string) => void;
  clearRevealPath: () => void;
  addAndConnectContextNode: (x: number, y: number, taskId: string, taskHandleId: string, tabId?: string) => void;
  getGlobalChatHistory: (nodeId: string) => GlobalChatMessage[];
  setSelectedEdgeId: (id: string | null) => void;
  setEdgeStatus: (edgeId: string, status: "idle" | "unreconciled" | "reconciled") => void;
  getSequenceEdges: () => Edge[];
  lspSettings: LspSettings;
  updateLspSettings: (settings: Partial<LspSettings>) => void;
  /** True only once the initial config load AND (if a workspace was saved)
      its restore have both settled -- saveSecureConfig is a no-op until
      then, so a failed/incomplete load can never overwrite a real,
      previously-saved config with default state (REFACTOR_PLAN.md PR 3a).
      Set by loadSecureConfig directly when nothing was ever saved; set by
      the startup "workspace-restore" step (components/shell/startupSteps.ts)
      otherwise, once it has resolved pendingWorkspaceRestorePath one way or
      another. */
  secureConfigLoaded: boolean;
  /** The workspace path loadSecureConfig found saved, for the
      "workspace-restore" step to actually restore -- null once there is
      nothing left to restore (including "there never was anything"). Not
      restored inline by loadSecureConfig itself: that step needs its own,
      longer timeout budget, independent of secure-config's critical one. */
  pendingWorkspaceRestorePath: string | null;
  saveSecureConfig: () => Promise<void>;
  loadSecureConfig: () => Promise<void>;
}
