import { describe, expect, it } from "vitest";

/**
 * The startup executor (runStartup.ts) has to run under vitest's plain
 * `environment: "node"` (vitest.config.ts) with fake steps and no mocking --
 * that's the whole point of keeping it a pure, dependency-injected module,
 * mirroring src/tabs/layering.test.ts's argument for keeping the store out
 * of the view. This test is what keeps it that way: nothing under
 * src/startup/ may import the composed store, a service, or React. Steps
 * that DO need the store or services (createStartupSlice.ts's step
 * registry, wired up in a later commit) live outside this directory and
 * import runStartup, not the other way around.
 *
 * Uses Vite's `import.meta.glob` rather than `node:fs` for the same reason
 * src/tabs/layering.test.ts does: the root project has no `@types/node`.
 */

const sources: Record<string, string> = import.meta.glob("./*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const EXECUTOR_FILES = Object.entries(sources).filter(([file]) => !/\.test\.tsx?$/.test(file));

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

function offendersMatching(predicate: (specifier: string) => boolean): string[] {
  return EXECUTOR_FILES.filter(([, source]) => importSpecifiers(source).some(predicate)).map(
    ([file]) => file,
  );
}

describe("startup executor layering", () => {
  it("finds the files it is meant to police", () => {
    expect(EXECUTOR_FILES.length).toBeGreaterThan(0);
    expect(EXECUTOR_FILES.some(([file]) => file.endsWith("runStartup.ts"))).toBe(true);
  });

  it("keeps React out of the executor", () => {
    expect(
      offendersMatching((s) => s === "react" || s.startsWith("react/") || s === "react-dom"),
    ).toEqual([]);
  });

  it("keeps the composed store out of the executor's import graph", () => {
    expect(offendersMatching((s) => s.includes("../store"))).toEqual([]);
  });

  it("keeps services (Tauri invoke, fetch-based clients) out of the executor", () => {
    expect(offendersMatching((s) => s.includes("../services"))).toEqual([]);
  });
});
