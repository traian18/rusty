import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationTestStore } from "../../test/integrationTestStore";
import { THEME_STORAGE_KEY } from "../../preferences/theme";
import { theme as defaultTheme } from "../../theme";
import { SecureStorageService } from "../../services/secureStorageService";

vi.mock("../../services/secureStorageService", () => ({
  SecureStorageService: {
    loadSecureData: vi.fn(),
    saveSecureData: vi.fn(),
  },
}));

describe("createIntegrationSlice: creation-time purity (REFACTOR_PLAN.md PR 3a)", () => {
  it("composes without throwing even when localStorage.getItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("access denied");
      },
    });
    try {
      expect(() => createIntegrationTestStore()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("initializes activeThemeId to the constant default, ignoring a stored theme entirely", () => {
    const store = new Map<string, string>([[THEME_STORAGE_KEY, "midnight"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
    });

    try {
      expect(createIntegrationTestStore().getState().activeThemeId).toBe(defaultTheme.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("initializes mcpServers to an empty object -- the dead 'rusty_mcp_config' read is deleted, not replaced", () => {
    const store = new Map<string, string>([
      ["rusty_mcp_config", JSON.stringify({ mcpServers: { foo: { name: "foo" } } })],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
    });

    try {
      expect(createIntegrationTestStore().getState().mcpServers).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("createIntegrationSlice: hydrateTheme", () => {
  const store = new Map<string, string>();
  const fakeLocalStorage: Pick<Storage, "getItem" | "setItem"> = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", fakeLocalStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a stored theme id after creation", () => {
    // "dark" is a real registered theme, distinct from the "spaceDust"
    // default, so seeing it after hydrateTheme() proves the read actually
    // happened rather than the constant initializer just matching by luck.
    store.set(THEME_STORAGE_KEY, "dark");
    const testStore = createIntegrationTestStore();

    expect(testStore.getState().activeThemeId).toBe(defaultTheme.id);
    testStore.getState().hydrateTheme();
    expect(testStore.getState().activeThemeId).toBe("dark");
  });

  it("falls back to the default when nothing is stored", () => {
    const testStore = createIntegrationTestStore();
    testStore.getState().hydrateTheme();
    expect(testStore.getState().activeThemeId).toBe(defaultTheme.id);
  });

  it("setActiveThemeId persists and updates state", () => {
    const testStore = createIntegrationTestStore();
    testStore.getState().setActiveThemeId("dark");
    expect(testStore.getState().activeThemeId).toBe("dark");
    expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
  });
});

describe("createIntegrationSlice: secureConfigLoaded guard (the data-loss fix, REFACTOR_PLAN.md PR 3a)", () => {
  beforeEach(() => {
    vi.mocked(SecureStorageService.loadSecureData).mockReset();
    vi.mocked(SecureStorageService.saveSecureData).mockReset();
  });

  it("starts false", () => {
    expect(createIntegrationTestStore().getState().secureConfigLoaded).toBe(false);
  });

  it("saveSecureConfig is a no-op before loadSecureConfig has ever run", async () => {
    const testStore = createIntegrationTestStore();

    await testStore.getState().saveSecureConfig();

    expect(SecureStorageService.saveSecureData).not.toHaveBeenCalled();
  });

  it("loadSecureConfig sets secureConfigLoaded even when nothing was ever saved (a fresh install)", async () => {
    vi.mocked(SecureStorageService.loadSecureData).mockResolvedValue(null);
    const testStore = createIntegrationTestStore();

    await testStore.getState().loadSecureConfig();

    expect(testStore.getState().secureConfigLoaded).toBe(true);
  });

  it("loadSecureConfig alone does NOT set secureConfigLoaded when a saved config exists -- that's the workspace-restore step's job now", async () => {
    vi.mocked(SecureStorageService.loadSecureData).mockResolvedValue({ configVersion: 1 });
    const testStore = createIntegrationTestStore();

    await testStore.getState().loadSecureConfig();

    expect(testStore.getState().secureConfigLoaded).toBe(false);
  });

  it("loadSecureConfig records pendingWorkspaceRestorePath from a saved config's lastWorkspacePath", async () => {
    vi.mocked(SecureStorageService.loadSecureData).mockResolvedValue({
      configVersion: 1,
      lastWorkspacePath: "/Users/test/my-project",
    });
    const testStore = createIntegrationTestStore();

    await testStore.getState().loadSecureConfig();

    expect(testStore.getState().pendingWorkspaceRestorePath).toBe("/Users/test/my-project");
  });

  it("loadSecureConfig sets pendingWorkspaceRestorePath to null when the saved config never had a workspace", async () => {
    vi.mocked(SecureStorageService.loadSecureData).mockResolvedValue({ configVersion: 1 });
    const testStore = createIntegrationTestStore();

    await testStore.getState().loadSecureConfig();

    expect(testStore.getState().pendingWorkspaceRestorePath).toBeNull();
  });

  it("leaves secureConfigLoaded false when loadSecureConfig itself rejects", async () => {
    vi.mocked(SecureStorageService.loadSecureData).mockRejectedValue(new Error("decrypt failed"));
    const testStore = createIntegrationTestStore();

    await expect(testStore.getState().loadSecureConfig()).rejects.toThrow("decrypt failed");

    expect(testStore.getState().secureConfigLoaded).toBe(false);
  });

  it("saveSecureConfig proceeds once secureConfigLoaded is true", async () => {
    vi.mocked(SecureStorageService.loadSecureData).mockResolvedValue(null);
    const testStore = createIntegrationTestStore();
    await testStore.getState().loadSecureConfig();

    await testStore.getState().saveSecureConfig();

    expect(SecureStorageService.saveSecureData).toHaveBeenCalledTimes(1);
  });

  it("the 'Continue anyway' path (a rejected load, then the user proceeds) keeps save guarded", async () => {
    vi.mocked(SecureStorageService.loadSecureData).mockRejectedValue(new Error("decrypt failed"));
    const testStore = createIntegrationTestStore();
    await testStore.getState().loadSecureConfig().catch(() => {});

    // The view's "Continue anyway" is a local React state transition only --
    // it never retries loadSecureConfig -- so secureConfigLoaded legitimately
    // never becomes true on this path, and any later settings mutation that
    // fires saveSecureConfig must still be a no-op.
    await testStore.getState().saveSecureConfig();

    expect(SecureStorageService.saveSecureData).not.toHaveBeenCalled();
  });
});

describe("createIntegrationSlice: scheduleSaveSecureConfig coalescing (REFACTOR_PLAN.md PR 3b)", () => {
  beforeEach(() => {
    vi.mocked(SecureStorageService.loadSecureData).mockReset();
    vi.mocked(SecureStorageService.saveSecureData).mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadedStore() {
    vi.mocked(SecureStorageService.loadSecureData).mockResolvedValue(null);
    const testStore = createIntegrationTestStore();
    await testStore.getState().loadSecureConfig();
    return testStore;
  }

  it("coalesces two mutations scheduled in the same tick into a single save -- the fix for handleFetchModels's old two-write click (updateProviderSettings, then setActiveModel)", async () => {
    const testStore = await loadedStore();

    // Mirrors LlmSetupTab's handleFetchModels: updateProviderSettings(...)
    // immediately followed by setActiveModel(...), synchronously.
    testStore.getState().updateProviderSettings("opencode", { apiKey: "new-key" });
    testStore.getState().setActiveModel("opencode/some-model");

    await vi.runAllTimersAsync();

    expect(SecureStorageService.saveSecureData).toHaveBeenCalledTimes(1);
  });

  it("still saves once per mutation when they happen in separate ticks", async () => {
    const testStore = await loadedStore();

    testStore.getState().setActiveModel("opencode/model-a");
    await vi.runAllTimersAsync();
    testStore.getState().setActiveModel("opencode/model-b");
    await vi.runAllTimersAsync();

    expect(SecureStorageService.saveSecureData).toHaveBeenCalledTimes(2);
  });

  it("coalesces across different mutation kinds (provider settings + mcp servers) in the same tick", async () => {
    const testStore = await loadedStore();

    testStore.getState().updateProviderSettings("opencode", { apiKey: "k" });
    testStore.getState().setMcpServers({});
    testStore.getState().updateLspSettings({ enabled: false });

    await vi.runAllTimersAsync();

    expect(SecureStorageService.saveSecureData).toHaveBeenCalledTimes(1);
  });

  it("saves reflect the LATEST state, not a stale snapshot from when the first mutation scheduled it", async () => {
    const testStore = await loadedStore();

    testStore.getState().setActiveCustomProviderId("anthropic");
    testStore.getState().setActiveModel("anthropic/claude-opus-4-6");

    await vi.runAllTimersAsync();

    expect(SecureStorageService.saveSecureData).toHaveBeenCalledTimes(1);
    expect(SecureStorageService.saveSecureData).toHaveBeenCalledWith(
      "rusty_secure_config",
      expect.objectContaining({
        activeCustomProviderId: "anthropic",
        activeModel: "anthropic/claude-opus-4-6",
      }),
    );
  });

  it("two independent store instances never share a pending timer", async () => {
    const storeA = await loadedStore();
    const storeB = await loadedStore();
    vi.mocked(SecureStorageService.saveSecureData).mockClear();

    storeA.getState().setActiveModel("a-model");
    storeB.getState().setActiveModel("b-model");

    await vi.runAllTimersAsync();

    expect(SecureStorageService.saveSecureData).toHaveBeenCalledTimes(2);
  });
});

describe("createIntegrationSlice: loadSecureConfig's provider-merge, modelsFetchedAt (REFACTOR_PLAN.md PR 3b)", () => {
  beforeEach(() => {
    vi.mocked(SecureStorageService.loadSecureData).mockReset();
    vi.mocked(SecureStorageService.saveSecureData).mockReset();
  });

  it("characterizes the pre-fix behavior this replaces: a saved empty models array with no modelsFetchedAt still falls back to the hardcoded defaults", async () => {
    vi.mocked(SecureStorageService.loadSecureData).mockResolvedValue({
      configVersion: 2,
      customProviders: [{ id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-test", apiType: "anthropic-messages", authType: "anthropic", models: [] }],
    });
    const testStore = createIntegrationTestStore();

    await testStore.getState().loadSecureConfig();

    const anthropic = testStore.getState().customProviders.find((p) => p.id === "anthropic");
    // Can't tell "never discovered" from "discovered and empty" without
    // modelsFetchedAt -- this is the exact ambiguity the field below
    // resolves. Preserved for configs saved before the field existed.
    expect(anthropic?.models.length).toBeGreaterThan(0);
  });

  it("trusts a saved empty models array once modelsFetchedAt proves discovery actually ran -- the fix", async () => {
    vi.mocked(SecureStorageService.loadSecureData).mockResolvedValue({
      configVersion: 2,
      customProviders: [{
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-test",
        apiType: "anthropic-messages",
        authType: "anthropic",
        models: [],
        modelsFetchedAt: "2026-09-01T00:00:00.000Z",
      }],
    });
    const testStore = createIntegrationTestStore();

    await testStore.getState().loadSecureConfig();

    const anthropic = testStore.getState().customProviders.find((p) => p.id === "anthropic");
    expect(anthropic?.models).toEqual([]);
    expect(anthropic?.modelsFetchedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("keeps a saved NON-empty models array regardless of modelsFetchedAt", async () => {
    const savedModel = { id: "anthropic/custom-model", name: "Custom Model", supported: true };
    vi.mocked(SecureStorageService.loadSecureData).mockResolvedValue({
      configVersion: 2,
      customProviders: [{
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-test",
        apiType: "anthropic-messages",
        authType: "anthropic",
        models: [savedModel],
      }],
    });
    const testStore = createIntegrationTestStore();

    await testStore.getState().loadSecureConfig();

    const anthropic = testStore.getState().customProviders.find((p) => p.id === "anthropic");
    expect(anthropic?.models).toEqual([
      expect.objectContaining({ id: "anthropic/custom-model", name: "Custom Model" }),
    ]);
  });

  it("a provider never saved at all keeps the hardcoded defaults, with modelsFetchedAt still absent", async () => {
    vi.mocked(SecureStorageService.loadSecureData).mockResolvedValue({ configVersion: 2, customProviders: [] });
    const testStore = createIntegrationTestStore();

    await testStore.getState().loadSecureConfig();

    const anthropic = testStore.getState().customProviders.find((p) => p.id === "anthropic");
    expect(anthropic?.models.length).toBeGreaterThan(0);
    expect(anthropic?.modelsFetchedAt).toBeUndefined();
  });
});
