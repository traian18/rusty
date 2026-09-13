/**
 * Pure helpers for the context drawer's persisted width. Mirrors
 * `preferences/shortcuts.ts`'s shape deliberately.
 *
 * Called only from `createUiSlice.hydrateUi()`, never from the slice
 * initializer: ARCHITECTURE.md's "slice import-time purity" rule forbids I/O
 * at slice creation, which is exactly the rule the code this replaces
 * (`App.tsx`'s lazy `useState(() => localStorage.getItem(...))` initializer)
 * violated.
 */

export type DrawerView = "explorer" | "git";

export const DRAWER_MIN_WIDTH = 200;
export const DRAWER_MAX_WIDTH = 600;
export const DRAWER_DEFAULT_WIDTH = 320;

/**
 * Deliberately a NEW key, not a migration of the old `sidebar_width`: that
 * value meant rail-plus-drawer combined, this one means the drawer alone.
 * Existing users get the default once; the numbers are in the same 200-600
 * band, so the visible difference is negligible.
 */
export const DRAWER_WIDTH_STORAGE_KEY = "rusty_drawer_width";

export function clampDrawerWidth(value: number): number {
  if (!Number.isFinite(value)) return DRAWER_DEFAULT_WIDTH;
  return Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, Math.round(value)));
}

export function loadDrawerWidth(): number {
  if (typeof localStorage === "undefined") return DRAWER_DEFAULT_WIDTH;
  try {
    const raw = localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY);
    if (raw === null) return DRAWER_DEFAULT_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? DRAWER_DEFAULT_WIDTH : clampDrawerWidth(parsed);
  } catch {
    return DRAWER_DEFAULT_WIDTH;
  }
}

export function saveDrawerWidth(width: number): number {
  const clamped = clampDrawerWidth(width);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(clamped));
    }
  } catch {
    // Best-effort persistence; a full localStorage or a disabled store in a
    // private/embedded context should not break the drawer.
  }
  return clamped;
}
