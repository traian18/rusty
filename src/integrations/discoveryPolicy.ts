import type { ProviderStatusKind } from "./registryTypes";

/**
 * Pure eligibility/staleness rules for background model discovery
 * (REFACTOR_PLAN.md PR 3b) -- no store, service, or React import, so
 * directly testable; see layering.test.ts. providerCoordinator.ts (which
 * cannot live here -- it owns the store/service calls) is the only caller.
 */

export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1_000;

/** Bounds how many discoverModels() calls run at once. Unbounded would mean
 * simultaneous Copilot SDK cold start + Codex child-process spawn + Claude
 * Agent-SDK query, on top of whatever the status-check semaphore is
 * already running. */
export const DISCOVERY_CONCURRENCY = 2;

export interface DiscoveryEligibilityInput {
  /** Whether this is one of the three managed-auth providers
      (github-copilot, openai-codex, anthropic-claude-code). */
  isManaged: boolean;
  /** The registry's current status kind for this provider (ignored for
      non-managed providers, which have no status-check cycle of their
      own). */
  statusKind: ProviderStatusKind;
  authType?: string;
  hasApiKey: boolean;
}

/**
 * A managed provider is only discovered once its own status is "ready" --
 * fixes today's isConfiguredProvider/selectableModelProviders behavior,
 * where a managed provider (authType "environment") always counted as
 * "configured" regardless of whether it was actually signed in. A regular
 * provider has no status-check cycle, so it's eligible whenever it would
 * be usable at all: authType "none", or a non-empty API key.
 */
export function isEligibleForDiscovery(input: DiscoveryEligibilityInput): boolean {
  if (input.isManaged) return input.statusKind === "ready";
  return input.authType === "none" || input.hasApiKey;
}

/**
 * Quota gating uses the exact same rule -- a provider actually usable at
 * all is a provider worth checking quota for. Named separately so a call
 * site (providerCoordinator.ts's quota watch) reads as what it's deciding,
 * not as a discovery decision it happens to share logic with.
 */
export const isEligibleForQuota = isEligibleForDiscovery;

export interface StalenessInput {
  modelsFetchedAt?: string;
}

/**
 * True when a catalog has never been discovered, was saved with an
 * unparseable timestamp, or has aged past the TTL. Absence of
 * modelsFetchedAt (never discovered) is always stale -- that's the whole
 * point of the field (see CustomProvider.modelsFetchedAt, PR 3b commit 6).
 */
export function isCatalogStale(
  input: StalenessInput,
  nowMs: number,
  ttlMs: number = MODEL_CATALOG_TTL_MS,
): boolean {
  if (!input.modelsFetchedAt) return true;
  const fetchedAtMs = Date.parse(input.modelsFetchedAt);
  if (Number.isNaN(fetchedAtMs)) return true;
  return nowMs - fetchedAtMs >= ttlMs;
}
