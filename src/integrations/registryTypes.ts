/**
 * Types for the integration registry (REFACTOR_PLAN.md PR 3b) -- pure data,
 * mirroring src/startup/types.ts's own rule: no store, service, or React
 * import belongs here or anywhere else in src/integrations/; see
 * layering.test.ts. Quota is generic over its snapshot type (`TQuota`)
 * rather than importing store/types.ts's `ProviderQuotaSnapshot` directly,
 * for exactly that reason -- src/store/types.ts is what binds the two
 * together (`ProviderStatus = ProviderStatusEntry<ProviderQuotaSnapshot>`),
 * the same direction it already imports `StartupState` from
 * ../startup/types.
 */

export type ProviderId = string;

export type ProviderStatusKind =
  /** Never checked yet -- the initial value for every provider. */
  | "unknown"
  /** A status check is in flight, OR a managed login is mid-flow. */
  | "loading"
  | "ready"
  /** Reached the provider; it says sign in. Deliberately distinct from
      "error" -- collapsing the two is today's bug (providerHelpers.ts's
      selectableModelProviders filters an unauthenticated provider out of
      the array entirely, so its models just vanish with no explanation). */
  | "unauthenticated"
  /** Could not reach it, or the check itself failed. */
  | "error";

export interface ProviderStatusEntry<TQuota> {
  kind: ProviderStatusKind;
  message?: string;
  /** ISO timestamp of the last status check, successful or not. Used to
      drop a stale write: a coordinator response is only applied if this
      hasn't advanced past the request's own checkedAt since it was
      issued. */
  checkedAt?: string;

  // Managed-auth device-code flow (copilot, codex, claude-code).
  verificationUri?: string;
  userCode?: string;
  diagnostics?: string[];
  account?: string;
  /** Copilot only -- the GitHub host (e.g. "https://github.com"). */
  host?: string;
  /** Codex/Claude Code only -- the plan name reported by the sidecar. */
  planType?: string;

  // Quota, folded in here rather than kept in a parallel cache
  // (ProviderQuotaControl's local state today).
  quota?: TQuota;
  quotaError?: string;
  quotaLoading?: boolean;
}

/**
 * A provider absent from the map has never been checked -- this is the
 * lazy equivalent of seeding every known provider id with `{kind:
 * "unknown"}` up front, without the registry needing to know what
 * providers exist (that's createIntegrationSlice's job, a different
 * slice).
 */
export function providerStatusOrUnknown<TQuota>(
  providerStatus: Record<ProviderId, ProviderStatusEntry<TQuota>>,
  id: ProviderId,
): ProviderStatusEntry<TQuota> {
  return providerStatus[id] ?? { kind: "unknown" };
}
