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
  | "kotlin"
  | "scala"
  | "swift"
  | "fsharp"
  | "objectivec"
  | "dart"
  | "r"
  | "powershell"
  | "hcl"
  | "graphql"
  | "protobuf"
  | "image"
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
  /**
   * Shebang interpreter basenames (e.g. "python3", "bash", "node") this
   * rule also matches -- only consulted by `resolveLanguage` when nothing
   * else matched AND a first line of file content was supplied, since a
   * shebang can't be checked from a filename alone. `#!/usr/bin/env X`
   * resolves to `X`, not `env`; a trailing version number (`python3.11`)
   * is also tried stripped, so a bare entry like "python" matches both
   * "python3" and "python3.11".
   */
  shebangInterpreters?: string[];
}

/**
 * The one language table. Order does not matter for lookup correctness
 * (`resolveLanguage` checks all filenames, then all prefixes, then all
 * extensions, in that priority order, regardless of array position) --
 * order here is purely for readability, grouped by language family.
 *
 * Deliberately absent: Vue (`.vue`) and Svelte (`.svelte`). REFACTOR_PLAN.md's
 * PR 6 checklist itself only asks for these "where Monaco tokenization
 * support is available" -- confirmed directly that this installed
 * monaco-editor build has no dedicated tokenizer for either (no `vue`/
 * `svelte` entry in its basic-languages set, and no core language module
 * for them either). A `.vue`/`.svelte` file falls through to the default
 * "plaintext" rule below, the same honest fallback every other
 * Monaco-unsupported extension gets -- not a gap, a documented decision.
 */
const RULES: LanguageRule[] = [
  // Exact filenames
  { id: "dockerfile", iconKey: "docker", filenames: ["dockerfile"] },
  { id: "json", iconKey: "json", filenames: ["package.json", "tsconfig.json", "jsconfig.json"] },
  { id: "ignore", iconKey: "git", filenames: [".gitignore", ".gitconfig", ".gitattributes"] },
  { id: "yaml", iconKey: "docker", filenames: ["docker-compose.yml", "docker-compose.yaml"] },
  { id: "ruby", iconKey: "ruby", filenames: ["gemfile", "gemfile.lock"] },
  // Monaco has no "makefile" tokenizer (confirmed directly: no such
  // directory in the installed monaco-editor's basic-languages set) --
  // resolves to "plaintext" explicitly rather than claiming an id Monaco
  // doesn't recognize, which silently fell back to no highlighting anyway.
  { id: "plaintext", iconKey: "config", filenames: ["makefile"] },
  // Same reasoning: no dedicated "cmake" tokenizer either.
  { id: "plaintext", iconKey: "config", filenames: ["cmakelists.txt"], extensions: ["cmake"] },

  // Filename prefixes
  { id: "properties", iconKey: "env", filenamePrefixes: [".env"] },

  // Extensions
  { id: "typescript", iconKey: "react", extensions: ["tsx"] },
  { id: "typescript", iconKey: "typescript", extensions: ["ts", "mts", "cts"] },
  { id: "javascript", iconKey: "react", extensions: ["jsx"] },
  { id: "javascript", iconKey: "javascript", extensions: ["js", "mjs", "cjs"], shebangInterpreters: ["node"] },
  { id: "html", iconKey: "html", extensions: ["html", "htm", "xhtml"] },
  { id: "css", iconKey: "css", extensions: ["css", "scss", "sass", "less"] },
  { id: "json", iconKey: "json", extensions: ["json"] },
  { id: "markdown", iconKey: "markdown", extensions: ["md", "markdown"] },
  { id: "python", iconKey: "python", extensions: ["py", "pyw"], shebangInterpreters: ["python", "python2", "python3"] },
  { id: "java", iconKey: "java", extensions: ["java", "class", "jar"] },
  { id: "rust", iconKey: "rust", extensions: ["rs"] },
  { id: "go", iconKey: "go", extensions: ["go"] },
  { id: "ruby", iconKey: "ruby", extensions: ["rb"], shebangInterpreters: ["ruby"] },
  { id: "php", iconKey: "php", extensions: ["php"], shebangInterpreters: ["php"] },
  { id: "cpp", iconKey: "cpp", extensions: ["cpp", "cc", "cxx", "hpp", "h"] },
  { id: "c", iconKey: "c", extensions: ["c"] },
  { id: "csharp", iconKey: "default", extensions: ["cs"] },
  { id: "lua", iconKey: "default", extensions: ["lua"] },
  { id: "sql", iconKey: "sql", extensions: ["sql", "psql", "sqlite", "sqlite3", "db"] },
  { id: "shell", iconKey: "shell", extensions: ["sh", "bash", "zsh", "fish"], shebangInterpreters: ["sh", "bash", "zsh", "fish"] },
  { id: "bat", iconKey: "shell", extensions: ["bat", "cmd"] },
  // Real Monaco tokenizer for PowerShell exists (basic-languages/powershell) --
  // `.ps1` used to be lumped in with the Windows-batch "bat" id above, which
  // has its own, wrong, tokenizer. Fixed as part of PR 6's coverage pass.
  { id: "powershell", iconKey: "powershell", extensions: ["ps1", "psm1", "psd1"] },
  // Monaco has no "toml" tokenizer either (same verification as makefile
  // above) -- explicit "plaintext", not a silently-unrecognized "toml" id.
  { id: "plaintext", iconKey: "config", extensions: ["toml"] },
  { id: "yaml", iconKey: "config", extensions: ["yaml", "yml"] },
  { id: "xml", iconKey: "config", extensions: ["xml"] },
  { id: "ini", iconKey: "config", extensions: ["ini", "conf", "config", "lock", "properties"] },

  // PR 6 coverage expansion -- languages confirmed present in the installed
  // monaco-editor's basic-languages set (see plan file for the verification).
  { id: "kotlin", iconKey: "kotlin", extensions: ["kt", "kts"] },
  { id: "scala", iconKey: "scala", extensions: ["scala", "sc"] },
  { id: "objective-c", iconKey: "objectivec", extensions: ["m", "mm"] },
  { id: "fsharp", iconKey: "fsharp", extensions: ["fs", "fsx", "fsi"] },
  { id: "swift", iconKey: "swift", extensions: ["swift"] },
  { id: "dart", iconKey: "dart", extensions: ["dart"] },
  { id: "r", iconKey: "r", extensions: ["r"] },
  // Terraform has no dedicated Monaco tokenizer; HCL (Terraform's own
  // underlying grammar) does, and covers .tf/.tfvars reasonably.
  { id: "hcl", iconKey: "hcl", extensions: ["tf", "tfvars", "hcl"] },
  { id: "graphql", iconKey: "graphql", extensions: ["graphql", "gql"] },
  // Monaco's basic-languages id for this tokenizer is "proto", not
  // "protobuf" -- confirmed directly against the installed package.
  { id: "proto", iconKey: "protobuf", extensions: ["proto"] },
  { id: "mdx", iconKey: "markdown", extensions: ["mdx"] },
  // No distinct "jsonc" language is registered in this Monaco build (VS
  // Code itself has one; vanilla monaco-editor doesn't) -- .jsonc gets
  // plain JSON's tokenizer, which won't highlight `//` comments specially
  // but won't misrender otherwise. Documented, not silently wrong.
  { id: "json", iconKey: "json", extensions: ["jsonc"] },
  // Raster/vector images (REFACTOR_PLAN.md-style follow-up: FileTab now
  // previews these instead of handing binary bytes to Monaco). SVG gets
  // "xml" as its Monaco id -- real, tokenizable markup -- for the rare case
  // a caller resolves language without going through FileTab's own image
  // branch; the raster formats get "plaintext" since there's no sensible
  // text tokenization for them and FileTab never loads them into Monaco.
  { id: "xml", iconKey: "image", extensions: ["svg"] },
  {
    id: "plaintext",
    iconKey: "image",
    extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "avif", "tiff", "tif"],
  },
];

const DEFAULT_RULE: LanguageRule = { id: "plaintext", iconKey: "default" };

/**
 * Extracts the interpreter basename from a shebang line, or null if
 * `line` isn't one. `#!/usr/bin/env python3` resolves to "python3", not
 * "env" -- `env`'s whole job is to look up the real interpreter by name,
 * so treating it as the language would misclassify every env-shebang'd
 * script (the overwhelming majority of real-world ones).
 */
function parseShebangInterpreter(line: string): string | null {
  if (!line.startsWith("#!")) return null;
  const tokens = line.slice(2).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const basename = (token: string) => token.split("/").pop() || token;
  const first = basename(tokens[0]);
  if (first === "env" && tokens.length > 1) return basename(tokens[1]);
  return first;
}

/**
 * Resolve a filename to its full language rule (id + iconKey).
 * `firstLine`, when supplied, is only consulted as a last resort (after
 * every filename/prefix/extension check has failed) to detect a shebang on
 * an otherwise-unrecognized extensionless script -- a filename-only lookup
 * can never see file content, so `getMonacoLanguageId`/`getLspKeyFromPath`
 * (both filename-only) can't benefit from this; callers that already have
 * the file's content loaded (FileTab.tsx) call `resolveLanguage` directly
 * with it once available.
 */
export function resolveLanguage(fileName: string, firstLine?: string): LanguageRule {
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

  const interpreter = firstLine ? parseShebangInterpreter(firstLine) : null;
  if (interpreter) {
    const versionless = interpreter.replace(/[\d.]+$/, "");
    for (const rule of RULES) {
      if (rule.shebangInterpreters?.some((i) => i === interpreter || i === versionless)) return rule;
    }
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
