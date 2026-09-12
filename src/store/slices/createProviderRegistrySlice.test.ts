import { describe, expect, it } from "vitest";
import { createProviderRegistryTestStore } from "../../test/providerRegistryTestStore";

describe("createProviderRegistrySlice", () => {
  it("starts with an empty map", () => {
    expect(createProviderRegistryTestStore().getState().providerStatus).toEqual({});
  });

  it("setProviderStatus replaces one provider's entry wholesale, leaving others untouched", () => {
    const store = createProviderRegistryTestStore();
    store.getState().setProviderStatus("github-copilot", { kind: "loading" });
    store.getState().setProviderStatus("openai", { kind: "ready" });

    store.getState().setProviderStatus("github-copilot", {
      kind: "unauthenticated",
      message: "Sign in with GitHub to activate this integration.",
    });

    expect(store.getState().providerStatus).toEqual({
      "github-copilot": {
        kind: "unauthenticated",
        message: "Sign in with GitHub to activate this integration.",
      },
      openai: { kind: "ready" },
    });
  });

  it("patchProviderStatus merges into an existing entry rather than replacing it", () => {
    const store = createProviderRegistryTestStore();
    store.getState().setProviderStatus("github-copilot", {
      kind: "ready",
      account: "octocat",
    });

    store.getState().patchProviderStatus("github-copilot", { quotaLoading: true });

    expect(store.getState().providerStatus["github-copilot"]).toEqual({
      kind: "ready",
      account: "octocat",
      quotaLoading: true,
    });
  });

  it("patchProviderStatus on a provider with no existing entry starts from 'unknown'", () => {
    const store = createProviderRegistryTestStore();

    store.getState().patchProviderStatus("openai", { quotaError: "timed out" });

    expect(store.getState().providerStatus.openai).toEqual({
      kind: "unknown",
      quotaError: "timed out",
    });
  });

  it("a later patch overwrites a field an earlier patch set", () => {
    const store = createProviderRegistryTestStore();
    store.getState().patchProviderStatus("anthropic", { kind: "loading", message: "checking…" });
    store.getState().patchProviderStatus("anthropic", { kind: "ready", message: "Signed in as octocat" });

    expect(store.getState().providerStatus.anthropic.kind).toBe("ready");
    expect(store.getState().providerStatus.anthropic.message).toBe("Signed in as octocat");
  });
});
