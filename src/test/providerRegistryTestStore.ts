import { create } from "zustand";
import { createProviderRegistrySlice } from "../store/slices/createProviderRegistrySlice";
import type { WorkspaceState } from "../store/types";

/** Composes only createProviderRegistrySlice, which has zero dependencies
 * -- no localStorage, no Tauri, no services -- so no overrides are ever
 * needed. Mirrors src/test/startupTestStore.ts's own comment for
 * createStartupSlice, its closest sibling in shape. */
export function createProviderRegistryTestStore(overrides: Partial<WorkspaceState> = {}) {
  return create<WorkspaceState>()((...args) => ({
    ...createProviderRegistrySlice(...args),
    ...overrides,
  }) as unknown as WorkspaceState);
}
