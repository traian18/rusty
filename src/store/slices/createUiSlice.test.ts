import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUiTestStore } from "../../test/uiTestStore";
import { DRAWER_DEFAULT_WIDTH, DRAWER_MAX_WIDTH, DRAWER_WIDTH_STORAGE_KEY } from "../../preferences/shellLayout";

describe("createUiSlice defaults", () => {
  it("starts with the drawer closed", () => {
    // The whole point of this slice: the explorer used to start open
    // (App.tsx's isSidebarExplorerOpen defaulted to true).
    const store = createUiTestStore();
    expect(store.getState().drawerOpen).toBe(false);
  });

  it("defaults drawerView to explorer, drawerWidth to the default, search closed", () => {
    const state = createUiTestStore().getState();
    expect(state.drawerView).toBe("explorer");
    expect(state.drawerWidth).toBe(DRAWER_DEFAULT_WIDTH);
    expect(state.searchOpen).toBe(false);
  });
});

describe("toggleDrawerView: all six transitions", () => {
  it("closed -> opens on the requested view (explorer)", () => {
    const store = createUiTestStore();
    store.getState().toggleDrawerView("explorer");
    expect(store.getState()).toMatchObject({ drawerOpen: true, drawerView: "explorer" });
  });

  it("closed -> opens on the requested view (git)", () => {
    const store = createUiTestStore();
    store.getState().toggleDrawerView("git");
    expect(store.getState()).toMatchObject({ drawerOpen: true, drawerView: "git" });
  });

  it("open on explorer, toggle explorer -> closes, view unchanged", () => {
    const store = createUiTestStore({ drawerOpen: true, drawerView: "explorer" } as never);
    store.getState().toggleDrawerView("explorer");
    expect(store.getState()).toMatchObject({ drawerOpen: false, drawerView: "explorer" });
  });

  it("open on explorer, toggle git -> switches view, stays open", () => {
    const store = createUiTestStore({ drawerOpen: true, drawerView: "explorer" } as never);
    store.getState().toggleDrawerView("git");
    expect(store.getState()).toMatchObject({ drawerOpen: true, drawerView: "git" });
  });

  it("open on git, toggle git -> closes, view unchanged", () => {
    const store = createUiTestStore({ drawerOpen: true, drawerView: "git" } as never);
    store.getState().toggleDrawerView("git");
    expect(store.getState()).toMatchObject({ drawerOpen: false, drawerView: "git" });
  });

  it("open on git, toggle explorer -> switches view, stays open", () => {
    const store = createUiTestStore({ drawerOpen: true, drawerView: "git" } as never);
    store.getState().toggleDrawerView("explorer");
    expect(store.getState()).toMatchObject({ drawerOpen: true, drawerView: "explorer" });
  });
});

describe("openDrawer vs toggleDrawerView", () => {
  it("openDrawer opens on the requested view when closed", () => {
    const store = createUiTestStore();
    store.getState().openDrawer("git");
    expect(store.getState()).toMatchObject({ drawerOpen: true, drawerView: "git" });
  });

  it("openDrawer never closes an already-open drawer, even on the same view", () => {
    // This is the property the file-reveal flow depends on: revealing a file
    // while the drawer is already open on Explorer must not toggle it shut.
    const store = createUiTestStore({ drawerOpen: true, drawerView: "explorer" } as never);
    store.getState().openDrawer("explorer");
    expect(store.getState()).toMatchObject({ drawerOpen: true, drawerView: "explorer" });
  });

  it("openDrawer switches view without closing when already open on a different view", () => {
    const store = createUiTestStore({ drawerOpen: true, drawerView: "git" } as never);
    store.getState().openDrawer("explorer");
    expect(store.getState()).toMatchObject({ drawerOpen: true, drawerView: "explorer" });
  });
});

describe("closeDrawer", () => {
  it("closes an open drawer", () => {
    const store = createUiTestStore({ drawerOpen: true, drawerView: "git" } as never);
    store.getState().closeDrawer();
    expect(store.getState().drawerOpen).toBe(false);
  });

  it("is idempotent and preserves drawerView and drawerWidth", () => {
    const store = createUiTestStore({ drawerOpen: false, drawerView: "git", drawerWidth: 450 } as never);
    store.getState().closeDrawer();
    expect(store.getState()).toMatchObject({ drawerOpen: false, drawerView: "git", drawerWidth: 450 });
  });
});

describe("setDrawerWidth", () => {
  it("clamps and stores the width", () => {
    const store = createUiTestStore();
    store.getState().setDrawerWidth(9999);
    expect(store.getState().drawerWidth).toBe(DRAWER_MAX_WIDTH);
  });

  it("rejects NaN by falling back to the default", () => {
    const store = createUiTestStore();
    store.getState().setDrawerWidth(Number.NaN);
    expect(store.getState().drawerWidth).toBe(DRAWER_DEFAULT_WIDTH);
  });
});

describe("setSearchOpen", () => {
  it("opens and closes the search palette", () => {
    const store = createUiTestStore();
    store.getState().setSearchOpen(true);
    expect(store.getState().searchOpen).toBe(true);
    store.getState().setSearchOpen(false);
    expect(store.getState().searchOpen).toBe(false);
  });
});

describe("persistence contract: width persists, everything else is session-only", () => {
  const backing = new Map<string, string>();
  const fakeLocalStorage: Pick<Storage, "getItem" | "setItem"> = {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value),
  };

  beforeEach(() => {
    backing.clear();
    vi.stubGlobal("localStorage", fakeLocalStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("setDrawerWidth writes localStorage", () => {
    createUiTestStore().getState().setDrawerWidth(420);
    expect(backing.get(DRAWER_WIDTH_STORAGE_KEY)).toBe("420");
  });

  it("toggleDrawerView writes nothing", () => {
    createUiTestStore().getState().toggleDrawerView("git");
    expect(backing.size).toBe(0);
  });

  it("openDrawer writes nothing", () => {
    createUiTestStore().getState().openDrawer("git");
    expect(backing.size).toBe(0);
  });

  it("closeDrawer writes nothing", () => {
    const store = createUiTestStore({ drawerOpen: true } as never);
    store.getState().closeDrawer();
    expect(backing.size).toBe(0);
  });

  it("setSearchOpen writes nothing", () => {
    createUiTestStore().getState().setSearchOpen(true);
    expect(backing.size).toBe(0);
  });
});

describe("creation purity", () => {
  it("composing the store does not touch localStorage at all", () => {
    // Pins the exact rule the code this slice replaced violated: App.tsx's
    // sidebarWidth useState read localStorage inside its lazy initializer,
    // which runs at creation time. A localStorage whose getItem throws must
    // not prevent the store from being created.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("localStorage unavailable");
      },
      setItem: () => {
        throw new Error("localStorage unavailable");
      },
    });
    expect(() => createUiTestStore()).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("hydrateUi", () => {
  const backing = new Map<string, string>();
  const fakeLocalStorage: Pick<Storage, "getItem" | "setItem"> = {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value),
  };

  beforeEach(() => {
    backing.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies a validly stored width", () => {
    vi.stubGlobal("localStorage", fakeLocalStorage);
    backing.set(DRAWER_WIDTH_STORAGE_KEY, "500");
    const store = createUiTestStore();
    store.getState().hydrateUi();
    expect(store.getState().drawerWidth).toBe(500);
  });

  it("clamps an out-of-range stored width", () => {
    vi.stubGlobal("localStorage", fakeLocalStorage);
    backing.set(DRAWER_WIDTH_STORAGE_KEY, "9999");
    const store = createUiTestStore();
    store.getState().hydrateUi();
    expect(store.getState().drawerWidth).toBe(DRAWER_MAX_WIDTH);
  });

  it("falls back to the default for garbage", () => {
    vi.stubGlobal("localStorage", fakeLocalStorage);
    backing.set(DRAWER_WIDTH_STORAGE_KEY, "not-a-number");
    const store = createUiTestStore();
    store.getState().hydrateUi();
    expect(store.getState().drawerWidth).toBe(DRAWER_DEFAULT_WIDTH);
  });

  it("falls back to the default when localStorage is absent entirely", () => {
    // Deliberately NOT stubbing localStorage here -- this is what proves the
    // `typeof localStorage === "undefined"` guard in shellLayout.ts.
    const store = createUiTestStore();
    store.getState().hydrateUi();
    expect(store.getState().drawerWidth).toBe(DRAWER_DEFAULT_WIDTH);
  });
});
