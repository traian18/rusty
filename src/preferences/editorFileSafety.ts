/**
 * Editor file-safety preferences (REFACTOR_PLAN.md PR 6): today just the
 * large-file threshold above which FileTab.tsx opens a file read-only with
 * LSP disabled instead of the normal editable path (see
 * check_file_open_safety, src-tauri/src/lib.rs). Mirrors
 * src/preferences/typography.ts's load/save/normalize/hydrate shape
 * exactly -- a user preference, not a hardcoded constant, was an explicit
 * decision for this PR.
 */

export interface EditorFileSafetyPreferences {
  /** Files at or below this size open normally; above it, read-only with
      LSP disabled (still opens -- see PR 6's design decision to force a
      safe mode rather than truncate/stream content). */
  largeFileThresholdBytes: number;
}

export type EditorFileSafetyPreferenceKey = keyof EditorFileSafetyPreferences;

export const EDITOR_FILE_SAFETY_STORAGE_KEY = "rusty_editor_file_safety_preferences";
export const EDITOR_FILE_SAFETY_STORAGE_VERSION = 1;

const MB = 1024 * 1024;

export const EDITOR_FILE_SAFETY_DEFAULTS: EditorFileSafetyPreferences = {
  largeFileThresholdBytes: 5 * MB,
};

export const EDITOR_FILE_SAFETY_LIMITS: Record<
  EditorFileSafetyPreferenceKey,
  { min: number; max: number; step: number }
> = {
  largeFileThresholdBytes: { min: 1 * MB, max: 50 * MB, step: 1 * MB },
};

function clampPreference(key: EditorFileSafetyPreferenceKey, value: unknown): number {
  const fallback = EDITOR_FILE_SAFETY_DEFAULTS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const { min, max } = EDITOR_FILE_SAFETY_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeEditorFileSafetyPreferences(value: unknown): EditorFileSafetyPreferences {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const stored = record.preferences && typeof record.preferences === "object"
    ? (record.preferences as Record<string, unknown>)
    : record;

  return {
    largeFileThresholdBytes: clampPreference("largeFileThresholdBytes", stored.largeFileThresholdBytes),
  };
}

export function loadEditorFileSafetyPreferences(): EditorFileSafetyPreferences {
  if (typeof localStorage === "undefined") return { ...EDITOR_FILE_SAFETY_DEFAULTS };
  try {
    const raw = localStorage.getItem(EDITOR_FILE_SAFETY_STORAGE_KEY);
    return raw ? normalizeEditorFileSafetyPreferences(JSON.parse(raw)) : { ...EDITOR_FILE_SAFETY_DEFAULTS };
  } catch {
    return { ...EDITOR_FILE_SAFETY_DEFAULTS };
  }
}

export function saveEditorFileSafetyPreferences(
  preferences: EditorFileSafetyPreferences,
): EditorFileSafetyPreferences {
  const normalized = normalizeEditorFileSafetyPreferences(preferences);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(
      EDITOR_FILE_SAFETY_STORAGE_KEY,
      JSON.stringify({ version: EDITOR_FILE_SAFETY_STORAGE_VERSION, preferences: normalized }),
    );
  }
  return normalized;
}
