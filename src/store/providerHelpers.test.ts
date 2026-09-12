import { describe, expect, it } from "vitest";
import {
  isClaudeCodeProvider,
  isCodexProvider,
  isCopilotProvider,
  isManagedAuthProvider,
} from "./providerHelpers";
import type { CustomProvider } from "./types";

/**
 * These predicates used to be duplicated verbatim in LlmSetupTab.tsx and
 * ProviderList.tsx (REFACTOR_PLAN.md PR 3b commit 10). One copy here,
 * pinned by id and by transport -- both are recognized independently,
 * since normalizeStoredProvider (providerHelpers.ts) can migrate an id
 * without necessarily touching transport, and vice versa.
 */
function provider(overrides: Partial<CustomProvider>): CustomProvider {
  return {
    id: "some-id",
    name: "Some Provider",
    baseUrl: "",
    apiKey: "",
    apiType: "openai-completions",
    models: [],
    ...overrides,
  };
}

describe("isCopilotProvider", () => {
  it("recognizes by id", () => {
    expect(isCopilotProvider(provider({ id: "github-copilot" }))).toBe(true);
  });
  it("recognizes by transport", () => {
    expect(isCopilotProvider(provider({ id: "renamed", transport: "github-copilot-sdk" }))).toBe(true);
  });
  it("is false for an unrelated provider", () => {
    expect(isCopilotProvider(provider({ id: "openai" }))).toBe(false);
  });
});

describe("isCodexProvider", () => {
  it("recognizes by id", () => {
    expect(isCodexProvider(provider({ id: "openai-codex" }))).toBe(true);
  });
  it("recognizes by transport", () => {
    expect(isCodexProvider(provider({ id: "renamed", transport: "openai-codex-app-server" }))).toBe(true);
  });
  it("is false for an unrelated provider", () => {
    expect(isCodexProvider(provider({ id: "openai" }))).toBe(false);
  });
});

describe("isClaudeCodeProvider", () => {
  it("recognizes by id", () => {
    expect(isClaudeCodeProvider(provider({ id: "anthropic-claude-code" }))).toBe(true);
  });
  it("recognizes by transport", () => {
    expect(isClaudeCodeProvider(provider({ id: "renamed", transport: "anthropic-claude-agent-sdk" }))).toBe(true);
  });
  it("is false for an unrelated provider", () => {
    expect(isClaudeCodeProvider(provider({ id: "anthropic" }))).toBe(false);
  });
});

describe("isManagedAuthProvider", () => {
  it("is true for any of the three managed providers", () => {
    expect(isManagedAuthProvider(provider({ id: "github-copilot" }))).toBe(true);
    expect(isManagedAuthProvider(provider({ id: "openai-codex" }))).toBe(true);
    expect(isManagedAuthProvider(provider({ id: "anthropic-claude-code" }))).toBe(true);
  });

  it("is false for a regular provider", () => {
    expect(isManagedAuthProvider(provider({ id: "opencode" }))).toBe(false);
  });
});
