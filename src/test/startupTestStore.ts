import { create } from "zustand";
import { createStartupSlice } from "../store/slices/createStartupSlice";
import type { WorkspaceState } from "../store/types";

/** Composes only createStartupSlice, which has zero dependencies -- no
 * localStorage, no Tauri, no services -- so no overrides are ever needed. */
export function createStartupTestStore(overrides: Partial<WorkspaceState> = {}) {
  return create<WorkspaceState>()((...args) => ({
    ...createStartupSlice(...args),
    ...overrides,
  }) as unknown as WorkspaceState);
}
