import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRevealHandshakeTestStore } from "../test/revealHandshakeTestStore";

/**
 * Pins the fix in REFACTOR_PLAN.md PR 2 commit 13: revealFileInTree used to
 * set expandedPaths/revealPath, then dispatch a "reveal-file-in-tree"
 * CustomEvent on a setTimeout(0) for AppShell to pick up and open the
 * drawer on a *later* tick. Since ContextDrawer (and FileTree inside it)
 * only mounts once drawerOpen flips, a listener reacting on a later tick
 * risked FileTree never existing to consume revealPath. It's now a single
 * synchronous set() that opens the drawer itself.
 */
describe("revealFileInTree: the drawer-open handshake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens the drawer on Explorer and sets revealPath in one synchronous update, with no timer", () => {
    const store = createRevealHandshakeTestStore();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    store.getState().revealFileInTree("src/components/App.tsx");

    expect(store.getState()).toMatchObject({
      drawerOpen: true,
      drawerView: "explorer",
      revealPath: "src/components/App.tsx",
    });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("dispatches no window event", () => {
    // This suite runs in the same plain-node environment as
    // tabTestStore.ts's -- no `window` global at all, which alone proves
    // the old `window.dispatchEvent(new CustomEvent(...))` call is gone.
    // Guard defensively rather than assume, in case a future environment
    // change adds a DOM here.
    const dispatchSpy = typeof window !== "undefined" ? vi.spyOn(window, "dispatchEvent") : undefined;
    const store = createRevealHandshakeTestStore();

    store.getState().revealFileInTree("src/App.tsx");

    if (dispatchSpy) expect(dispatchSpy).not.toHaveBeenCalled();
    else expect(typeof window).toBe("undefined");
  });

  it("expands every ancestor directory of the revealed file", () => {
    const store = createRevealHandshakeTestStore();

    store.getState().revealFileInTree("src/components/shell/AppShell.tsx");

    expect(store.getState().expandedPaths).toEqual({
      src: true,
      "src/components": true,
      "src/components/shell": true,
    });
  });

  it("switches from Source Control to Explorer -- the caveat scenario: a wrong-view open would strand revealPath", () => {
    const store = createRevealHandshakeTestStore({ drawerOpen: true, drawerView: "git" } as never);

    store.getState().revealFileInTree("src/App.tsx");

    expect(store.getState()).toMatchObject({
      drawerOpen: true,
      drawerView: "explorer",
      revealPath: "src/App.tsx",
    });
  });

  it("re-opens on Explorer even if the drawer was already closed", () => {
    const store = createRevealHandshakeTestStore({ drawerOpen: false } as never);

    store.getState().revealFileInTree("src/App.tsx");

    expect(store.getState().drawerOpen).toBe(true);
    expect(store.getState().drawerView).toBe("explorer");
  });

  // REFACTOR_PLAN.md PR 7 commit 6: a bare `.split("/")` never matched a
  // native Windows path here, silently expanding no ancestor at all.
  it("expands every ancestor directory of a native Windows path", () => {
    const store = createRevealHandshakeTestStore();

    store.getState().revealFileInTree("C:\\src\\components\\shell\\AppShell.tsx");

    expect(store.getState().expandedPaths).toEqual({
      "C:": true,
      "C:/src": true,
      "C:/src/components": true,
      "C:/src/components/shell": true,
    });
  });
});
