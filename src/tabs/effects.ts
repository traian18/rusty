/**
 * Non-store cleanup for a closed tab.
 *
 * Kept out of `policy.ts` on purpose: this needs service imports, and a
 * policy table that reached into services would create a
 * store -> policy -> service -> store runtime cycle. `services/vfs` itself is
 * store-free, so importing it here is safe.
 *
 * Always call this AFTER the store `set()` that removes the tab, never inside
 * the updater.
 */

import { VfsRegistry } from "../services/vfs";
import type { TabInstance } from "./types";

export function disposeTab(tab: TabInstance): void {
  if (tab.type !== "canvas") return;

  // `VfsRegistry.destroy` had zero callers before this, so every canvas opened
  // in a session kept its VfsInstance alive until quit. Safe to call
  // synchronously: it only deletes a Map entry and does not touch Rust-side
  // state, and every consumer goes through `getOrCreate`, so a late reader
  // degrades to a fresh empty instance rather than throwing.
  VfsRegistry.destroy(tab.id);

  // A pending canvas auto-save is not flushed here. `runAutoSave` already
  // aborts and clears its own bookkeeping when the tab is gone, so nothing
  // leaks -- but edits made inside the debounce window before a close are
  // dropped. That is pre-existing behavior; flushing properly would require
  // `saveCanvasNow` to take a state snapshot instead of reading the live
  // store, which is out of scope here.
}
