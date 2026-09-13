import { describe, expect, it } from "vitest";
import { providerStatusOrUnknown } from "./registryTypes";

describe("providerStatusOrUnknown", () => {
  it("returns the entry when the provider is present", () => {
    const map = { "github-copilot": { kind: "ready" as const } };
    expect(providerStatusOrUnknown(map, "github-copilot")).toEqual({ kind: "ready" });
  });

  it("returns {kind: 'unknown'} for a provider absent from the map", () => {
    expect(providerStatusOrUnknown({}, "openai")).toEqual({ kind: "unknown" });
  });
});
