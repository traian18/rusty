import { useMemo } from "react";
import type { CustomProvider, ProviderStatus } from "../store/types";
import { isManagedAuthProvider, selectableProviderModels } from "../store/providerHelpers";
import { providerStatusOrUnknown } from "../integrations/registryTypes";

export interface SelectableModelOption {
  id: string;
  name: string;
}

export interface SelectableModelsResult {
  options: SelectableModelOption[];
  /** Managed providers excluded because their registry status isn't
      'ready' yet -- lets a picker render a helpful "Sign in to X"
      placeholder instead of silently omitting their models with no
      explanation (REFACTOR_PLAN.md PR 3c). */
  unauthenticatedProviders: CustomProvider[];
}

/**
 * The pure core, exported separately from the hook below so it's directly
 * testable without a component tree -- this repo's tests run under plain
 * vitest `environment: "node"` with no @testing-library/react.
 *
 * One label format (`${provider.name} / ${model.name}`, the existing
 * majority across the app's pickers) replaces the five different formats
 * in use before this hook existed: `${model.name} (${model.id})`
 * (AgentTab/TaskTab), bare `model.name` (SidePaneFooter/PromptChatContent),
 * and bare model id (ReconciliationGraphPane, which lost provider
 * disambiguation entirely).
 */
export function buildSelectableModels(
  customProviders: CustomProvider[],
  providerStatus: Record<string, ProviderStatus>,
  selectedProviderId: string | null,
): SelectableModelsResult {
  const options = selectableProviderModels(customProviders, providerStatus, selectedProviderId)
    .map(({ provider, model }) => ({ id: model.id, name: `${provider.name} / ${model.name}` }));

  const unauthenticatedProviders = customProviders.filter(
    (provider) =>
      isManagedAuthProvider(provider)
      && providerStatusOrUnknown(providerStatus, provider.id).kind !== "ready",
  );

  return { options, unauthenticatedProviders };
}

/**
 * The one model-picker hook (REFACTOR_PLAN.md PR 3c), replacing ~11
 * separate inline recomputations (only one of which -- ReconciliationGraphPane
 * -- previously memoized at all).
 */
export function useSelectableModels(
  customProviders: CustomProvider[],
  providerStatus: Record<string, ProviderStatus>,
  selectedProviderId: string | null,
): SelectableModelsResult {
  return useMemo(
    () => buildSelectableModels(customProviders, providerStatus, selectedProviderId),
    [customProviders, providerStatus, selectedProviderId],
  );
}
