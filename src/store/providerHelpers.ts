import type { CustomProvider, ProviderModel, ReasoningEffort } from "./types";

const REASONING_VARIANT_SEPARATOR = "::reasoning=";

/**
 * The managed-auth provider predicates (REFACTOR_PLAN.md PR 3b commit 10)
 * -- previously duplicated verbatim in both LlmSetupTab.tsx and
 * ProviderList.tsx. One copy here, imported by both.
 */
export function isCopilotProvider(provider: CustomProvider): boolean {
  return provider.transport === "github-copilot-sdk" || provider.id === "github-copilot";
}

export function isCodexProvider(provider: CustomProvider): boolean {
  return provider.transport === "openai-codex-app-server" || provider.id === "openai-codex";
}

export function isClaudeCodeProvider(provider: CustomProvider): boolean {
  return provider.transport === "anthropic-claude-agent-sdk" || provider.id === "anthropic-claude-code";
}

export function isManagedAuthProvider(provider: CustomProvider): boolean {
  return isCopilotProvider(provider) || isCodexProvider(provider) || isClaudeCodeProvider(provider);
}
const REASONING_EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh"] as const;
const REASONING_EFFORT_LABELS: Record<(typeof REASONING_EFFORT_ORDER)[number], string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

/**
 * Version 1 and older used the misleading `github-copilot` id for GitHub
 * Models. Version 2 introduces a real Copilot SDK provider under that id.
 */
export const PROVIDER_CONFIG_VERSION = 2;

export function normalizedProviderId(
  providerId: string,
  configVersion = PROVIDER_CONFIG_VERSION,
): string {
  return configVersion < PROVIDER_CONFIG_VERSION && providerId === "github-copilot"
    ? "github-models"
    : providerId;
}

function normalizeProviderModel(
  model: ProviderModel,
  originalProviderId: string,
  providerId: string,
): ProviderModel {
  const originalPrefix = `${originalProviderId}/`;
  const remoteId = model.remoteId
    || (model.id.startsWith(originalPrefix) ? model.id.slice(originalPrefix.length) : model.id);
  return {
    ...model,
    id: model.reasoningEffort
      ? `${providerId}/${remoteId}${REASONING_VARIANT_SEPARATOR}${model.reasoningEffort}`
      : `${providerId}/${remoteId}`,
    remoteId,
    apiType: model.apiType === "anthropic" ? "anthropic-messages" : model.apiType,
  };
}

export function baseModelReference(modelReference: string): string {
  const separator = modelReference.lastIndexOf(REASONING_VARIANT_SEPARATOR);
  return separator === -1 ? modelReference : modelReference.slice(0, separator);
}

export function providerHasModelReference(provider: CustomProvider, modelReference: string): boolean {
  const baseReference = baseModelReference(modelReference);
  return provider.models.some((model) =>
    model.id === baseReference
    || `${provider.id}/${model.remoteId || model.id}` === baseReference
  );
}

export function providerModelVariants(model: ProviderModel): ProviderModel[] {
  if (model.reasoningEffort) return [model];
  const compatibleEfforts = Array.isArray(model.compat?.supportedReasoningEfforts)
    ? model.compat.supportedReasoningEfforts
    : [];
  const supportedEfforts = model.supportedReasoningEfforts?.length
    ? model.supportedReasoningEfforts
    : compatibleEfforts.filter((effort): effort is ReasoningEffort =>
      effort === "minimal" || effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh"
    );
  const supported = supportedEfforts
    .filter((effort, index, efforts) => REASONING_EFFORT_ORDER.includes(effort) && efforts.indexOf(effort) === index)
    .sort((a, b) => REASONING_EFFORT_ORDER.indexOf(a) - REASONING_EFFORT_ORDER.indexOf(b));
  if (supported.length === 0) return [model];
  return [
    { ...model, name: `${model.name} · Provider Default` },
    ...supported.map((effort) => ({
      ...model,
      id: `${model.id}${REASONING_VARIANT_SEPARATOR}${effort}`,
      name: `${model.name} · ${REASONING_EFFORT_LABELS[effort]}`,
      reasoningEffort: effort,
    })),
  ];
}

export function normalizeStoredProvider(
  provider: CustomProvider,
  configVersion = PROVIDER_CONFIG_VERSION,
): CustomProvider {
  const providerId = normalizedProviderId(provider.id, configVersion);
  const apiType = provider.apiType === "anthropic" ? "anthropic-messages" : provider.apiType;
  const builtInBearerProviders = new Set(["openai", "opencode", "opencode-go", "github-models"]);
  const inferredAuthType = providerId === "github-copilot" || providerId === "openai-codex"
    ? "environment"
    : providerId === "anthropic"
    ? "anthropic"
    : builtInBearerProviders.has(providerId) || provider.apiKey
      ? "bearer"
      : "none";
  return {
    ...provider,
    id: providerId,
    name: configVersion < PROVIDER_CONFIG_VERSION && provider.id === "github-copilot"
      ? "GitHub Models"
      : provider.name,
    apiType,
    authType: provider.authType || inferredAuthType,
    models: (provider.models || []).map((model) => normalizeProviderModel(model, provider.id, providerId)),
  };
}

export function normalizeStoredModelReference(
  model: string | undefined,
  configVersion = PROVIDER_CONFIG_VERSION,
): string | undefined {
  if (!model) return model;
  return configVersion < PROVIDER_CONFIG_VERSION && model.startsWith("github-copilot/")
    ? `github-models/${model.slice("github-copilot/".length)}`
    : model;
}

/**
 * Providers whose models may appear in model selectors.
 *
 * The selected provider remains available because built-in integrations can
 * receive credentials from the sidecar environment. Other providers must be
 * explicitly configured so untouched built-in catalogs do not leak into every
 * model dropdown.
 */
export function selectableModelProviders(
  providers: CustomProvider[],
  selectedProviderId: string | null,
): CustomProvider[] {
  return providers.filter((provider) =>
    provider.id === selectedProviderId
    || provider.authType === "none"
    || provider.authType === "environment"
    || Boolean(provider.apiKey?.trim())
  );
}

export function selectableProviderModels(
  providers: CustomProvider[],
  selectedProviderId: string | null,
): Array<{ provider: CustomProvider; model: ProviderModel }> {
  return selectableModelProviders(providers, selectedProviderId).flatMap((provider) =>
    provider.models
      .filter((model) => model.supported !== false)
      .flatMap(providerModelVariants)
      .map((model) => ({ provider, model }))
  );
}
