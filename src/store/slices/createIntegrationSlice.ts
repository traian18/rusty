import type { McpServerConfig } from "../../components/mcp/types";
import { BUILT_IN_SKILLS, DEFAULT_SKILL_ID } from "../../config/skillDefinitions";
import { skillsService } from "../../services/skillsService";
import { loadStoredThemeId, saveThemeId } from "../../preferences/theme";
import {
  normalizeStoredModelReference,
  normalizeStoredProvider,
  normalizedProviderId,
  PROVIDER_CONFIG_VERSION,
} from "../providerHelpers";
import type { WorkspaceSliceCreator } from "../sliceTypes";
import type { CustomProvider, LspSettings, Skill, WorkspaceState } from "../types";

/**
 * Coalesces every saveSecureConfig trigger within the same tick into one
 * write, instead of the one-`setTimeout(…, 0)`-per-call-site pattern this
 * replaces (REFACTOR_PLAN.md PR 3b). saveSecureConfig writes the ENTIRE
 * encrypted blob through PBKDF2 at 100,000 iterations
 * (services/secureStorageService.ts) -- before this fix, a single "Fetch
 * models" click scheduled two full rewrites (updateProviderSettings, then
 * setActiveModel), and PR 3b's background provider/model discovery would
 * otherwise multiply that into a rewrite storm at every launch. Keyed by
 * `get` (stable per store instance, one per app) via a WeakMap rather than
 * a bare module-level timer, so multiple test stores created in the same
 * process never share a pending timer.
 */
const pendingSaveTimers = new WeakMap<() => WorkspaceState, ReturnType<typeof setTimeout>>();

function scheduleSaveSecureConfig(get: () => WorkspaceState): void {
  if (pendingSaveTimers.has(get)) return;
  const timer = setTimeout(() => {
    pendingSaveTimers.delete(get);
    void get().saveSecureConfig();
  }, 0);
  pendingSaveTimers.set(get, timer);
}

/** Matches src/theme.ts's own default (`themes.spaceDust`); a bare string
 * literal here rather than an import + resolveTheme() call, matching this
 * file's existing `activeCustomProviderId: "opencode"` precedent -- the
 * point is a constant with no I/O, not resolving it through the registry. */
const DEFAULT_THEME_ID = "spaceDust";

const defaultProviders: CustomProvider[] = [
  {
    id: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: "",
    apiType: "openai-completions",
    authType: "bearer",
    catalogUrl: "https://opencode.ai/zen/v1/models",
    models: [],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "",
    apiType: "anthropic-messages",
    authType: "anthropic",
    catalogUrl: "https://api.anthropic.com/v1/models",
    models: [
      { id: "anthropic/claude-sonnet-4-6", remoteId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", apiType: "anthropic-messages", baseUrl: "https://api.anthropic.com", supported: true, reasoning: true, supportedReasoningEfforts: ["minimal", "low", "medium", "high"] },
      { id: "anthropic/claude-opus-4-6", remoteId: "claude-opus-4-6", name: "Claude Opus 4.6", apiType: "anthropic-messages", baseUrl: "https://api.anthropic.com", supported: true, reasoning: true, supportedReasoningEfforts: ["minimal", "low", "medium", "high"] },
      { id: "anthropic/claude-haiku-4-5", remoteId: "claude-haiku-4-5", name: "Claude Haiku 4.5", apiType: "anthropic-messages", baseUrl: "https://api.anthropic.com", supported: true, reasoning: true, supportedReasoningEfforts: ["minimal", "low", "medium", "high"] },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    apiType: "openai-responses",
    authType: "bearer",
    catalogUrl: "https://api.openai.com/v1/models",
    models: [
      { id: "openai/gpt-5.6-sol", remoteId: "gpt-5.6-sol", name: "GPT-5.6 Sol", apiType: "openai-responses", baseUrl: "https://api.openai.com/v1", supported: true, reasoning: true, supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000, cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
      { id: "openai/gpt-5.6-terra", remoteId: "gpt-5.6-terra", name: "GPT-5.6 Terra", apiType: "openai-responses", baseUrl: "https://api.openai.com/v1", supported: true, reasoning: true, supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000, cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 } },
      { id: "openai/gpt-5.6-luna", remoteId: "gpt-5.6-luna", name: "GPT-5.6 Luna", apiType: "openai-responses", baseUrl: "https://api.openai.com/v1", supported: true, reasoning: true, supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000, cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 } },
    ],
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    baseUrl: "",
    apiKey: "",
    apiType: "codex-app-server",
    transport: "openai-codex-app-server",
    authType: "environment",
    models: [],
  },
  {
    id: "anthropic-claude-code",
    name: "Claude Code",
    baseUrl: "",
    apiKey: "",
    apiType: "claude-agent-sdk",
    transport: "anthropic-claude-agent-sdk",
    authType: "environment",
    models: [],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    baseUrl: "",
    apiKey: "",
    apiType: "copilot-sdk",
    transport: "github-copilot-sdk",
    authType: "environment",
    models: [],
  },
  {
    id: "github-models",
    name: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    apiKey: "",
    apiType: "openai-completions",
    authType: "bearer",
    catalogUrl: "https://models.github.ai/catalog/models",
    models: [],
  },
];

const defaultLspSettings: LspSettings = {
  enabled: false,
  servers: {
    typescript: { serverPath: "typescript-language-server", args: ["--stdio"] },
    python: { serverPath: "pyright-langserver", args: ["--stdio"] },
    go: { serverPath: "gopls", args: [] },
    rust: { serverPath: "rust-analyzer", args: [] },
    java: { serverPath: "jdtls", args: [] },
    c: { serverPath: "clangd", args: [] },
    cpp: { serverPath: "clangd", args: [] },
    csharp: { serverPath: "csharp-ls", args: [] },
    ruby: { serverPath: "ruby-lsp", args: [] },
    php: { serverPath: "intelephense", args: ["--stdio"] },
    lua: { serverPath: "lua-language-server", args: [] },
    bash: { serverPath: "bash-language-server", args: ["start"] },
    json: { serverPath: "vscode-json-language-server", args: ["--stdio"] },
    yaml: { serverPath: "yaml-language-server", args: ["--stdio"] },
    html: { serverPath: "vscode-html-language-server", args: ["--stdio"] },
    css: { serverPath: "vscode-css-language-server", args: ["--stdio"] },
  },
};

export const createIntegrationSlice: WorkspaceSliceCreator = (set, get) => ({
  customProviders: defaultProviders,
  activeCustomProviderId: "opencode",
  activeModel: "",
  lspSettings: defaultLspSettings,
  skills: BUILT_IN_SKILLS,
  activeSkillId: DEFAULT_SKILL_ID,
  // No hydrate action needed: this was a dead read (localStorage key
  // "rusty_mcp_config" is never written anywhere in the repo -- real MCP
  // restore happens in loadSecureConfig below, from "rusty_secure_config").
  // Deleted outright rather than replaced (REFACTOR_PLAN.md PR 3a).
  mcpServers: {},
  activeThemeId: DEFAULT_THEME_ID,
  secureConfigLoaded: false,
  pendingWorkspaceRestorePath: null,

  updateLspSettings: (settings) => set((state) => {
    scheduleSaveSecureConfig(get);
    return { lspSettings: { ...state.lspSettings, ...settings } };
  }),

  loadSkills: async () => {
    const { rootPath } = get();
    if (!rootPath) return;
    try {
      const userSkills = await skillsService.loadSkills(rootPath);
      const builtInSkills = get().skills.filter((skill) => skill.isBuiltIn);
      const builtInIds = new Set(builtInSkills.map((skill) => skill.id));
      const newUserSkills = userSkills
        .filter((skill: Skill) => !builtInIds.has(skill.id))
        .map((skill: Skill) => ({ ...skill, mcpServers: skill.mcpServers || [] }));
      set({ skills: [...builtInSkills, ...newUserSkills] });
    } catch (error) {
      console.error("Failed to load skills:", error);
    }
  },

  addSkill: (skill) => set((state) => {
    const existing = state.skills.some((candidate) => candidate.id === skill.id);
    return {
      skills: existing
        ? state.skills.map((candidate) => candidate.id === skill.id ? skill : candidate)
        : [...state.skills, skill],
    };
  }),

  updateSkill: (id, updates) => set((state) => ({
    skills: state.skills.map((skill) => skill.id === id
      ? { ...skill, ...updates, updatedAt: new Date().toISOString() }
      : skill),
  })),

  deleteSkill: (id) => set((state) => ({
    skills: state.skills.filter((skill) => skill.id !== id),
    activeSkillId: state.activeSkillId === id ? null : state.activeSkillId,
  })),
  setActiveSkill: (activeSkillId) => set({ activeSkillId }),

  setMcpServers: (mcpServers) => {
    set({ mcpServers });
    scheduleSaveSecureConfig(get);
  },
  addMcpServer: (server) => set((state) => {
    scheduleSaveSecureConfig(get);
    return { mcpServers: { ...state.mcpServers, [server.name]: server } };
  }),
  updateMcpServer: (name, updates) => set((state) => {
    const existing = state.mcpServers[name];
    if (!existing) return {};
    scheduleSaveSecureConfig(get);
    return { mcpServers: { ...state.mcpServers, [name]: { ...existing, ...updates } } };
  }),
  removeMcpServer: (name) => set((state) => {
    const mcpServers = { ...state.mcpServers };
    delete mcpServers[name];
    scheduleSaveSecureConfig(get);
    return { mcpServers };
  }),

  addCustomProvider: (provider) => set((state) => {
    scheduleSaveSecureConfig(get);
    return { customProviders: [...state.customProviders.filter((item) => item.id !== provider.id), provider] };
  }),
  updateProviderSettings: (providerId, settings) => set((state) => {
    scheduleSaveSecureConfig(get);
    return {
      customProviders: state.customProviders.map((provider) =>
        provider.id === providerId ? { ...provider, ...settings } : provider,
      ),
    };
  }),
  setActiveCustomProviderId: (activeCustomProviderId) => {
    set({ activeCustomProviderId });
    scheduleSaveSecureConfig(get);
  },
  setActiveModel: (activeModel) => {
    set({ activeModel });
    scheduleSaveSecureConfig(get);
  },

  setActiveThemeId: (themeId) => {
    // This synchronous preference is the source of truth so closing the app
    // cannot interrupt an asynchronous secure-config write.
    const activeThemeId = saveThemeId(themeId);
    set({ activeThemeId });
  },

  // Called from main.tsx, synchronously, before createRoot -- never at
  // slice-creation time. Reproduces exactly the computation the old
  // creation-time initializer ran (REFACTOR_PLAN.md PR 3a).
  hydrateTheme: () => set({ activeThemeId: loadStoredThemeId() || DEFAULT_THEME_ID }),

  saveSecureConfig: async () => {
    const state = get();
    // Guards against a real data-loss bug: saveSecureConfig writes the
    // ENTIRE snapshot (providers/API keys/lastWorkspacePath/MCP servers),
    // and nine call sites in this file schedule it (via
    // scheduleSaveSecureConfig, above) on nearly every settings mutation.
    // Before loadSecureConfig has completed (or
    // if it failed and the user clicked "Continue anyway"), the store is
    // still holding defaultProviders with empty apiKeys and rootPath: "" --
    // writing that over a real, previously-saved encrypted blob would
    // silently destroy it. secureConfigLoaded is set only once
    // loadSecureConfig finishes (REFACTOR_PLAN.md PR 3a).
    if (!state.secureConfigLoaded) {
      console.warn(
        "saveSecureConfig: skipped -- secure config has not finished loading yet " +
        "(saving now would overwrite it with incomplete/default state).",
      );
      return;
    }
    const { SecureStorageService } = await import("../../services/secureStorageService");
    await SecureStorageService.saveSecureData("rusty_secure_config", {
      configVersion: PROVIDER_CONFIG_VERSION,
      customProviders: state.customProviders,
      activeCustomProviderId: state.activeCustomProviderId,
      activeModel: state.activeModel,
      lastWorkspacePath: state.rootPath,
      mcpServers: state.mcpServers,
      lspSettings: { ...state.lspSettings, enabled: false },
    });
  },

  loadSecureConfig: async () => {
    const { SecureStorageService } = await import("../../services/secureStorageService");
    const config = await SecureStorageService.loadSecureData<{
      configVersion?: number;
      customProviders?: CustomProvider[];
      activeCustomProviderId?: string | null;
      activeModel?: string;
      activeThemeId?: string;
      lastWorkspacePath?: string;
      mcpServers?: Record<string, McpServerConfig>;
      lspSettings?: LspSettings;
    }>("rusty_secure_config");
    if (!config) {
      // Nothing has ever been saved (e.g. a fresh install) -- that is a
      // successfully "loaded" (empty) state, not a failure, so saving is
      // safe from here on.
      set({ secureConfigLoaded: true });
      return;
    }

    const updates: Partial<WorkspaceState> = {};
    const configVersion = config.configVersion || 0;
    if (config.customProviders) {
      const currentDefaults = get().customProviders;
      const normalizedProviders = config.customProviders.map((provider) =>
        normalizeStoredProvider(provider, configVersion)
      );
      const savedProviders = new Map(normalizedProviders.map((provider) => [provider.id, provider]));
      const mergedProviders = currentDefaults.map((defaultProvider) => {
        const savedProvider = savedProviders.get(defaultProvider.id);
        return savedProvider
          ? {
              ...defaultProvider,
              ...savedProvider,
              baseUrl: savedProvider.baseUrl || defaultProvider.baseUrl,
              catalogUrl: savedProvider.catalogUrl || defaultProvider.catalogUrl,
              models: savedProvider.models?.length ? savedProvider.models : defaultProvider.models,
            }
          : defaultProvider;
      });
      const defaultIds = new Set(currentDefaults.map((provider) => provider.id));
      normalizedProviders.forEach((provider) => {
        if (!defaultIds.has(provider.id)) mergedProviders.push(provider);
      });
      updates.customProviders = mergedProviders;
    }
    if (config.activeCustomProviderId !== undefined) {
      updates.activeCustomProviderId = config.activeCustomProviderId
        ? normalizedProviderId(config.activeCustomProviderId, configVersion)
        : null;
    }
    if (config.activeModel) {
      updates.activeModel = normalizeStoredModelReference(config.activeModel, configVersion) || "";
    }
    if (config.mcpServers) updates.mcpServers = config.mcpServers;
    if (config.lspSettings) updates.lspSettings = { ...config.lspSettings, enabled: false };
    const storedThemeId = loadStoredThemeId();
    if (storedThemeId) {
      // Never let an older asynchronous config snapshot replace the latest
      // theme preference during startup.
      updates.activeThemeId = saveThemeId(storedThemeId);
    } else if (config.activeThemeId) {
      // Migrate themes saved before the dedicated preference became canonical.
      updates.activeThemeId = saveThemeId(config.activeThemeId);
    }
    // The actual restore (a Tauri invoke, then loadWorkspaceData) is a
    // separate startup step (components/shell/startupSteps.ts's
    // "workspace-restore", dependsOn: ["secure-config"]) rather than inline
    // here -- it needs its own, longer timeout budget and must not be able
    // to make this step's OWN critical failure/timeout depend on a slow
    // directory listing. That step is also secureConfigLoaded's sole owner
    // for the "a saved path exists" case (REFACTOR_PLAN.md PR 3a); this
    // action only records the candidate path for it to pick up.
    updates.pendingWorkspaceRestorePath = config.lastWorkspacePath || null;
    set(updates);
  },
});
