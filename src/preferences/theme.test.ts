import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, loadStoredThemeId, saveThemeId } from "./theme";
import { theme as defaultTheme } from "../theme";

describe("loadStoredThemeId / saveThemeId", () => {
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

  it("returns null when nothing is stored", () => {
    expect(loadStoredThemeId()).toBeNull();
  });

  it("returns a validly stored theme id", () => {
    store.set(THEME_STORAGE_KEY, defaultTheme.id);
    expect(loadStoredThemeId()).toBe(defaultTheme.id);
  });

  it("resolves an invalid stored id to the default, matching resolveTheme's own fallback", () => {
    store.set(THEME_STORAGE_KEY, "not-a-real-theme");
    expect(loadStoredThemeId()).toBe(defaultTheme.id);
  });

  it("returns null (not the default) when localStorage is absent -- distinct from 'stored but invalid'", () => {
    vi.unstubAllGlobals();
    // @ts-expect-error -- deliberately simulating an environment without localStorage
    delete globalThis.localStorage;
    expect(loadStoredThemeId()).toBeNull();
  });

  it("returns null when localStorage.getItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("access denied");
      },
    });
    expect(loadStoredThemeId()).toBeNull();
  });

  it("saveThemeId resolves and persists the theme id", () => {
    const result = saveThemeId(defaultTheme.id);
    expect(result).toBe(defaultTheme.id);
    expect(store.get(THEME_STORAGE_KEY)).toBe(defaultTheme.id);
  });

  it("saveThemeId resolves an invalid id to the default before saving", () => {
    const result = saveThemeId("not-a-real-theme");
    expect(result).toBe(defaultTheme.id);
    expect(store.get(THEME_STORAGE_KEY)).toBe(defaultTheme.id);
  });

  it("saveThemeId does not throw when localStorage.setItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: fakeLocalStorage.getItem,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    expect(() => saveThemeId(defaultTheme.id)).not.toThrow();
  });

  it("saveThemeId still returns the resolved id when localStorage is absent", () => {
    vi.unstubAllGlobals();
    // @ts-expect-error -- deliberately simulating an environment without localStorage
    delete globalThis.localStorage;
    expect(saveThemeId(defaultTheme.id)).toBe(defaultTheme.id);
  });
});
