import { describe, expect, it } from "vitest";

/**
 * Enforces the layering rule the tab registry is built around (ARCHITECTURE.md):
 * the store may declare tab BEHAVIOR but must never reach into the view.
 *
 * The registry is split into two tables keyed by the same TabType — `policy.ts`
 * (store-side) and `views.tsx` (view-side). Without this test, someone adding
 * an `icon` or a `render` field to a policy would quietly pull all 13 tab
 * components into the store's import graph, which is exactly what makes the
 * store untestable under a bare Node environment.
 *
 * Uses Vite's `import.meta.glob` rather than `node:fs` so the root project does
 * not need `@types/node`, which would make Node globals visible to browser code.
 */

const sources: Record<string, string> = {
  ...import.meta.glob("../store/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("./*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
};

const STORE_SIDE = Object.entries(sources).filter(([file]) => {
  if (/\.test\.tsx?$/.test(file)) return false;
  // views.tsx is the view-side half of the registry; it is *supposed* to
  // import React and every tab component.
  if (file.endsWith("/views.tsx")) return false;
  return true;
});

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

function offendersMatching(predicate: (specifier: string) => boolean): string[] {
  return STORE_SIDE.filter(([, source]) => importSpecifiers(source).some(predicate)).map(
    ([file]) => file,
  );
}

describe("tab system layering", () => {
  it("finds the files it is meant to police", () => {
    // Guards against the glob silently matching nothing and the whole suite
    // passing vacuously.
    expect(STORE_SIDE.length).toBeGreaterThan(5);
    expect(STORE_SIDE.some(([file]) => file.endsWith("tabs/policy.ts") || file === "./policy.ts")).toBe(
      true,
    );
  });

  it("keeps React out of the store and the store-side tab modules", () => {
    expect(
      offendersMatching((s) => s === "react" || s.startsWith("react/") || s === "react-dom"),
    ).toEqual([]);
  });

  it("keeps the view-side render table out of the store's import graph", () => {
    expect(offendersMatching((s) => s.endsWith("/views") || s.endsWith("tabs/views"))).toEqual([]);
  });

  it("keeps the policy table free of service imports", () => {
    // Non-store cleanup lives in effects.ts instead, so the policy table
    // cannot create a store -> policy -> service -> store runtime cycle.
    const policy = STORE_SIDE.find(([file]) => file.endsWith("policy.ts"));
    expect(policy).toBeDefined();
    expect(importSpecifiers(policy![1]).filter((s) => s.includes("services/"))).toEqual([]);
  });
});
