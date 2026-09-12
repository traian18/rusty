import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationTestStore } from "../../test/integrationTestStore";
import { THEME_STORAGE_KEY } from "../../preferences/theme";
import { theme as defaultTheme } from "../../theme";

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
