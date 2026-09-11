import { resolveTheme } from "../theme";

/**
 * Pure helpers for the persisted theme choice. Mirrors `typography.ts` /
 * `shortcuts.ts` / `shellLayout.ts`'s shape deliberately, including the
 * `typeof localStorage` guard the inline version this replaces
 * (createIntegrationSlice.ts) did not have.
 *
 * Called only from `createIntegrationSlice.hydrateTheme()`, never from the
 * slice initializer -- ARCHITECTURE.md's "slice import-time purity" rule
 * forbids I/O at slice creation (REFACTOR_PLAN.md PR 3a).
 */

export const THEME_STORAGE_KEY = "selected_theme";

/**
 * `null` means "no explicit preference has ever been stored" -- distinct
 * from "a preference was stored but is no longer a valid theme id", which
 * `resolveTheme` silently normalizes to the default. Callers that need to
 * tell those two cases apart (loadSecureConfig's theme-migration branch,
 * which only writes `selected_theme` when this returns null) rely on that
 * distinction; do not collapse it to an always-resolved id here.
 */
export function loadStoredThemeId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const storedThemeId = localStorage.getItem(THEME_STORAGE_KEY);
    return storedThemeId ? resolveTheme(storedThemeId).id : null;
  } catch {
    return null;
  }
}

export function saveThemeId(themeId: string): string {
  const resolvedThemeId = resolveTheme(themeId).id;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, resolvedThemeId);
    } catch {
      // Best-effort persistence; a full localStorage or a disabled store in
      // a private/embedded context should not break theme switching.
    }
  }
  return resolvedThemeId;
}
