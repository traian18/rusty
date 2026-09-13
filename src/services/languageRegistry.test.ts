import { describe, it, expect } from "vitest";
import {
  resolveLanguage,
  getMonacoLanguageId,
  getLspKeyFromPath,
  isLspMonacoId,
  getLspKeyFromMonacoId,
} from "./languageRegistry";

/**
 * Table-driven mapping tests (REFACTOR_PLAN.md PR 6 commit 9) -- one row
 * per checklist language family, asserting filename/extension -> Monaco id
 * and (where applicable) LSP key together, plus the documented fallback
 * cases (TOML/Makefile/CMake resolving to "plaintext" rather than an
 * unrecognized custom id, and Vue/Svelte falling through entirely since
 * Monaco has no tokenizer for either in this build).
 */
describe("languageRegistry: filename/extension -> Monaco id + LSP key", () => {
  const cases: Array<{ file: string; id: string; lspKey: string | null }> = [
    // Web/TS family
    { file: "index.ts", id: "typescript", lspKey: "typescript" },
    { file: "Component.tsx", id: "typescript", lspKey: "typescript" },
    { file: "index.js", id: "javascript", lspKey: "typescript" },
    { file: "Component.jsx", id: "javascript", lspKey: "typescript" },
    { file: "styles.css", id: "css", lspKey: "css" },
    { file: "styles.scss", id: "css", lspKey: "css" },
    { file: "page.html", id: "html", lspKey: "html" },
    { file: "data.json", id: "json", lspKey: "json" },
    { file: "data.jsonc", id: "json", lspKey: "json" },
    { file: "readme.md", id: "markdown", lspKey: null },
    { file: "doc.mdx", id: "mdx", lspKey: null },

    // Config/markup
    { file: "config.yaml", id: "yaml", lspKey: "yaml" },
    { file: "config.yml", id: "yaml", lspKey: "yaml" },
    { file: "data.xml", id: "xml", lspKey: null },
    { file: "settings.ini", id: "ini", lspKey: null },

    // General-purpose languages
    { file: "main.py", id: "python", lspKey: "python" },
    { file: "Main.java", id: "java", lspKey: "java" },
    { file: "main.rs", id: "rust", lspKey: "rust" },
    { file: "main.go", id: "go", lspKey: "go" },
    { file: "script.rb", id: "ruby", lspKey: "ruby" },
    { file: "index.php", id: "php", lspKey: "php" },
    { file: "main.cpp", id: "cpp", lspKey: "cpp" },
    { file: "main.c", id: "c", lspKey: "c" },
    { file: "Program.cs", id: "csharp", lspKey: "csharp" },
    { file: "script.lua", id: "lua", lspKey: "lua" },

    // JVM/Apple/CLR family added in PR 6's coverage pass -- none carry an
    // lspKey (no configured LSP server for any of these today).
    { file: "Main.kt", id: "kotlin", lspKey: null },
    { file: "App.kts", id: "kotlin", lspKey: null },
    { file: "Main.scala", id: "scala", lspKey: null },
    { file: "AppDelegate.m", id: "objective-c", lspKey: null },
    { file: "AppDelegate.mm", id: "objective-c", lspKey: null },
    { file: "Program.fs", id: "fsharp", lspKey: null },
    { file: "Script.fsx", id: "fsharp", lspKey: null },
    { file: "main.swift", id: "swift", lspKey: null },
    { file: "main.dart", id: "dart", lspKey: null },
    { file: "script.r", id: "r", lspKey: null },
    { file: "script.R", id: "r", lspKey: null },

    // Real PowerShell tokenizer, not "bat" (PR 6 bugfix)
    { file: "deploy.ps1", id: "powershell", lspKey: null },
    { file: "module.psm1", id: "powershell", lspKey: null },
    { file: "run.bat", id: "bat", lspKey: null },
    { file: "run.cmd", id: "bat", lspKey: null },

    // Infra/schema languages
    { file: "main.tf", id: "hcl", lspKey: null },
    { file: "vars.tfvars", id: "hcl", lspKey: null },
    { file: "schema.graphql", id: "graphql", lspKey: null },
    { file: "schema.gql", id: "graphql", lspKey: null },
    { file: "message.proto", id: "proto", lspKey: null },

    // Extensionless filenames
    { file: "Dockerfile", id: "dockerfile", lspKey: null },
    { file: "Gemfile", id: "ruby", lspKey: "ruby" },
    { file: "package.json", id: "json", lspKey: "json" },
    { file: ".gitignore", id: "ignore", lspKey: null },
    { file: ".env.local", id: "properties", lspKey: null },

    // Documented fallbacks: Monaco has no tokenizer for these, so they
    // resolve to "plaintext" explicitly rather than an id Monaco silently
    // fails to recognize.
    { file: "Makefile", id: "plaintext", lspKey: null },
    { file: "CMakeLists.txt", id: "plaintext", lspKey: null },
    { file: "build.cmake", id: "plaintext", lspKey: null },
    { file: "Cargo.toml", id: "plaintext", lspKey: null },

    // Vue/Svelte: no dedicated rule at all -- fall through to the same
    // default plaintext every other unrecognized extension gets.
    { file: "App.vue", id: "plaintext", lspKey: null },
    { file: "App.svelte", id: "plaintext", lspKey: null },

    // Genuinely unknown extension
    { file: "notes.xyz123", id: "plaintext", lspKey: null },
  ];

  it.each(cases)("$file -> id=$id, lspKey=$lspKey", ({ file, id, lspKey }) => {
    expect(getMonacoLanguageId(file)).toBe(id);
    expect(getLspKeyFromPath(file)).toBe(lspKey);
  });

  it("tsx and ts share one Monaco id but get different icons", () => {
    expect(resolveLanguage("Component.tsx").id).toBe(resolveLanguage("index.ts").id);
    expect(resolveLanguage("Component.tsx").iconKey).not.toBe(resolveLanguage("index.ts").iconKey);
    expect(resolveLanguage("Component.tsx").iconKey).toBe("react");
    expect(resolveLanguage("index.ts").iconKey).toBe("typescript");
  });
});

describe("languageRegistry: shebang detection", () => {
  it("resolves a known interpreter on an extensionless file", () => {
    expect(resolveLanguage("myscript", "#!/usr/bin/env python3").id).toBe("python");
    expect(resolveLanguage("myscript", "#!/bin/bash").id).toBe("shell");
    expect(resolveLanguage("myscript", "#!/usr/bin/env node").id).toBe("javascript");
    expect(resolveLanguage("myscript", "#!/usr/bin/ruby").id).toBe("ruby");
    expect(resolveLanguage("myscript", "#!/usr/bin/env php").id).toBe("php");
  });

  it("strips a trailing version number from the interpreter", () => {
    expect(resolveLanguage("myscript", "#!/usr/bin/env python3.11").id).toBe("python");
  });

  it("does not treat env itself as the interpreter", () => {
    // If "env" were used directly instead of resolving its argument, this
    // would incorrectly look for a rule named "env" and fail to match --
    // asserting the correct id here pins that "env" is skipped over.
    expect(resolveLanguage("myscript", "#!/usr/bin/env python3").id).not.toBe("env");
  });

  it("falls through to plaintext when the first line isn't a shebang", () => {
    expect(resolveLanguage("myscript", "just some text").id).toBe("plaintext");
    expect(resolveLanguage("myscript").id).toBe("plaintext");
  });

  it("never overrides a filename/extension that already resolved", () => {
    // A shebang is only consulted as a last resort -- an already-recognized
    // extension must win even if the content looks like a shebang for a
    // different interpreter (a real scenario: a polyglot script, or just
    // a coincidental first line).
    expect(resolveLanguage("run.sh", "#!/usr/bin/env node").id).toBe("shell");
  });
});

describe("languageRegistry: LSP helpers", () => {
  it("reports whether a Monaco id has a managed LSP server", () => {
    expect(isLspMonacoId("typescript")).toBe(true);
    expect(isLspMonacoId("shell")).toBe(true); // backed by the "bash" server
    expect(isLspMonacoId("markdown")).toBe(false);
    expect(isLspMonacoId("kotlin")).toBe(false);
  });

  it("maps shell's Monaco id to the bash LSP key, not a literal 'shell' key", () => {
    expect(getLspKeyFromMonacoId("shell")).toBe("bash");
  });

  it("returns null for an unrecognized Monaco id", () => {
    expect(getLspKeyFromMonacoId("not-a-real-language")).toBeNull();
  });
});
