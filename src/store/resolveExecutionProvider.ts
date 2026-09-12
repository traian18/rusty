import { isManagedAuthProvider, providerHasModelReference } from "./providerHelpers";
import { providerStatusOrUnknown } from "../integrations/registryTypes";
import type { CustomProvider, ProviderStatus } from "./types";

/**
 * The one execution-time provider resolver (REFACTOR_PLAN.md PR 3c),
 * replacing 8 independent `getState()` call sites (Workspace.tsx's
 * executeNode, useExplorerWebSocket.ts x3, useEdgeWebSocket.ts,
 * AgentTab.tsx, SkillsTab.tsx, ReconciliationGraphPane.tsx x2) that each
 * hand-rolled (or, in Workspace.tsx's case, string-split-rolled) the same
 * lookup and then sent whatever they found -- or `null` -- to the sidecar
 * unconditionally, with no idea whether the resolved provider would
 * actually work.
 */
export type ExecutionResolution =
  | { ok: true; provider: CustomProvider }
  | { ok: false; reason: "no-model-selected"; message: string }
  | { ok: false; reason: "unknown-provider"; message: string }
  /** The provider is managed and its registry status is still `unknown`
      or `loading` -- normal for the first several seconds after launch,
      since e.g. Copilot's status check has no server-side timeout of its
      own. Distinct from `not-authenticated`: "sign in" is the wrong
      message for a check that just hasn't settled yet. */
  | { ok: false; reason: "status-pending"; message: string }
  /** The provider is managed and its registry status is `unauthenticated`
      or `error` -- the user actually needs to sign in. */
  | { ok: false; reason: "not-authenticated"; message: string };

/**
 * Finds the provider that owns `modelReference` (via the existing
 * providerHasModelReference), falling back to `activeCustomProviderId`
 * when `modelReference` is empty or owned by nothing configured -- the
 * convention 7 of the 8 sites already used before this resolver existed;
 * the 8th (SkillsTab.tsx's "Generate with AI") had no fallback at all,
 * because its own model picker's local state defaults to `""` and was
 * never seeded from `activeModel` (fixed alongside its migration onto
 * this resolver).
 *
 * A REGULAR provider (no status-check cycle of its own --
 * providerCoordinator.ts only ever polls the three managed provider ids)
 * is never gated on registry status: providerStatusOrUnknown reads back
 * `{kind: "unknown"}` for one forever, and gating on that would
 * permanently block every custom/local provider. Only a MANAGED
 * provider's resolution can fail on status -- mirrors
 * discoveryPolicy.ts's isEligibleForDiscovery rule exactly. Do not
 * "fix" this asymmetry; see resolveExecutionProvider.test.ts's named
 * regression case.
 */
export function resolveExecutionProvider(
  customProviders: CustomProvider[],
  providerStatus: Record<string, ProviderStatus>,
  activeCustomProviderId: string | null,
  modelReference: string | undefined,
): ExecutionResolution {
  let provider: CustomProvider | undefined;
  if (modelReference) {
    provider = customProviders.find((candidate) => providerHasModelReference(candidate, modelReference));
  }
  if (!provider) {
    provider = customProviders.find((candidate) => candidate.id === activeCustomProviderId);
  }

  if (!provider) {
    return modelReference
      ? {
          ok: false,
          reason: "unknown-provider",
          message: `No configured provider owns the model "${modelReference}".`,
        }
      : { ok: false, reason: "no-model-selected", message: "No model is selected." };
  }

  if (isManagedAuthProvider(provider)) {
    const kind = providerStatusOrUnknown(providerStatus, provider.id).kind;
    if (kind === "unknown" || kind === "loading") {
      return {
        ok: false,
        reason: "status-pending",
        message: `Still checking ${provider.name}'s status -- try again in a moment.`,
      };
    }
    if (kind !== "ready") {
      return {
        ok: false,
        reason: "not-authenticated",
        message: `Sign in to ${provider.name} before running this.`,
      };
    }
  }

  return { ok: true, provider };
}
