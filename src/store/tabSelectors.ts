/**
 * Read-side accessors for the open-tab collection.
 *
 * These exist so consumers stop reaching into the tab storage shape directly.
 *
 * All of these return primitives or references into existing state, so they
 * are safe to subscribe to directly as zustand selectors.
 */

import type { TabInstance } from "../tabs/types";
import type { WorkspaceState } from "./types";

type TabReadState = Pick<WorkspaceState, "tabs" | "activeTabId">;

/** Every open tab, in visual order. */
export function selectAllTabs(state: TabReadState): TabInstance[] {
  return state.tabs;
}

export function selectActiveTabId(state: TabReadState): string | null {
  return state.activeTabId;
}

export function selectActiveTab(state: TabReadState): TabInstance | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTabId);
}

export function selectTabById(state: TabReadState, tabId: string): TabInstance | undefined {
  return state.tabs.find((tab) => tab.id === tabId);
}

/** The file path of the active tab, when the active tab is a file. */
export function selectActiveFilePath(state: TabReadState): string | undefined {
  const activeTab = selectActiveTab(state);
  return activeTab?.type === "file" ? activeTab.path : undefined;
}
