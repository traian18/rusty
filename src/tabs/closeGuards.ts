/**
 * Close guards: pure evaluation of "may this tab close right now?".
 *
 * The guard never blocks and never awaits — it returns a value describing what
 * the user must confirm, and the view decides how to render that. This is what
 * lets every close path (tab X, overflow menu, keyboard shortcut) share one
 * decision instead of the old arrangement, where the guard lived inside a
 * handler that `Workspace` injected into `TabBar` and the keyboard shortcut
 * bypassed entirely.
 */

import { closeGuardFor, getTabPolicy } from "./policy";
import type { CloseGuard, TabDomainState, TabInstance } from "./types";

export interface CloseEvaluationState extends TabDomainState {
  tabs: TabInstance[];
}

export function evaluateClose(state: CloseEvaluationState, tabId: string): CloseGuard {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  // Nothing to guard: closing an unknown tab is a no-op the slice will ignore.
  if (!tab) return { kind: "allow" };
  return closeGuardFor(tab, state);
}

/** Whether the policy permits closing this tab type at all. */
export function isClosable(tab: TabInstance): boolean {
  return getTabPolicy(tab.type).closable;
}
