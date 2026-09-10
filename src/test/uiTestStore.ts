import { create } from "zustand";
import { createUiSlice } from "../store/slices/createUiSlice";
import type { WorkspaceState } from "../store/types";

/**
 * Composes only createUiSlice, which is dependency-free at creation time: it
 * imports nothing but the pure `preferences/shellLayout` module. No Tauri
 * invoke, no localStorage read at creation (see the comment on
 * `drawerWidth` in createUiSlice.ts).
 *
 * Follows the pattern in `src/test/tabTestStore.ts`: never import the
 * composed `src/store.ts` in a test, and no reset helper -- build a fresh
 * store per test instead.
 */
export function createUiTestStore(overrides: Partial<WorkspaceState> = {}) {
  return create<WorkspaceState>()((...args) => ({
    ...createUiSlice(...args),
    ...overrides,
  }) as unknown as WorkspaceState);
}
