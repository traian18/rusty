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

export interface GitFileStatus {
  path: string;
  name: string;
  status_type: "modified" | "added" | "deleted" | "untracked";
}

export interface GitStatusResult {
  isRepo: boolean;
  currentBranch: string;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
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
  gitStatus: GitStatusResult | null;
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
  saveSecureConfig: () => Promise<void>;
  loadSecureConfig: () => Promise<void>;
}
