import { describe, expect, it } from "vitest";
import { resolveExecutionProvider } from "./resolveExecutionProvider";
import type { CustomProvider } from "./types";

function provider(overrides: Partial<CustomProvider>): CustomProvider {
  return {
    id: "some-id",
    name: "Some Provider",
    baseUrl: "",
    apiKey: "",
    apiType: "openai-completions",
    models: [{ id: "some-id/model-a", remoteId: "model-a", name: "Model A", supported: true }],
    ...overrides,
  };
}

const managed = provider({ id: "github-copilot", name: "GitHub Copilot", authType: "environment" });
const regular = provider({ id: "custom-ollama", name: "Custom Ollama", authType: "none" });

describe("resolveExecutionProvider", () => {
  it("resolves ok when the managed provider owning the model is 'ready'", () => {
    const result = resolveExecutionProvider(
      [managed],
      { "github-copilot": { kind: "ready" } },
      null,
      "github-copilot/model-a",
    );
    expect(result).toEqual({ ok: true, provider: managed });
  });

  it.each(["unauthenticated", "error"] as const)(
    "blocks with reason 'not-authenticated' when the managed provider's status is '%s'",
    (kind) => {
      const result = resolveExecutionProvider(
        [managed],
        { "github-copilot": { kind } },
        null,
        "github-copilot/model-a",
      );
      expect(result).toMatchObject({ ok: false, reason: "not-authenticated" });
    },
  );

  it.each(["unknown", "loading"] as const)(
    "blocks with reason 'status-pending' (not 'not-authenticated') when the managed provider's status is '%s'",
    (kind) => {
      const result = resolveExecutionProvider(
        [managed],
        { "github-copilot": { kind } },
        null,
        "github-copilot/model-a",
      );
      expect(result).toMatchObject({ ok: false, reason: "status-pending" });
    },
  );

  it("REGRESSION GUARD: a regular provider with no providerStatus entry at all still resolves ok -- never gate a regular provider on registry status", () => {
    // providerCoordinator.ts only ever polls the three managed provider
    // ids; a regular provider's entry is permanently absent (not merely
    // unset), so a naive "status !== ready -> block" would permanently
    // exclude every custom/local provider. This is the one test that
    // must never be "fixed" into blocking.
    const result = resolveExecutionProvider([regular], {}, null, "custom-ollama/model-a");
    expect(result).toEqual({ ok: true, provider: regular });
  });

  it("falls back to activeCustomProviderId when modelReference is empty", () => {
    const result = resolveExecutionProvider(
      [managed, regular],
      { "github-copilot": { kind: "ready" } },
      "github-copilot",
      undefined,
    );
    expect(result).toEqual({ ok: true, provider: managed });
  });

  it("returns 'no-model-selected' when modelReference is empty and there is no active provider either", () => {
    const result = resolveExecutionProvider([managed, regular], {}, null, undefined);
    expect(result).toMatchObject({ ok: false, reason: "no-model-selected" });
  });

  it("returns 'unknown-provider' when modelReference doesn't match any configured provider and there is no active-provider fallback", () => {
    const result = resolveExecutionProvider([regular], {}, null, "nonexistent/model-z");
    expect(result).toMatchObject({ ok: false, reason: "unknown-provider" });
  });

  it("falls back to activeCustomProviderId when modelReference matches nothing configured", () => {
    const result = resolveExecutionProvider(
      [managed, regular],
      { "github-copilot": { kind: "ready" } },
      "github-copilot",
      "nonexistent/model-z",
    );
    expect(result).toEqual({ ok: true, provider: managed });
  });

  it("never gates a regular provider on status even when a providerStatus entry happens to exist for it", () => {
    // Defensive: even if something someday wrote a stray entry for a
    // regular provider's id, isManagedAuthProvider is still what gates,
    // not the mere presence of a providerStatus entry.
    const result = resolveExecutionProvider(
      [regular],
      { "custom-ollama": { kind: "error" } },
      null,
      "custom-ollama/model-a",
    );
    expect(result).toEqual({ ok: true, provider: regular });
  });
});
