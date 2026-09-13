import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../../store";
import { scheduleTreeRefresh } from "../filetree/FileTreePresenter";

/**
 * Keeps the Project Explorer's file tree in sync with the real filesystem
 * without the user ever pressing Refresh -- a file created/deleted/renamed
 * by anything outside this app's own file-tree actions (an agent run's own
 * disk writes, a terminal command, git, another editor) used to only show
 * up after a manual reload, since nothing told the frontend the disk had
 * changed underneath it.
 *
 * Deliberately NOT under src/components/filetree/: this module needs the
 * real store and Tauri's `invoke`/`listen`, the same reason
 * providerCoordinator.ts and startupSteps.ts live next to
 * AppBootstrapBoundary.tsx instead of under their own generic-logic
 * directories.
 *
 * Pairs with src-tauri/src/fs_watch.rs: `watch_workspace` (re)starts a
 * single OS-level recursive watcher for whatever rootPath currently is,
 * and the Rust side emits a bare "workspace-fs-changed" event (already
 * filtered there for node_modules/.git/target/dist noise) whenever
 * something changes. This module's only two jobs are (1) telling Rust
 * which root to watch, kept current via a store subscription, and (2)
 * turning that event into the same debounced refresh FileTreePresenter's
 * own in-app file operations already use, so an external change and an
 * in-app one coalesce through one code path rather than two.
 */

let started = false;
let lastWatchedRoot: string | null = null;
let unsubscribeStore: (() => void) | null = null;
let unlistenFsChanged: (() => void) | null = null;

function applyRoot(rootPath: string): void {
  if (!rootPath || rootPath === lastWatchedRoot) return;
  lastWatchedRoot = rootPath;
  invoke("watch_workspace", { rootDir: rootPath }).catch((err) => {
    console.error("Failed to start workspace file watcher:", err);
  });
}

/** Idempotent, matching providerCoordinator.ts's own `started` guard --
    safe to call from AppBootstrapBoundary on every beginRun() (including a
    Retry) without double-subscribing or double-listening. */
export function startWorkspaceFsWatch(): void {
  if (started) return;
  started = true;

  listen("workspace-fs-changed", () => {
    scheduleTreeRefresh();
  }).then((unlisten) => {
    unlistenFsChanged = unlisten;
  }).catch((err) => {
    console.error("Failed to listen for workspace-fs-changed:", err);
  });

  applyRoot(useWorkspaceStore.getState().rootPath);
  unsubscribeStore = useWorkspaceStore.subscribe((state, previous) => {
    if (state.rootPath !== previous.rootPath) applyRoot(state.rootPath);
  });
}

/** Test-only reset (mirrors providerCoordinator.ts's stopProviderCoordinator):
    production code never calls this, since AppBootstrapBoundary's coordinator
    is meant to run for the life of the session. */
export function stopWorkspaceFsWatch(): void {
  started = false;
  lastWatchedRoot = null;
  unsubscribeStore?.();
  unsubscribeStore = null;
  unlistenFsChanged?.();
  unlistenFsChanged = null;
}
