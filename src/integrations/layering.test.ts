import { describe, expect, it } from "vitest";

/**
 * Mirrors src/startup/layering.test.ts's argument, for the same reason:
 * schedule.ts's cadence function has to be testable as a pure function of a
 * status map and a clock, under vitest's plain `environment: "node"`, with
 * no mocking. This is what keeps src/integrations/ that way -- nothing
 * here may import the composed store, a service, or React. The coordinator
 * (coordinator.ts, a later commit) that actually owns timers and writes
 * into the store lives here too, but only ever *calls into* the store via
 * injected get/set functions, never imports "../store" or "../services"
 * itself -- see coordinator.ts's own module comment once it lands.
 */

const sources: Record<string, string> = import.meta.glob("./*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const INTEGRATIONS_FILES = Object.entries(sources).filter(([file]) => !/\.test\.tsx?$/.test(file));

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

function offendersMatching(predicate: (specifier: string) => boolean): string[] {
  return INTEGRATIONS_FILES.filter(([, source]) => importSpecifiers(source).some(predicate)).map(
    ([file]) => file,
  );
}

describe("integrations layering", () => {
  it("finds the files it is meant to police", () => {
    expect(INTEGRATIONS_FILES.length).toBeGreaterThan(0);
    expect(INTEGRATIONS_FILES.some(([file]) => file.endsWith("registryTypes.ts"))).toBe(true);
  });

  it("keeps React out of src/integrations/", () => {
    expect(
      offendersMatching((s) => s === "react" || s.startsWith("react/") || s === "react-dom"),
    ).toEqual([]);
  });

  it("keeps the composed store out of src/integrations/'s import graph", () => {
    expect(offendersMatching((s) => s.includes("../store"))).toEqual([]);
  });

  it("keeps services (Tauri invoke, fetch-based clients) out of src/integrations/", () => {
    expect(offendersMatching((s) => s.includes("../services"))).toEqual([]);
  });
});
