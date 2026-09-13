import { create } from "zustand";
import { createIntegrationSlice } from "../store/slices/createIntegrationSlice";
import type { WorkspaceState } from "../store/types";

/**
 * Composes only createIntegrationSlice. Verified dependency-free at
 * creation time as of REFACTOR_PLAN.md PR 3a's purity fix: it imports
 * `@tauri-apps/api/core` (safe to import under plain node -- `invoke` only
 * touches `window.__TAURI_INTERNALS__` when actually called, never at
 * import time) and `services/skillsService`, but nothing at slice-creation
 * time calls either. `rootPath` is seeded because `loadSkills`/
 * `saveSecureConfig`/`loadSecureConfig` read it via `get()`.
 *
 * Follows src/test/tabTestStore.ts's pattern: never import the composed
 * src/store.ts, and no reset helper -- build a fresh store per test.
 */
export function createIntegrationTestStore(overrides: Partial<WorkspaceState> = {}) {
  return create<WorkspaceState>()((...args) => ({
    rootPath: "",
    ...createIntegrationSlice(...args),
    ...overrides,
  }) as unknown as WorkspaceState);
}
