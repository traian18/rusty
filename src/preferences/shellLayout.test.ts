import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAWER_DEFAULT_WIDTH,
  DRAWER_MAX_WIDTH,
  DRAWER_MIN_WIDTH,
  DRAWER_WIDTH_STORAGE_KEY,
  clampDrawerWidth,
  loadDrawerWidth,
  saveDrawerWidth,
} from "./shellLayout";

describe("clampDrawerWidth", () => {
  it("passes through an in-range value", () => {
    expect(clampDrawerWidth(400)).toBe(400);
  });

  it("clamps below the minimum", () => {
    expect(clampDrawerWidth(50)).toBe(DRAWER_MIN_WIDTH);
  });

  it("clamps above the maximum", () => {
    expect(clampDrawerWidth(9999)).toBe(DRAWER_MAX_WIDTH);
  });

  it("rounds a float", () => {
    expect(clampDrawerWidth(320.6)).toBe(321);
  });

  it("falls back to the default for NaN", () => {
    expect(clampDrawerWidth(Number.NaN)).toBe(DRAWER_DEFAULT_WIDTH);
  });

  it("falls back to the default for Infinity", () => {
    expect(clampDrawerWidth(Number.POSITIVE_INFINITY)).toBe(DRAWER_DEFAULT_WIDTH);
  });

  it("clamps a negative value to the minimum, not the default", () => {
    expect(clampDrawerWidth(-100)).toBe(DRAWER_MIN_WIDTH);
  });
});

describe("loadDrawerWidth / saveDrawerWidth", () => {
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

  it("returns the default when nothing is stored", () => {
    expect(loadDrawerWidth()).toBe(DRAWER_DEFAULT_WIDTH);
  });

  it("returns a validly stored value", () => {
    store.set(DRAWER_WIDTH_STORAGE_KEY, "450");
    expect(loadDrawerWidth()).toBe(450);
  });

  it("clamps an out-of-range stored value", () => {
    store.set(DRAWER_WIDTH_STORAGE_KEY, "9999");
    expect(loadDrawerWidth()).toBe(DRAWER_MAX_WIDTH);
  });

  it("falls back to the default for garbage", () => {
    store.set(DRAWER_WIDTH_STORAGE_KEY, "not-a-number");
    expect(loadDrawerWidth()).toBe(DRAWER_DEFAULT_WIDTH);
  });

  it("falls back to the default when localStorage is absent", () => {
    vi.unstubAllGlobals();
    // @ts-expect-error -- deliberately simulating an environment without localStorage
    delete globalThis.localStorage;
    expect(loadDrawerWidth()).toBe(DRAWER_DEFAULT_WIDTH);
  });

  it("saveDrawerWidth clamps and persists", () => {
    const result = saveDrawerWidth(9999);
    expect(result).toBe(DRAWER_MAX_WIDTH);
    expect(store.get(DRAWER_WIDTH_STORAGE_KEY)).toBe(String(DRAWER_MAX_WIDTH));
  });

  it("saveDrawerWidth does not throw when localStorage.setItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: fakeLocalStorage.getItem,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    expect(() => saveDrawerWidth(400)).not.toThrow();
  });
});
