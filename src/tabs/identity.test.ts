import { describe, expect, it } from "vitest";
import {
  canonicalizeFilePath,
  canvasTabIdentity,
  fileTabIdentity,
  foldCase,
  gitDiffTabIdentity,
  gitHistoryTabIdentity,
  nextCanvasId,
  nextInstanceId,
  resolveAgainstRoot,
  taskTabIdentity,
} from "./identity";

// Replaces src/components/tabs/tabIdentity.test.ts, which pinned the two
// competing file-id schemes this module retires:
//   `file_${path.replace(/[^a-zA-Z0-9]/g,"_")}`  (file tree, search, agent tab)
//   `file-${path}`                                (LSP go-to-definition)
// Those tests documented the divergence; these assert it is gone.

describe("canonicalizeFilePath", () => {
  it("normalizes backslashes to forward slashes", () => {
    expect(canonicalizeFilePath("\\a\\b\\c.ts")).toBe("/a/b/c.ts");
  });

  it("resolves . and .. segments", () => {
    expect(canonicalizeFilePath("/a/b/../b/./c.ts")).toBe("/a/b/c.ts");
  });

  it("does not escape above an absolute root", () => {
    expect(canonicalizeFilePath("/../../a.ts")).toBe("/a.ts");
  });

  it("preserves leading .. on a relative path", () => {
    expect(canonicalizeFilePath("../a/b.ts")).toBe("../a/b.ts");
  });

  it("upper-cases a Windows drive letter", () => {
    expect(canonicalizeFilePath("c:\\x\\y.ts")).toBe("C:/x/y.ts");
  });

  it("collapses duplicate separators", () => {
    expect(canonicalizeFilePath("/a//b///c.ts")).toBe("/a/b/c.ts");
  });

  it("preserves case", () => {
    expect(canonicalizeFilePath("/A/B/Readme.MD")).toBe("/A/B/Readme.MD");
  });

  it("returns empty string for empty input", () => {
    expect(canonicalizeFilePath("")).toBe("");
  });
});

describe("resolveAgainstRoot", () => {
  it("leaves an absolute path alone", () => {
    expect(resolveAgainstRoot("/a/b.ts", "/root")).toBe("/a/b.ts");
  });

  it("resolves a relative path against the root", () => {
    expect(resolveAgainstRoot("src/b.ts", "/root")).toBe("/root/src/b.ts");
  });

  it("treats a Windows absolute path as absolute", () => {
    expect(resolveAgainstRoot("C:\\x\\y.ts", "/root")).toBe("C:/x/y.ts");
  });
});

describe("fileTabIdentity", () => {
  it("resolves relative, absolute, backslash and dotted forms of one file to one identity", () => {
    const root = "/Users/dev/project";
    const expected = fileTabIdentity("/Users/dev/project/src/a.ts", root, false);

    expect(fileTabIdentity("src/a.ts", root, false)).toBe(expected);
    expect(fileTabIdentity("./src/a.ts", root, false)).toBe(expected);
    expect(fileTabIdentity("src/../src/a.ts", root, false)).toBe(expected);
    expect(fileTabIdentity("\\Users\\dev\\project\\src\\a.ts", root, false)).toBe(expected);
  });

  it("distinguishes paths the old underscore scheme collided", () => {
    // `file_${p.replace(/[^a-zA-Z0-9]/g,"_")}` mapped both of these to
    // `file__a_b_ts`, so two unrelated files shared one tab.
    expect(fileTabIdentity("/a/b.ts", "", false)).not.toBe(fileTabIdentity("/a-b.ts", "", false));
  });

  it("folds case only when asked", () => {
    expect(fileTabIdentity("/A/B.ts", "", true)).toBe(fileTabIdentity("/a/b.ts", "", true));
    expect(fileTabIdentity("/A/B.ts", "", false)).not.toBe(fileTabIdentity("/a/b.ts", "", false));
  });

  it("is namespaced so it cannot collide with another tab type", () => {
    expect(fileTabIdentity("/a.ts", "", false)).toBe("file:/a.ts");
  });
});

describe("foldCase", () => {
  it("only lowercases when the flag is set", () => {
    expect(foldCase("/A/B.ts", true)).toBe("/a/b.ts");
    expect(foldCase("/A/B.ts", false)).toBe("/A/B.ts");
  });
});

describe("git identities", () => {
  it("separates repo-wide history from file-scoped history", () => {
    expect(gitHistoryTabIdentity("/repo", undefined, false)).toBe("git-history:/repo");
    expect(gitHistoryTabIdentity("/repo", "/repo/a.ts", false)).toBe(
      "git-history:/repo:/repo/a.ts",
    );
  });

  it("makes the same file in two repositories two different tabs", () => {
    expect(gitHistoryTabIdentity("/repo-a", "/x/a.ts", false)).not.toBe(
      gitHistoryTabIdentity("/repo-b", "/x/a.ts", false),
    );
  });

  it("distinguishes diff kinds for one file", () => {
    const base = { repoPath: "/repo", path: "/repo/a.ts" } as const;
    const staged = gitDiffTabIdentity({ ...base, diffType: "staged" }, false);
    const unstaged = gitDiffTabIdentity({ ...base, diffType: "unstaged" }, false);
    expect(staged).not.toBe(unstaged);
  });

  it("distinguishes commits for one file", () => {
    const base = { repoPath: "/repo", path: "/repo/a.ts", diffType: "commit" } as const;
    expect(gitDiffTabIdentity({ ...base, commitHash: "aaa" }, false)).not.toBe(
      gitDiffTabIdentity({ ...base, commitHash: "bbb" }, false),
    );
  });

  // REFACTOR_PLAN.md PR 5b commit 25: a pinning test, not a fix -- both
  // identities already key on repoPath (asserted generically above), so a
  // submodule's own file resolving to its submodule's repoPath instead of
  // the parent workspace's should already disambiguate correctly once a
  // caller (FileTab's blame, GitHistoryTabContent, commits 18-19) passes
  // the right repoPath through. This documents that guarantee explicitly
  // for the submodule scenario this PR adds, rather than leaving it as an
  // unstated consequence of the generic "two repositories" case.
  it("disambiguates a submodule file's tabs from the same path viewed at the parent workspace root", () => {
    const submodulePath = "/repo/vendor/lib/a.ts";
    const submoduleRepo = "/repo/vendor/lib";
    const workspaceRoot = "/repo";

    expect(gitHistoryTabIdentity(submoduleRepo, submodulePath, false)).not.toBe(
      gitHistoryTabIdentity(workspaceRoot, submodulePath, false),
    );

    const base = { path: submodulePath, diffType: "unstaged" } as const;
    expect(gitDiffTabIdentity({ ...base, repoPath: submoduleRepo }, false)).not.toBe(
      gitDiffTabIdentity({ ...base, repoPath: workspaceRoot }, false),
    );
  });
});

describe("canvas and task identities", () => {
  it("leaves a canvas id unprefixed", () => {
    // Load-bearing: canvasFileService writes `id: tabId` into
    // .rusty/canvas/*.json and FileTree reads it back as the tab id, so a
    // prefix would accumulate on every save/load round-trip.
    expect(canvasTabIdentity("canvas_3")).toBe("canvas_3");
  });

  it("scopes a task to its canvas", () => {
    expect(taskTabIdentity("canvas_1", "node_9")).toBe("task:canvas_1:node_9");
    expect(taskTabIdentity("canvas_1", "node_9")).not.toBe(taskTabIdentity("canvas_2", "node_9"));
  });
});

describe("deterministic id allocation", () => {
  it("allocates canvas ids without collisions and without Date.now()", () => {
    // The previous `canvas_${Date.now()}` collided whenever two canvases were
    // created inside one millisecond, which PR 0 pinned under fake timers.
    expect(nextCanvasId([])).toBe("canvas_1");
    expect(nextCanvasId(["canvas_1"])).toBe("canvas_2");
    expect(nextCanvasId(["canvas_1", "canvas_7"])).toBe("canvas_8");
  });

  it("ignores ids that do not match the numeric pattern", () => {
    expect(nextCanvasId(["canvas", "canvas_abc", "file:/a.ts"])).toBe("canvas_1");
  });

  it("allocates instance ids per type", () => {
    expect(nextInstanceId("agent", ["agent_1", "agent_2"])).toBe("agent_3");
    expect(nextInstanceId("agent", ["canvas_9"])).toBe("agent_1");
  });
});
