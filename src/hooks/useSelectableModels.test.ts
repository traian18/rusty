import { describe, expect, it } from "vitest";
import { buildSelectableModels } from "./useSelectableModels";
import type { CustomProvider } from "../store/types";

function provider(overrides: Partial<CustomProvider>): CustomProvider {
  const id = overrides.id ?? "some-id";
  return {
    id,
    name: "Some Provider",
    baseUrl: "",
    apiKey: "",
    apiType: "openai-completions",
    models: [{ id: `${id}/model-a`, remoteId: "model-a", name: "Model A", supported: true }],
    ...overrides,
  };
}

describe("buildSelectableModels", () => {
  it("uses one label format: '${provider.name} / ${model.name}'", () => {
    const regular = provider({ id: "opencode", name: "OpenCode Zen", authType: "none" });
    const result = buildSelectableModels([regular], {}, null);
    expect(result.options).toEqual([{ id: "opencode/model-a", name: "OpenCode Zen / Model A" }]);
  });

  it("includes a ready managed provider's models", () => {
    const managed = provider({ id: "github-copilot", name: "GitHub Copilot", authType: "environment" });
    const result = buildSelectableModels([managed], { "github-copilot": { kind: "ready" } }, null);
    expect(result.options).toEqual([{ id: "github-copilot/model-a", name: "GitHub Copilot / Model A" }]);
  });

  it("excludes a not-ready managed provider's models from options, but lists it as unauthenticated", () => {
    const managed = provider({ id: "github-copilot", name: "GitHub Copilot", authType: "environment" });
    const result = buildSelectableModels([managed], { "github-copilot": { kind: "unauthenticated" } }, null);
    expect(result.options).toEqual([]);
    expect(result.unauthenticatedProviders).toEqual([managed]);
  });

  it("never lists a regular provider as unauthenticated, even when excluded from options", () => {
    const regularNoKey = provider({ id: "custom-ollama", name: "Custom Ollama", authType: "bearer", apiKey: "" });
    const result = buildSelectableModels([regularNoKey], {}, null);
    expect(result.options).toEqual([]);
    expect(result.unauthenticatedProviders).toEqual([]);
  });

  it("lists a managed provider as unauthenticated even while it's the selected provider (options still include it via the escape hatch)", () => {
    const managed = provider({ id: "github-copilot", name: "GitHub Copilot", authType: "environment" });
    const result = buildSelectableModels([managed], { "github-copilot": { kind: "error" } }, "github-copilot");
    expect(result.options).toEqual([{ id: "github-copilot/model-a", name: "GitHub Copilot / Model A" }]);
    expect(result.unauthenticatedProviders).toEqual([managed]);
  });

  it("returns models from multiple eligible providers together", () => {
    const managed = provider({ id: "github-copilot", name: "GitHub Copilot", authType: "environment" });
    const regular = provider({
      id: "opencode",
      name: "OpenCode Zen",
      authType: "none",
      models: [{ id: "opencode/model-b", remoteId: "model-b", name: "Model B", supported: true }],
    });
    const result = buildSelectableModels(
      [managed, regular],
      { "github-copilot": { kind: "ready" } },
      null,
    );
    expect(result.options).toEqual([
      { id: "github-copilot/model-a", name: "GitHub Copilot / Model A" },
      { id: "opencode/model-b", name: "OpenCode Zen / Model B" },
    ]);
  });
});
