import { describe, expect, it } from "vitest";
import {
  isClaudeCodeProvider,
  isCodexProvider,
  isCopilotProvider,
  isManagedAuthProvider,
  selectableModelProviders,
} from "./providerHelpers";
import type { CustomProvider, ProviderStatus } from "./types";
import type { ProviderStatusKind } from "../integrations/registryTypes";

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

describe("selectableModelProviders: registry-aware gating (REFACTOR_PLAN.md PR 3c)", () => {
  function statusOf(kind: ProviderStatusKind): Record<string, ProviderStatus> {
    return { "github-copilot": { kind } };
  }

  const managed = provider({ id: "github-copilot", authType: "environment" });
  const regularWithKey = provider({ id: "custom-ollama", authType: "bearer", apiKey: "sk-test" });
  const regularNoKey = provider({ id: "custom-ollama", authType: "bearer", apiKey: "" });
  const regularNoAuth = provider({ id: "custom-ollama", authType: "none" });

  it("includes a managed provider only when its status is 'ready'", () => {
    expect(selectableModelProviders([managed], statusOf("ready"), null)).toEqual([managed]);
  });

  it.each(["unknown", "loading", "unauthenticated", "error"] as const)(
    "excludes a managed provider when its status is '%s'",
    (kind) => {
      expect(selectableModelProviders([managed], statusOf(kind), null)).toEqual([]);
    },
  );

  it("includes a managed provider excluded by status if it is the currently-selected provider (escape hatch)", () => {
    expect(selectableModelProviders([managed], statusOf("error"), "github-copilot")).toEqual([managed]);
  });

  it("includes a regular provider with authType 'none' even with no providerStatus entry at all", () => {
    // The asymmetry this test guards: providerCoordinator.ts only ever
    // polls the three managed provider ids, so a regular provider's
    // registry entry is permanently absent (reads back {kind: "unknown"}
    // via providerStatusOrUnknown) -- it must never be gated on status.
    expect(selectableModelProviders([regularNoAuth], {}, null)).toEqual([regularNoAuth]);
  });

  it("includes a regular provider with a non-empty apiKey, no providerStatus entry", () => {
    expect(selectableModelProviders([regularWithKey], {}, null)).toEqual([regularWithKey]);
  });

  it("excludes a regular provider with authType requiring a key but none set -- today's rule, unchanged", () => {
    expect(selectableModelProviders([regularNoKey], {}, null)).toEqual([]);
  });
});
