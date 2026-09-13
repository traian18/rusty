/**
 * A `window` CustomEvent channel for "the user wants to close this tab".
 *
 * Every close affordance dispatches here, and exactly one listener (the close
 * controller mounted by the workspace) evaluates the guard and either closes
 * the tab or raises a confirmation. Previously the guard lived in a handler
 * that `Workspace` passed down to `TabBar`, so the close-active-tab keyboard
 * shortcut in `App.tsx` -- which is outside `Workspace` -- called the raw
 * store action and silently skipped every unsaved/running check.
 *
 * Follows the existing `tasknode-stop-request` precedent (`reveal-file-in-tree`
 * used to be a second example, but PR 2 commit 13 replaced it with a direct
 * store update -- the drawer, unlike the close guard, has no need for a
 * cross-cutting listener once its state lives in the store itself). PR 2
 * lifts the controller into `AppShell`, at which point this can become a
 * plain prop again if that reads better.
 */

const CLOSE_TAB_REQUEST = "rusty-close-tab-request";

export function requestCloseTab(tabId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CLOSE_TAB_REQUEST, { detail: { tabId } }));
}

/** Subscribes to close requests. Returns an unsubscribe function. */
export function onCloseTabRequest(handler: (tabId: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const tabId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId;
    if (tabId) handler(tabId);
  };
  window.addEventListener(CLOSE_TAB_REQUEST, listener);
  return () => window.removeEventListener(CLOSE_TAB_REQUEST, listener);
}
