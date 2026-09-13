import React from "react";
import { RotateCcw } from "lucide-react";

/**
 * Per-tab crash fallback (REFACTOR_PLAN.md PR 7 commit 5) -- a crash in
 * one tab's component no longer takes down every other tab, unlike before
 * this commit (the app had exactly one ErrorBoundary, wrapping the whole
 * tree, in main.tsx). Panel-shaped, not full-viewport: it renders inside
 * the crashed tab's own slot in TabOutlet, which already sizes/positions
 * it -- that slot's own `key={tab.id}` is what gives each tab's boundary a
 * fresh instance, so no separate reset-key plumbing was needed here.
 *
 * Kept in its own (non-CSS-Module) file rather than inline in
 * TabOutlet.tsx: TabOutlet.tsx is a "migrated" component this repo's
 * theme-usage check requires keep ALL presentation in its own CSS Module
 * (components/workspace/TabOutlet.module.css) -- this file follows the
 * same plain-utility-class convention every other tab component still
 * uses instead.
 */
export const TabCrashFallback: React.FC<{ error: Error; reset: () => void }> = ({ error, reset }) => (
  <div className="w-full h-full flex flex-col items-center justify-center gap-3 font-mono text-xs text-[var(--text-muted)] bg-[var(--bg-app)] p-6 select-text">
    <span className="text-[var(--color-status-danger)] font-bold text-sm">This tab crashed</span>
    <div className="max-w-lg w-full bg-[var(--color-surface-sunken)] border border-[var(--color-status-danger-border)] rounded-lg p-3 text-[10px] text-[var(--color-status-danger)] overflow-x-auto whitespace-pre-wrap max-h-40">
      {error.toString()}
    </div>
    <button
      type="button"
      onClick={reset}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-color)] hover:border-[var(--border-active)] text-[var(--text-normal)] hover:text-[var(--text-light)] cursor-pointer transition-colors"
    >
      <RotateCcw size={12} />
      <span>Try again</span>
    </button>
  </div>
);
