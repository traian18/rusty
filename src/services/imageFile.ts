/**
 * Detects image files for FileTab's preview branch, and maps an extension
 * to the MIME type its base64 content needs for a `data:` URL.
 *
 * Kept separate from languageRegistry.ts's own `image` iconKey rule
 * (extensions live in both places) because the two answer different
 * questions: languageRegistry resolves a Monaco language id an image file
 * will never actually be loaded with, while this module's `isImageFile`
 * is FileTab's actual "read bytes and render an <img>, don't call Monaco
 * at all" branch condition. Duplicating the extension list here rather
 * than deriving it from languageRegistry keeps this module free of a
 * dependency on Monaco-facing types for what is otherwise a two-line check.
 */

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  tif: "image/tiff",
};

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dotIndex = base.lastIndexOf(".");
  return dotIndex === -1 ? "" : base.slice(dotIndex + 1).toLowerCase();
}

export function isImageFile(path: string): boolean {
  return extensionOf(path) in IMAGE_MIME_TYPES;
}

/** Falls back to a generic binary type -- callers only reach this after
    `isImageFile` has already confirmed the extension is recognized, so the
    fallback is just defensive, never expected to fire. */
export function getImageMimeType(path: string): string {
  return IMAGE_MIME_TYPES[extensionOf(path)] ?? "application/octet-stream";
}
