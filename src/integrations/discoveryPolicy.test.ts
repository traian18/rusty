import { describe, expect, it } from "vitest";
import { isCatalogStale, isEligibleForDiscovery, MODEL_CATALOG_TTL_MS } from "./discoveryPolicy";

describe("isEligibleForDiscovery", () => {
  it("a managed provider is eligible only once its status is 'ready'", () => {
    expect(isEligibleForDiscovery({ isManaged: true, statusKind: "ready", hasApiKey: false })).toBe(true);
    for (const statusKind of ["unknown", "loading", "unauthenticated", "error"] as const) {
      expect(isEligibleForDiscovery({ isManaged: true, statusKind, hasApiKey: false })).toBe(false);
    }
  });

  it("a managed provider with authType 'environment' is still gated on status -- the bug this fixes", () => {
    // Today's isConfiguredProvider/selectableModelProviders treat
    // authType==='environment' as always configured, regardless of
    // whether the provider is actually signed in.
    expect(
      isEligibleForDiscovery({ isManaged: true, statusKind: "unauthenticated", authType: "environment", hasApiKey: false }),
    ).toBe(false);
  });

  it("a regular provider with authType 'none' is always eligible", () => {
    expect(isEligibleForDiscovery({ isManaged: false, statusKind: "unknown", authType: "none", hasApiKey: false })).toBe(
      true,
    );
  });

  it("a regular provider with a non-empty API key is eligible", () => {
    expect(isEligibleForDiscovery({ isManaged: false, statusKind: "unknown", authType: "bearer", hasApiKey: true })).toBe(
      true,
    );
  });

  it("a regular provider with neither is not eligible", () => {
    expect(isEligibleForDiscovery({ isManaged: false, statusKind: "unknown", authType: "bearer", hasApiKey: false })).toBe(
      false,
    );
  });
});

describe("isCatalogStale", () => {
  const NOW = Date.parse("2026-09-12T12:00:00.000Z");

  it("is stale when never discovered", () => {
    expect(isCatalogStale({}, NOW)).toBe(true);
  });

  it("is stale when the stored timestamp doesn't parse", () => {
    expect(isCatalogStale({ modelsFetchedAt: "not-a-date" }, NOW)).toBe(true);
  });

  it("is fresh just under the TTL", () => {
    const fetchedAt = new Date(NOW - (MODEL_CATALOG_TTL_MS - 1)).toISOString();
    expect(isCatalogStale({ modelsFetchedAt: fetchedAt }, NOW)).toBe(false);
  });

  it("is stale exactly at the TTL", () => {
    const fetchedAt = new Date(NOW - MODEL_CATALOG_TTL_MS).toISOString();
    expect(isCatalogStale({ modelsFetchedAt: fetchedAt }, NOW)).toBe(true);
  });

  it("is stale well past the TTL", () => {
    const fetchedAt = new Date(NOW - MODEL_CATALOG_TTL_MS * 3).toISOString();
    expect(isCatalogStale({ modelsFetchedAt: fetchedAt }, NOW)).toBe(true);
  });

  it("respects a custom TTL", () => {
    const fetchedAt = new Date(NOW - 1_000).toISOString();
    expect(isCatalogStale({ modelsFetchedAt: fetchedAt }, NOW, 500)).toBe(true);
    expect(isCatalogStale({ modelsFetchedAt: fetchedAt }, NOW, 2_000)).toBe(false);
  });
});
