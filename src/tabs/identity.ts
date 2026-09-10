/**
 * Canonical tab identities.
 *
 * Before this module, a file tab's id was built inline at nine call sites in
 * two mutually incompatible formats — `file_${path.replace(/[^a-zA-Z0-9]/g,"_")}`
 * (file tree, search palette, agent tab, context node) and `file-${path}`
 * (LSP go-to-definition, in-editor navigation). Opening one file from two
 * entry points produced two tabs, and the underscore scheme was not even
 * injective: `/a/b.ts` and `/a-b.ts` both collapsed to `_a_b_ts`.
 */

import type { DiffKind } from "./types";

/**
 * Normalizes a path for comparison: forward slashes, upper-cased Windows
 * drive letter, and `.`/`..` segments resolved. Case is preserved — see
 * `foldCase` for why that matters.
 */
export function canonicalizeFilePath(raw: string): string {
  if (!raw) return "";

  let path = raw.replace(/\\/g, "/");

  const drive = /^([a-zA-Z]):\//.exec(path);
  if (drive) path = `${drive[1].toUpperCase()}:${path.slice(2)}`;

  const prefix = drive ? path.slice(0, 3) : path.startsWith("/") ? "/" : "";
  const isAbsolute = prefix !== "";

  const segments: string[] = [];
  for (const segment of path.slice(prefix.length).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!isAbsolute) {
        segments.push("..");
      }
      continue;
    }
    segments.push(segment);
  }

  return prefix + segments.join("/");
}

/**
 * Case folding is an IDENTITY concern only, never applied to a stored path.
 *
 * `TabInstance.path` stays case-preserving because it is handed straight to
 * `invoke("read_file_disk")`, `git_blame`, `monaco.Uri.parse("file://…")` and
 * `revealFileInTree`. Lower-casing it would break every one of those on a
 * case-preserving filesystem (which macOS's default APFS is, despite being
 * case-insensitive for lookups).
 */
export function foldCase(path: string, caseInsensitive: boolean): string {
  return caseInsensitive ? path.toLowerCase() : path;
}

/**
 * macOS (APFS default) and Windows are case-insensitive; Linux is not.
 * Returns false when `navigator` is absent so Node-environment tests are
 * deterministic without stubbing globals.
 */
export function isCaseInsensitiveFs(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|Win/i.test(navigator.userAgent);
}

function isAbsolutePath(canonical: string): boolean {
  return canonical.startsWith("/") || /^[A-Z]:\//.test(canonical);
}

/** Resolves a possibly-relative path against the workspace root. */
export function resolveAgainstRoot(path: string, rootPath: string): string {
  const canonical = canonicalizeFilePath(path);
  if (!rootPath || isAbsolutePath(canonical)) return canonical;
  return canonicalizeFilePath(`${canonicalizeFilePath(rootPath)}/${canonical}`);
}

export function fileTabIdentity(
  path: string,
  rootPath = "",
  caseInsensitive = isCaseInsensitiveFs(),
): string {
  return `file:${foldCase(resolveAgainstRoot(path, rootPath), caseInsensitive)}`;
}

export function gitHistoryTabIdentity(
  repoPath: string,
  path?: string,
  caseInsensitive = isCaseInsensitiveFs(),
): string {
  const repo = foldCase(canonicalizeFilePath(repoPath), caseInsensitive);
  if (!path) return `git-history:${repo}`;
  return `git-history:${repo}:${foldCase(canonicalizeFilePath(path), caseInsensitive)}`;
}

export function gitDiffTabIdentity(
  args: { repoPath: string; path: string; diffType: DiffKind; commitHash?: string },
  caseInsensitive = isCaseInsensitiveFs(),
): string {
  const repo = foldCase(canonicalizeFilePath(args.repoPath), caseInsensitive);
  const path = foldCase(canonicalizeFilePath(args.path), caseInsensitive);
  return `git-diff:${repo}:${path}:${args.diffType}:${args.commitHash ?? ""}`;
}

export function taskTabIdentity(canvasId: string, taskNodeId: string): string {
  return `task:${canvasId}:${taskNodeId}`;
}

/**
 * Canvas identity is the raw canvas id, deliberately UNPREFIXED.
 *
 * This is load-bearing: `canvasFileService` writes `id: tabId` into
 * `.rusty/canvas/*.json`, and `FileTree` reads that value back as the tab id
 * when a saved canvas is re-opened. A prefix here would accumulate on every
 * save/load round-trip and orphan the files. It also keeps `canvasContexts`
 * keys, VFS tab ids, `__reconciliation__:${tabId}` node ids and the
 * `rf-canvas-${tab.id}` DOM id byte-identical to what they are today.
 */
export function canvasTabIdentity(canvasId: string): string {
  return canvasId;
}

function maxNumericSuffix(prefix: string, existing: readonly string[]): number {
  let highest = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of existing) {
    const match = pattern.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/**
 * Allocates the next canvas id. Deterministic (no `Date.now()`), so it cannot
 * collide under frozen timers — which is exactly the defect PR 0 pinned, where
 * two canvases created in the same millisecond shared an id.
 */
export function nextCanvasId(existing: readonly string[]): string {
  return `canvas_${maxNumericSuffix("canvas_", existing) + 1}`;
}

/** Instance id allocator for `multiple` uniqueness. Deterministic, as above. */
export function nextInstanceId(type: string, existing: readonly string[]): string {
  return `${type}_${maxNumericSuffix(`${type}_`, existing) + 1}`;
}
