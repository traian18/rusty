/**
 * Read-side accessors for the open-tab collection.
 *
 * These exist so consumers stop reaching into the tab storage shape directly.
 * They are currently implemented over `editorGroups`, and become one-liners
 * over the flat `tabs` array once the store swap lands — without their callers
 * changing.
 *
 * Reference stability matters here, because these feed zustand selectors:
 * `selectActiveTabId` returns a primitive and `selectActiveTab` / `selectTabById`
 * return references into existing arrays, so all three are safe to subscribe to
 * directly. `selectAllTabs` builds a NEW array on every call and must not be —
 * subscribe to `editorGroups` and call it, or wrap it in a shallow comparator.
 */

import type { Tab, WorkspaceState } from "./types";

type TabReadState = Pick<WorkspaceState, "editorGroups" | "activeGroupId">;

/** Every open tab, in visual order. New array per call — see the note above. */
export function selectAllTabs(state: TabReadState): Tab[] {
  return state.editorGroups.flatMap((group) => group.openTabs);
}

export function selectActiveTabId(state: TabReadState): string | null {
  const activeGroup = state.editorGroups.find((group) => group.id === state.activeGroupId);
  return activeGroup?.activeTabId ?? null;
}

export function selectActiveTab(state: TabReadState): Tab | undefined {
  const activeGroup = state.editorGroups.find((group) => group.id === state.activeGroupId);
  if (!activeGroup?.activeTabId) return undefined;
  return activeGroup.openTabs.find((tab) => tab.id === activeGroup.activeTabId);
}

export function selectTabById(state: TabReadState, tabId: string): Tab | undefined {
  for (const group of state.editorGroups) {
    const tab = group.openTabs.find((candidate) => candidate.id === tabId);
    if (tab) return tab;
  }
  return undefined;
}

/** The file path of the active tab, when the active tab is a file. */
export function selectActiveFilePath(state: TabReadState): string | undefined {
  const activeTab = selectActiveTab(state);
  return activeTab?.type === "file" ? activeTab.key : undefined;
}
