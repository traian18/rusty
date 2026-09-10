/**
 * Pure utility functions for the ContextNode.
 *
 * These functions have no React dependencies and are safe to test in
 * isolation. They handle formatting, sanitization, and drag-data parsing.
 */

import type { SearchMatch } from "../../../services/searchService";

/**
 * Builds a default display name for the context node when a file is
 * attached, unless the user has already provided a custom name.
 */
export function getDefaultContextName(fileName: string): string {
  return `Context: ${fileName}`;
}

/**
 * Strips the root path prefix from a file path for display in the UI.
 * Returns the raw path if rootPath is empty or the path doesn't start
 * with the root prefix.
 */
export function formatRelativePath(
  rootPath: string | undefined,
  match: SearchMatch,
): string {
  if (!rootPath) return match.path;
  return match.path.replace(rootPath, "");
}

/**
 * Attempts to parse a drag-and-drop payload from React Flow's data
 * transfer. Returns null if the data is not valid JSON or lacks the
 * required fields.
 */
export function parseDragData(
  rawData: string,
): { path: string; name: string; isDir?: boolean } | null {
  try {
    const data = JSON.parse(rawData);
    if (data && typeof data.path === "string" && typeof data.name === "string") {
      return {
        path: data.path,
        name: data.name,
        isDir: !!data.isDir,
      };
    }
    return null;
  } catch {
    return null;
  }
}
