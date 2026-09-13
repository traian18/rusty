import {
  loadTypographyPreferences,
  saveTypographyPreferences,
  TYPOGRAPHY_DEFAULTS,
  type TypographyPreferences,
} from "../../preferences/typography";
import {
  loadKeyboardShortcuts,
  saveKeyboardShortcuts,
  SHORTCUT_DEFAULTS,
  type ShortcutAction,
} from "../../preferences/shortcuts";
import {
  loadEditorFileSafetyPreferences,
  saveEditorFileSafetyPreferences,
  EDITOR_FILE_SAFETY_DEFAULTS,
} from "../../preferences/editorFileSafety";
import type { WorkspaceSliceCreator } from "../sliceTypes";

/**
 * Both preferences initialize to constants and are hydrated from
 * localStorage only via hydrateTypography()/hydrateShortcuts(), called from
 * main.tsx before createRoot -- never at slice-creation time. This was one
 * of three creation-time I/O violations of ARCHITECTURE.md's "slice
 * import-time purity" rule (the other two: createIntegrationSlice.ts's
 * theme/MCP reads, createMetricsSlice.ts's agentHarnessClient touch), and
 * the only one left undocumented there (REFACTOR_PLAN.md PR 3a).
 */
export const createPreferencesSlice: WorkspaceSliceCreator = (set) => ({
  typographyPreferences: { ...TYPOGRAPHY_DEFAULTS },
  setTypographyPreference: (key: keyof TypographyPreferences, value: number) => set((state) => ({
    typographyPreferences: saveTypographyPreferences({
      ...state.typographyPreferences,
      [key]: value,
    }),
  })),
  resetTypographyPreferences: () => set({
    typographyPreferences: saveTypographyPreferences({ ...TYPOGRAPHY_DEFAULTS }),
  }),
  hydrateTypography: () => set({ typographyPreferences: loadTypographyPreferences() }),

  keyboardShortcuts: { ...SHORTCUT_DEFAULTS },
  setKeyboardShortcut: (action: ShortcutAction, shortcut: string) => set((state) => ({
    keyboardShortcuts: saveKeyboardShortcuts({
      ...state.keyboardShortcuts,
      [action]: shortcut,
    }),
  })),
  resetKeyboardShortcuts: () => set({
    keyboardShortcuts: saveKeyboardShortcuts({ ...SHORTCUT_DEFAULTS }),
  }),
  hydrateShortcuts: () => set({ keyboardShortcuts: loadKeyboardShortcuts() }),

  editorFileSafety: { ...EDITOR_FILE_SAFETY_DEFAULTS },
  setLargeFileThresholdBytes: (bytes: number) => set((state) => ({
    editorFileSafety: saveEditorFileSafetyPreferences({
      ...state.editorFileSafety,
      largeFileThresholdBytes: bytes,
    }),
  })),
  resetEditorFileSafety: () => set({
    editorFileSafety: saveEditorFileSafetyPreferences({ ...EDITOR_FILE_SAFETY_DEFAULTS }),
  }),
  hydrateEditorFileSafety: () => set({ editorFileSafety: loadEditorFileSafetyPreferences() }),
});
