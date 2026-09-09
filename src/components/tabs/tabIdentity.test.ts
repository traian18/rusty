import { describe, expect, it } from "vitest";
import { sanitizeTabId } from "../nodes/contextNode/helpers";

// Tab identity for a given file is built independently at every call site
// today, in two incompatible formats. This table-driven test pins that
// duplication in place so PR 1's unification (a single canonical-path
// identity function per REFACTOR_PLAN.md's "Tab invariants") shows up as a
// deliberate diff against these expressions rather than a silent behavior
// change discovered later.
//
// Duplicating the expressions here (rather than importing a shared helper)
// is deliberate: there is no shared helper today, and extracting one is
// PR 1's job, not PR 0's.

const SCHEMES = {
  // src/components/FileTree.tsx:157,584,622
  // src/components/SearchPalette.tsx:76
  // src/components/tabs/AgentTab.tsx:556,696
  // src/components/filetree/FileTreePresenter.ts:107,126,148
  // src/components/nodes/contextNode/helpers.ts:14 (sanitizeTabId)
  underscoreSanitized: (path: string) => `file_${path.replace(/[^a-zA-Z0-9]/g, "_")}`,
  // src/services/monacoLspBinding.ts:235
  // src/components/tabs/FileTab.tsx:284
  hyphenRaw: (path: string) => `file-${path}`,
};

describe("tab identity: two live schemes for the same file", () => {
  it("sanitizeTabId is byte-identical to the underscoreSanitized scheme", () => {
    const path = "/Users/x/a b/π.ts";
    expect(sanitizeTabId(path)).toBe(SCHEMES.underscoreSanitized(path));
  });

  it("KNOWN-WRONG (PR 1): the two schemes diverge for the same path, so the same file opens as two tabs depending on entry point", () => {
    const path = "/Users/x/a b/π.ts";
    expect(SCHEMES.underscoreSanitized(path)).not.toBe(SCHEMES.hyphenRaw(path));
  });

  it("KNOWN-WRONG (PR 1): underscoreSanitized is not injective -- unrelated paths can collide", () => {
    expect(SCHEMES.underscoreSanitized("/a/b.ts")).toBe(SCHEMES.underscoreSanitized("/a-b.ts"));
  });

  it("hyphenRaw is injective for these two paths (no collision)", () => {
    expect(SCHEMES.hyphenRaw("/a/b.ts")).not.toBe(SCHEMES.hyphenRaw("/a-b.ts"));
  });
});

describe("tab identity: git-history uses two different id schemes", () => {
  it("KNOWN-WRONG (PR 1): a fixed id and a key-scoped id coexist for git-history tabs", () => {
    // src/components/SourceControl.tsx:175 -- opened with a single fixed id,
    // independent of which repository/file it concerns.
    const fixedId = "git-history";
    // src/components/tabs/FileTab.tsx:205 -- opened with an id scoped to the
    // originating tab's key.
    const scopedId = (tabKey: string) => `git-history-${tabKey}`;

    expect(fixedId).not.toBe(scopedId("some-file-key"));
  });
});
