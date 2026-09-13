/**
 * Single source of truth for language identity in Rusty (REFACTOR_PLAN.md
 * PR 6) -- used by editor language selection, file icons (fileTypeService.tsx),
 * inline chat's editor context, and LSP mapping.
 *
 * Two distinct "language" identifiers are in play:
 *
 *  - `monacoId`: the string Monaco uses to register language features
 *    (e.g. "typescript", "javascript", "shell", "java"). Monaco providers
 *    are registered against this id and only fire for models whose
 *    `getLanguageId()` matches.
 *
 *  - `lspKey`: the key into `lspSettings.servers` (e.g. "typescript",
 *    "python", "bash"). A single lspKey can back multiple monacoIds
 *    (e.g. both "typescript" and "javascript" use the "typescript"
 *    language server; "shell" uses the "bash" server).
 *
 * Historically `fileTypeService` (monacoId) and `lspService.getLspLanguage`
 * (lspKey) maintained two independent extension maps that drifted: .js/.jsx
 * mapped to monaco "javascript" but lsp "typescript", .sh to monaco "shell"
 * but lsp "bash", .lua/.cs had an lspKey but no monacoId at all (so providers
 * never fired). This module (formerly `lspLanguage.ts`) collapsed both into
 * one table so the two ids can never disagree again -- PR 6 commit 1 is a
 * pure rename/move, no behavior change; commit 2 folds fileTypeService.tsx's
 * previously-independent icon-picking switch onto this same table too, and
 * commit 3 expands language coverage on top of that.
 */

/** Languages we ship a bundled/configured LSP server for. */
export const LSP_SETTINGS_KEYS = new Set<string>([
  "typescript",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "lua",
  "bash",
  "json",
  "yaml",
  "html",
  "css",
]);

/**
 * monacoId -> lspKey. Every monacoId that should be backed by an LSP server
 * appears here; anything not listed has no LSP (e.g. markdown, sql, ini).
 */
const MONACO_TO_LSP: Record<string, string> = {
  typescript: "typescript",
  javascript: "typescript",
  java: "java",
  python: "python",
  go: "go",
  rust: "rust",
  c: "c",
  cpp: "cpp",
  csharp: "csharp",
  ruby: "ruby",
  php: "php",
  lua: "lua",
  shell: "bash",
  json: "json",
  yaml: "yaml",
  html: "html",
  css: "css",
};

/** Map a Monaco language id to its LSP settings key, or null if none. */
export function getLspKeyFromMonacoId(monacoId: string): string | null {
  return MONACO_TO_LSP[monacoId] ?? null;
}

/** True if this Monaco language id is one we manage an LSP server for. */
export function isLspMonacoId(monacoId: string): boolean {
  const k = getLspKeyFromMonacoId(monacoId);
  return k !== null && LSP_SETTINGS_KEYS.has(k);
}

/** Resolve a filename to its Monaco language id (used for Editor `language`). */
export function getMonacoLanguageId(fileName: string): string {
  const lower = fileName.toLowerCase();

  if (lower === "dockerfile") return "dockerfile";
  if (lower === "package.json" || lower === "tsconfig.json" || lower === "jsconfig.json") return "json";
  if (lower === ".gitignore" || lower === ".gitconfig" || lower === ".gitattributes") return "ignore";
  if (lower === "docker-compose.yml" || lower === "docker-compose.yaml") return "yaml";
  if (lower === "gemfile" || lower === "gemfile.lock") return "ruby";
  if (lower === "makefile") return "makefile";
  if (lower.startsWith(".env")) return "properties";

  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "tsx":
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "jsx":
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "html":
    case "htm":
    case "xhtml":
      return "html";
    case "css":
    case "scss":
    case "sass":
    case "less":
      return "css";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "py":
    case "pyw":
      return "python";
    case "java":
    case "class":
    case "jar":
      return "java";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "rb":
      return "ruby";
    case "php":
      return "php";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "h":
      return "cpp";
    case "c":
      return "c";
    case "cs":
      return "csharp";
    case "lua":
      return "lua";
    case "sql":
    case "psql":
    case "sqlite":
    case "sqlite3":
    case "db":
      return "sql";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return "shell";
    case "bat":
    case "cmd":
    case "ps1":
      return "bat";
    case "toml":
      return "toml";
    case "yaml":
    case "yml":
      return "yaml";
    case "xml":
      return "xml";
    case "ini":
    case "conf":
    case "config":
    case "lock":
    case "properties":
      return "ini";
    default:
      return "plaintext";
  }
}

/** Resolve a filesystem path/filename to its LSP settings key, or null. */
export function getLspKeyFromPath(filePath: string): string | null {
  const monacoId = getMonacoLanguageId(filePath);
  return getLspKeyFromMonacoId(monacoId);
}
