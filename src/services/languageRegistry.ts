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
 *    language server; "shell" uses the "bash" server). lspKey is always
 *    derived purely from monacoId via `MONACO_TO_LSP` below, never stored
 *    per-rule -- that's what keeps a language's LSP mapping from silently
 *    drifting between two extensions that happen to share one monacoId.
 *
 * Historically `fileTypeService` (monacoId) and `lspService.getLspLanguage`
 * (lspKey) maintained two independent extension maps that drifted: .js/.jsx
 * mapped to monaco "javascript" but lsp "typescript", .sh to monaco "shell"
 * but lsp "bash", .lua/.cs had an lspKey but no monacoId at all (so providers
 * never fired). This module (formerly `lspLanguage.ts`) collapsed both into
 * one table so the two ids can never disagree again.
 *
 * PR 6 commit 2 folds a THIRD previously-independent table --
 * fileTypeService.tsx's own filename/extension `switch` for picking an
 * icon -- onto this same `RULES` table via `iconKey`, for the same reason:
 * a `LanguageRule`'s `iconKey` lives right next to its `extensions`, so
 * adding a new extension can never forget to also pick an icon for it (or
 * vice versa). A single monacoId can appear on more than one rule when the
 * icon should differ by extension even though Monaco doesn't distinguish
 * them -- `.ts`/`.mts`/`.cts` and `.tsx` both resolve to monacoId
 * "typescript", but `.tsx` gets the React icon and the others get the
 * plain TypeScript icon, so they're two separate rules sharing one id.
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

/**
 * Icon identity for a language rule -- a key into fileTypeService.tsx's own
 * icon-component map, kept separate from this file so languageRegistry.ts
 * has zero React/JSX dependency (what makes it cheaply table-testable).
 */
export type IconKey =
  | "react"
  | "typescript"
  | "javascript"
  | "html"
  | "css"
  | "json"
  | "markdown"
  | "python"
  | "java"
  | "rust"
  | "go"
  | "ruby"
  | "php"
  | "cpp"
  | "c"
  | "sql"
  | "shell"
  | "config"
  | "env"
  | "git"
  | "docker"
  | "default";

export interface LanguageRule {
  /** Monaco language id. */
  id: string;
  iconKey: IconKey;
  /** Exact lowercase full-filename matches, checked before extensions. */
  filenames?: string[];
  /** Lowercase filename prefixes (e.g. ".env"), checked before extensions. */
  filenamePrefixes?: string[];
  /** Lowercase extensions, no leading dot. */
  extensions?: string[];
}

/**
 * The one language table. Order does not matter for lookup correctness
 * (`resolveLanguage` checks all filenames, then all prefixes, then all
 * extensions, in that priority order, regardless of array position) --
 * order here is purely for readability, grouped by language family.
 */
const RULES: LanguageRule[] = [
  // Exact filenames
  { id: "dockerfile", iconKey: "docker", filenames: ["dockerfile"] },
  { id: "json", iconKey: "json", filenames: ["package.json", "tsconfig.json", "jsconfig.json"] },
  { id: "ignore", iconKey: "git", filenames: [".gitignore", ".gitconfig", ".gitattributes"] },
  { id: "yaml", iconKey: "docker", filenames: ["docker-compose.yml", "docker-compose.yaml"] },
  { id: "ruby", iconKey: "ruby", filenames: ["gemfile", "gemfile.lock"] },
  { id: "makefile", iconKey: "config", filenames: ["makefile"] },

  // Filename prefixes
  { id: "properties", iconKey: "env", filenamePrefixes: [".env"] },

  // Extensions
  { id: "typescript", iconKey: "react", extensions: ["tsx"] },
  { id: "typescript", iconKey: "typescript", extensions: ["ts", "mts", "cts"] },
  { id: "javascript", iconKey: "react", extensions: ["jsx"] },
  { id: "javascript", iconKey: "javascript", extensions: ["js", "mjs", "cjs"] },
  { id: "html", iconKey: "html", extensions: ["html", "htm", "xhtml"] },
  { id: "css", iconKey: "css", extensions: ["css", "scss", "sass", "less"] },
  { id: "json", iconKey: "json", extensions: ["json"] },
  { id: "markdown", iconKey: "markdown", extensions: ["md", "markdown"] },
  { id: "python", iconKey: "python", extensions: ["py", "pyw"] },
  { id: "java", iconKey: "java", extensions: ["java", "class", "jar"] },
  { id: "rust", iconKey: "rust", extensions: ["rs"] },
  { id: "go", iconKey: "go", extensions: ["go"] },
  { id: "ruby", iconKey: "ruby", extensions: ["rb"] },
  { id: "php", iconKey: "php", extensions: ["php"] },
  { id: "cpp", iconKey: "cpp", extensions: ["cpp", "cc", "cxx", "hpp", "h"] },
  { id: "c", iconKey: "c", extensions: ["c"] },
  { id: "csharp", iconKey: "default", extensions: ["cs"] },
  { id: "lua", iconKey: "default", extensions: ["lua"] },
  { id: "sql", iconKey: "sql", extensions: ["sql", "psql", "sqlite", "sqlite3", "db"] },
  { id: "shell", iconKey: "shell", extensions: ["sh", "bash", "zsh", "fish"] },
  { id: "bat", iconKey: "shell", extensions: ["bat", "cmd", "ps1"] },
  { id: "toml", iconKey: "config", extensions: ["toml"] },
  { id: "yaml", iconKey: "config", extensions: ["yaml", "yml"] },
  { id: "xml", iconKey: "config", extensions: ["xml"] },
  { id: "ini", iconKey: "config", extensions: ["ini", "conf", "config", "lock", "properties"] },
];

const DEFAULT_RULE: LanguageRule = { id: "plaintext", iconKey: "default" };

/** Resolve a filename to its full language rule (id + iconKey). */
export function resolveLanguage(fileName: string): LanguageRule {
  const lower = fileName.toLowerCase();

  for (const rule of RULES) {
    if (rule.filenames?.includes(lower)) return rule;
  }
  for (const rule of RULES) {
    if (rule.filenamePrefixes?.some((prefix) => lower.startsWith(prefix))) return rule;
  }
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  for (const rule of RULES) {
    if (rule.extensions?.includes(ext)) return rule;
  }
  return DEFAULT_RULE;
}

/** Resolve a filename to its Monaco language id (used for Editor `language`). */
export function getMonacoLanguageId(fileName: string): string {
  return resolveLanguage(fileName).id;
}

/** Resolve a filesystem path/filename to its LSP settings key, or null. */
export function getLspKeyFromPath(filePath: string): string | null {
  return getLspKeyFromMonacoId(getMonacoLanguageId(filePath));
}
