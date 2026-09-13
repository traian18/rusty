/**
 * Per-tab stop-callback registry (REFACTOR_PLAN.md PR 7 commit 2) -- lets
 * the close-intercept controller say "stop whatever this tab is running"
 * without needing to know the tab's type. This is the natural per-tab
 * generalization of the existing `src/components/sidepane/stopExecution.ts`
 * (a single-slot, node-id-keyed callback used for the canvas SidePane's own
 * stop button), not a new pattern -- that one stays as-is for its own
 * narrower use.
 */

type StopCallback = () => void;

const callbacks = new Map<string, StopCallback>();

/** Registers `cb` as the way to stop tab `tabId`'s current work. A tab
    type with nothing to stop (most of them) never calls this. */
export function registerTabStop(tabId: string, cb: StopCallback): void {
  callbacks.set(tabId, cb);
}

/** Unregisters `tabId`'s stop callback -- call on unmount, mirroring the
    register call, so a stale callback can never fire for a since-closed or
    since-reopened tab. */
export function unregisterTabStop(tabId: string): void {
  callbacks.delete(tabId);
}

/** Invokes `tabId`'s registered stop callback, if any. A no-op (not an
    error) for a tab type that never registered one. */
export function requestTabStop(tabId: string): void {
  callbacks.get(tabId)?.();
}
