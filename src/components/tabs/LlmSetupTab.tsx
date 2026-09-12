import React, { useState, useEffect } from "react";
import { useWorkspaceStore, CustomProvider } from "../../store";
import { Cpu, Key, Globe, Plus, ShieldCheck, Save, Layers, Lock, Unlock, HelpCircle as HelpIcon, RefreshCw, GitBranch, Copy, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CustomSelect } from "../CustomSelect";
import { notify } from "../../notificationStore";
import { llmIntegrationService } from "../../services/llmIntegrationService";
import { providerModelVariants } from "../../store/providerHelpers";
import { providerStatusOrUnknown } from "../../integrations/registryTypes";
import { logoutManaged, startManagedLogin } from "../shell/providerCoordinator";
import { ProviderList, selectFirstSupportedModel } from "./llmSetup/ProviderList";
import { providerHelpText } from "./llmSetup/providerHelp";

const API_PROTOCOL_OPTIONS = [
  { id: "openai-completions", name: "OpenAI Chat Completions" },
  { id: "openai-responses", name: "OpenAI Responses" },
  { id: "anthropic-messages", name: "Anthropic Messages" },
  { id: "google-generative-ai", name: "Google Generative AI" },
];

const AUTH_TYPE_OPTIONS = [
  { id: "none", name: "None / Local" },
  { id: "bearer", name: "Bearer token" },
  { id: "anthropic", name: "Anthropic x-api-key" },
];

/**
 * Fits a registry ProviderStatus entry into ProviderList's existing
 * {state, authenticated, login, email, ...} prop shape (REFACTOR_PLAN.md
 * PR 3b commit 9). Temporary -- ProviderList itself starts reading
 * providerStatus directly in commit 10, at which point this and the three
 * per-row props it feeds are deleted.
 */
function toLegacyManagedStatus(entry: ReturnType<typeof providerStatusOrUnknown>) {
  return {
    state: entry.kind === "ready" ? "connected" as const
      : entry.kind === "loading" ? "connecting" as const
      : entry.kind === "error" ? "failed" as const
      : "disconnected" as const,
    authenticated: entry.kind === "ready",
    message: entry.message,
    verificationUri: entry.verificationUri,
    userCode: entry.userCode,
    diagnostics: entry.diagnostics,
    login: entry.account,
    email: entry.account,
    host: entry.host,
    planType: entry.planType,
  };
}

export const LlmSetupTab: React.FC = () => {
  const customProviders = useWorkspaceStore((state) => state.customProviders);
  const activeCustomProviderId = useWorkspaceStore((state) => state.activeCustomProviderId);
  const activeModel = useWorkspaceStore((state) => state.activeModel);
  const setActiveCustomProviderId = useWorkspaceStore((state) => state.setActiveCustomProviderId);
  const setActiveModel = useWorkspaceStore((state) => state.setActiveModel);
  const updateProviderSettings = useWorkspaceStore((state) => state.updateProviderSettings);
  const addCustomProvider = useWorkspaceStore((state) => state.addCustomProvider);
  const providerStatus = useWorkspaceStore((state) => state.providerStatus);

  // Selected provider configuration state
  const selectedProvider = customProviders.find((p) => p.id === activeCustomProviderId);
  const isCopilot = selectedProvider?.transport === "github-copilot-sdk" || selectedProvider?.id === "github-copilot";
  const isCodex = selectedProvider?.transport === "openai-codex-app-server" || selectedProvider?.id === "openai-codex";
  const isClaudeCode = selectedProvider?.transport === "anthropic-claude-agent-sdk" || selectedProvider?.id === "anthropic-claude-code";
  const isManagedAuthProvider = isCopilot || isCodex || isClaudeCode;
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [catalogUrl, setCatalogUrl] = useState("");
  const [apiType, setApiType] = useState("openai-completions");
  const [authType, setAuthType] = useState<NonNullable<CustomProvider["authType"]>>("bearer");
  const [showKey, setShowKey] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  // Only ever reflects a regular (non-managed) provider's last manual
  // Fetch/Test outcome -- managed providers' badges come from the
  // registry (providerStatus) instead, via ProviderList's managed-status
  // props below. Not lifted into the registry: this is transient,
  // form-local UI feedback about the CURRENT DRAFT, not shared state any
  // other surface needs (REFACTOR_PLAN.md PR 3b).
  const [connectionStatus, setConnectionStatus] = useState<Record<string, "connected" | "failed">>({});
  const [signingOut, setSigningOut] = useState(false);

  // One unified entry per managed provider, straight from the registry
  // (REFACTOR_PLAN.md PR 3b commit 9) -- replaces three separate
  // useManagedProviderStatus polls, each mounted only while this tab was,
  // and each destroyed the moment the user switched tabs. The coordinator
  // (providerCoordinator.ts) now polls all three for the life of the
  // session, so this tab reads whatever it's already settled to instead
  // of restarting a poll from scratch every time it mounts.
  const copilotStatus = providerStatusOrUnknown(providerStatus, "github-copilot");
  const codexStatus = providerStatusOrUnknown(providerStatus, "openai-codex");
  const claudeCodeStatus = providerStatusOrUnknown(providerStatus, "anthropic-claude-code");
  const managedStatus = selectedProvider ? providerStatusOrUnknown(providerStatus, selectedProvider.id) : undefined;
  const managedVendor = isCodex ? "OpenAI" : isClaudeCode ? "Anthropic" : "GitHub";
  const managedProduct = isCodex ? "Codex" : isClaudeCode ? "Claude Code" : "Copilot";

  // Sync inputs with selected provider
  useEffect(() => {
    if (selectedProvider) {
      setApiKey(selectedProvider.apiKey || "");
      setBaseUrl(selectedProvider.baseUrl || "");
      setCatalogUrl(selectedProvider.catalogUrl || "");
      setApiType(selectedProvider.apiType || "openai-completions");
      setAuthType(selectedProvider.authType || "bearer");
    }
  }, [activeCustomProviderId, selectedProvider]);

  // Automatically select the first model as default if activeModel is empty
  useEffect(() => {
    if (!activeModel && selectedProvider && selectedProvider.models.length > 0) {
      const firstSupportedModel = selectedProvider.models.find((model) => model.supported !== false);
      if (firstSupportedModel) setActiveModel(providerModelVariants(firstSupportedModel)[0].id);
    }
  }, [activeModel, selectedProvider, setActiveModel]);

  // Note: the old one-shot "auto-fetch models once signed in" effect
  // (managedAutoLoadRef) is gone -- providerCoordinator.ts's background
  // discovery already does this the moment a managed provider's registry
  // status settles to "ready" (REFACTOR_PLAN.md PR 3b commit 7), whether
  // or not this tab is even open.

  const providerWithDraftSettings = (): CustomProvider | null => selectedProvider
    ? isManagedAuthProvider
      ? selectedProvider
      : {
          ...selectedProvider,
          apiKey: authType === "none" ? "" : apiKey.trim(),
          baseUrl: baseUrl.trim(),
          catalogUrl: catalogUrl.trim() || undefined,
          apiType,
          authType,
        }
    : null;

  const handleSaveSettings = () => {
    if (!activeCustomProviderId || !selectedProvider) return;
    updateProviderSettings(activeCustomProviderId, {
      apiKey: authType === "none" ? "" : apiKey.trim(),
      baseUrl: baseUrl.trim(),
      catalogUrl: catalogUrl.trim() || undefined,
      apiType,
      authType,
    });
    notify("Saved", `Connection settings updated for ${selectedProvider.name}.`, "success");
  };

  const handleFetchModels = async () => {
    const provider = providerWithDraftSettings();
    if (!provider) return;

    setFetchingModels(true);
    try {
      const discoveredModels = await llmIntegrationService.discoverModels(provider);
      const models = discoveredModels.map((model) => {
        const previous = selectedProvider?.models.find((candidate) => candidate.id === model.id)
          || selectedProvider?.models.find((candidate) =>
            (candidate.remoteId || candidate.id) === (model.remoteId || model.id)
          );
        return { ...previous, ...model };
      });
      const supportedModels = models.filter((model) => model.supported !== false);
      const selectableModels = supportedModels.flatMap(providerModelVariants);
      updateProviderSettings(provider.id, {
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        catalogUrl: provider.catalogUrl,
        apiType: provider.apiType,
        authType: provider.authType,
        models,
        // Stamps the same field the coordinator's own background
        // discovery uses (REFACTOR_PLAN.md PR 3b commit 6/7) -- a manual
        // fetch counts as fresh too, so the coordinator's next sweep
        // doesn't immediately redo what the user just did by hand.
        modelsFetchedAt: new Date().toISOString(),
      });
      if (selectableModels.length > 0 && !selectableModels.some((model) => model.id === activeModel)) {
        setActiveModel(selectableModels[0].id);
      }
      setConnectionStatus((current) => ({ ...current, [provider.id]: "connected" }));
      const unsupportedCount = models.length - supportedModels.length;
      notify(
        "Models refreshed",
        `Loaded ${supportedModels.length} supported model${supportedModels.length === 1 ? "" : "s"}${unsupportedCount ? `; ${unsupportedCount} unsupported catalog entries were disabled` : ""}.`,
        supportedModels.length ? "success" : "info"
      );
    } catch (err: any) {
      setConnectionStatus((current) => ({ ...current, [provider.id]: "failed" }));
      notify("Fetch failed", `Failed to fetch models: ${err.message}`, "error");
    } finally {
      setFetchingModels(false);
    }
  };

  const handleTestConnection = async () => {
    const provider = providerWithDraftSettings();
    if (!provider) return;
    setTestingConnection(true);
    try {
      const result = await llmIntegrationService.testConnection(provider);
      setConnectionStatus((current) => ({ ...current, [provider.id]: "connected" }));
      notify("Connection successful", `${provider.name} returned ${result.modelCount} models; ${result.supportedModelCount} are supported by Rusty.`, "success");
    } catch (err: any) {
      setConnectionStatus((current) => ({ ...current, [provider.id]: "failed" }));
      notify("Connection failed", err.message || "Could not connect to the provider.", "error");
    } finally {
      setTestingConnection(false);
    }
  };

  const handleManagedLogin = async () => {
    if (!selectedProvider) return;
    try {
      await startManagedLogin(selectedProvider);
      notify(
        `${managedVendor} authorization`,
        isClaudeCode ? "Run claude and /login in a terminal, then refresh models here." : `Complete the ${managedProduct} sign-in flow in your browser.`,
        "info",
      );
    } catch (error: any) {
      notify("Sign-in failed", error?.message || `Could not start ${managedVendor} authorization.`, "error");
    }
  };

  const handleManagedLogout = async () => {
    if (!selectedProvider) return;
    setSigningOut(true);
    try {
      await logoutManaged(selectedProvider);
      notify("Signed out", `Disconnected the ${managedVendor} account from ${managedProduct}.`, "success");
    } catch (error: any) {
      notify("Sign-out failed", error?.message || `Could not sign out of ${managedProduct}.`, "error");
    } finally {
      setSigningOut(false);
    }
  };

  const handleCopyManagedCode = async () => {
    if (!managedStatus?.userCode) return;
    try {
      await navigator.clipboard.writeText(managedStatus.userCode);
      notify("Code copied", `The ${managedVendor} device code was copied to your clipboard.`, "success");
    } catch (error: any) {
      notify("Copy failed", error?.message || "Could not copy the device code.", "error");
    }
  };

  const handleOpenManagedVerification = async () => {
    const verificationUri = managedStatus?.verificationUri
      || (isCodex ? "https://auth.openai.com/codex/device" : "https://github.com/login/device");
    try {
      await openUrl(verificationUri);
    } catch (error: any) {
      notify(`Could not open ${isCodex ? "OpenAI" : "GitHub"}`, error?.message || `Open ${verificationUri} in your browser.`, "error");
    }
  };

  const handleCopyManagedDiagnostics = async () => {
    if (!managedStatus?.diagnostics?.length) return;
    try {
      await navigator.clipboard.writeText(managedStatus.diagnostics.join("\n"));
      notify("Diagnostics copied", `Paste these redacted ${managedProduct} authentication logs into the issue or chat.`, "success");
    } catch (error: any) {
      notify("Copy failed", error?.message || "Could not copy the authentication diagnostics.", "error");
    }
  };

  // Add Custom Provider Form State
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [provId, setProvId] = useState("");
  const [provName, setProvName] = useState("");
  const [provUrl, setProvUrl] = useState("http://localhost:11434/v1");
  const [provCatalogUrl, setProvCatalogUrl] = useState("");
  const [provModels, setProvModels] = useState("qwen2.5-coder:7b");
  const [provApiType, setProvApiType] = useState("openai-completions");
  const [provAuthType, setProvAuthType] = useState<"bearer" | "anthropic" | "none">("none");

  const handleAddNewProvider = (e: React.FormEvent) => {
    e.preventDefault();
    if (!provId || !provName) return;

    const providerId = provId.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
      notify("Invalid provider ID", "Use lowercase letters, numbers, dots, underscores, or hyphens. Slashes are reserved for model references.", "error");
      return;
    }
    if (customProviders.some((provider) => provider.id === providerId)) {
      notify("Provider already exists", `A provider with ID ${providerId} is already registered.`, "error");
      return;
    }
    if (!provUrl.trim()) {
      notify("Base URL required", "Enter the provider's API base URL.", "error");
      return;
    }
    const modelsList = provModels.split(",").map((m) => {
      const modelName = m.trim();
      return {
        id: `${providerId}/${modelName}`,
        remoteId: modelName,
        name: modelName.split("/").pop() || modelName,
        apiType: provApiType,
        baseUrl: provUrl.trim(),
        supported: true,
      };
    }).filter((model) => model.remoteId);

    const newProvider: CustomProvider = {
      id: provId.trim().toLowerCase(),
      name: provName.trim(),
      baseUrl: provUrl.trim(),
      apiKey: "",
      apiType: provApiType,
      authType: provAuthType,
      catalogUrl: provCatalogUrl.trim() || undefined,
      models: modelsList,
    };

    addCustomProvider(newProvider);
    setActiveCustomProviderId(newProvider.id);
    if (modelsList.length > 0) {
      setActiveModel(modelsList[0].id);
    }

    notify("Provider added", `LLM Provider ${provName} registered successfully!`, "success");
    setProvId("");
    setProvName("");
    setProvUrl("http://localhost:11434/v1");
    setProvCatalogUrl("");
    setProvModels("qwen2.5-coder:7b");
    setProvApiType("openai-completions");
    setProvAuthType("none");
    setShowAddCustom(false);
  };

  return (
    <div className="w-full h-full p-8 max-w-5xl mx-auto flex flex-col space-y-6 font-sans text-[var(--text-normal)] overflow-y-auto">
      {/* Title */}
      <div className="flex flex-col space-y-1">
        <h2 className="text-2xl font-bold text-[var(--text-light)] flex items-center space-x-2">
          <Cpu className="text-[var(--accent-color)]" size={24} />
          <span>LLM Connection Center</span>
        </h2>
        <p className="text-xs text-[var(--text-muted)] font-mono">
          Manage API credentials, target models, and local inference server endpoints.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-8">
        {/* Left Side: Providers Selection list & registration */}
        <div className="md:col-span-2 space-y-4">
          <ProviderList
            providers={customProviders}
            activeProviderId={activeCustomProviderId}
            connectionStatuses={connectionStatus}
            copilotStatus={toLegacyManagedStatus(copilotStatus)}
            codexStatus={toLegacyManagedStatus(codexStatus)}
            claudeCodeStatus={toLegacyManagedStatus(claudeCodeStatus)}
            onSelectProvider={(provider) => {
              setActiveCustomProviderId(provider.id);
              const modelId = selectFirstSupportedModel(provider);
              if (modelId) setActiveModel(modelId);
            }}
          />

          {/* Create Custom Provider Drawer button */}
          {!showAddCustom ? (
            <button
              onClick={() => setShowAddCustom(true)}
              className="w-full border border-dashed border-[var(--border-color)] hover:border-[var(--accent-color)] hover:bg-[var(--accent-bg)]/5 text-xs text-[var(--text-muted)] hover:text-[var(--text-light)] font-mono font-semibold py-3 rounded-xl transition-all flex items-center justify-center space-x-1.5 cursor-pointer"
            >
              <Plus size={14} className="text-[var(--accent-color)]" />
              <span>Register Custom LLM / Local Host</span>
            </button>
          ) : (
            <form
              onSubmit={handleAddNewProvider}
              className="bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-xl p-4 space-y-3 font-sans"
            >
              <div className="flex items-center justify-between border-b border-[var(--border-color)]/30 pb-2">
                <span className="text-xs font-bold text-[var(--text-light)] font-mono">New Custom Provider</span>
                <button
                  type="button"
                  onClick={() => setShowAddCustom(false)}
                  className="text-[var(--color-status-danger)] hover:text-[var(--color-status-danger)] text-[10px] font-mono cursor-pointer"
                >
                  Cancel
                </button>
              </div>

              <div className="space-y-2 text-xs">
                <div className="space-y-1">
                  <label className="block text-[9px] uppercase font-bold text-[var(--text-muted)] font-mono">Provider ID</label>
                  <input
                    type="text"
                    placeholder="e.g. ollama, custom-api"
                    value={provId}
                    onChange={(e) => setProvId(e.target.value)}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-lg p-2 text-xs font-mono text-[var(--text-light)] focus:outline-none focus:border-[var(--border-active)]"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] uppercase font-bold text-[var(--text-muted)] font-mono">Display Name</label>
                  <input
                    type="text"
                    placeholder="e.g. Local Ollama Runner"
                    value={provName}
                    onChange={(e) => setProvName(e.target.value)}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-lg p-2 text-xs text-[var(--text-light)] focus:outline-none focus:border-[var(--border-active)]"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] uppercase font-bold text-[var(--text-muted)] font-mono">Base API URL</label>
                  <input
                    type="text"
                    placeholder="e.g. http://localhost:11434/v1"
                    value={provUrl}
                    onChange={(e) => setProvUrl(e.target.value)}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-lg p-2 text-xs font-mono text-[var(--text-light)] focus:outline-none focus:border-[var(--border-active)]"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] uppercase font-bold text-[var(--text-muted)] font-mono">Catalog URL (Optional)</label>
                  <input
                    type="text"
                    placeholder="Defaults to {base URL}/models"
                    value={provCatalogUrl}
                    onChange={(e) => setProvCatalogUrl(e.target.value)}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-lg p-2 text-xs font-mono text-[var(--text-light)] focus:outline-none focus:border-[var(--border-active)]"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="block text-[9px] uppercase font-bold text-[var(--text-muted)] font-mono">API Protocol</label>
                    <CustomSelect
                      value={provApiType}
                      onChange={setProvApiType}
                      options={API_PROTOCOL_OPTIONS}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[9px] uppercase font-bold text-[var(--text-muted)] font-mono">Authentication</label>
                    <CustomSelect
                      value={provAuthType}
                      onChange={(value) => setProvAuthType(value as "bearer" | "anthropic" | "none")}
                      options={AUTH_TYPE_OPTIONS}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] uppercase font-bold text-[var(--text-muted)] font-mono">Models (Comma-separated)</label>
                  <input
                    type="text"
                    placeholder="qwen2.5-coder:7b, llama3.3:70b"
                    value={provModels}
                    onChange={(e) => setProvModels(e.target.value)}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-lg p-2 text-xs font-mono text-[var(--text-light)] focus:outline-none focus:border-[var(--border-active)]"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-[var(--accent-color)] hover:bg-[var(--accent-color)]/85 text-[var(--color-primary-foreground)] font-mono font-bold py-2 rounded-lg text-xs transition-all shadow-md cursor-pointer flex items-center justify-center space-x-1.5"
                >
                  <Plus size={13} />
                  <span>Register Provider</span>
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Right Side: Active Provider configuration settings editor */}
        <div className="md:col-span-3">
          {selectedProvider ? (
            <div className="bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-2xl p-6 space-y-6">
              {/* Card Header */}
              <div className="flex items-center justify-between border-b border-[var(--border-color)]/30 pb-4">
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase font-bold text-[var(--text-muted)] font-mono tracking-wider">
                    Provider Configuration
                  </span>
                  <span className="text-lg font-bold text-[var(--text-light)]">
                    {selectedProvider.name} Settings
                  </span>
                </div>

                <div className="flex items-center space-x-1 bg-[var(--bg-app)] border border-[var(--border-color)] rounded-full px-3 py-1 font-mono text-[10px] text-[var(--text-muted)]">
                  <span>ID:</span>
                  <span className="font-bold text-[var(--text-light)]">{selectedProvider.id}</span>
                </div>
              </div>

              {/* Settings Form */}
              <div className="space-y-4 text-xs">
                {isManagedAuthProvider ? (
                  <div className="space-y-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-app)]/60 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <div className={`mt-0.5 h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                          managedStatus?.kind === "ready"
                            ? "bg-[var(--color-status-success)]"
                            : managedStatus?.kind === "loading"
                              ? "bg-[var(--color-status-warning)] animate-pulse"
                              : "bg-[var(--text-muted)]"
                        }`} />
                        <div className="space-y-1">
                          <div className="font-mono text-xs font-bold text-[var(--text-light)]">
                            {managedStatus?.kind === "loading"
                              ? `Waiting for ${managedVendor} authorization`
                              : managedStatus?.kind === "ready"
                                ? `Connected${managedStatus.account ? ` as ${managedStatus.account}` : ""}`
                                : `${managedVendor} sign-in required`}
                          </div>
                          <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
                            {managedStatus?.message || (isCodex
                              ? "Use the OpenAI account connected to your Codex plan."
                              : isClaudeCode
                                ? "Use the Anthropic account connected to Claude Code."
                              : "Use the GitHub account that owns your Copilot subscription.")}
                          </p>
                          {isCopilot && managedStatus?.host && (
                            <p className="font-mono text-[9px] text-[var(--text-muted)]">{managedStatus.host}</p>
                          )}
                          {(isCodex || isClaudeCode) && managedStatus?.planType && (
                            <p className="font-mono text-[9px] text-[var(--text-muted)]">Plan: {managedStatus.planType}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-2">
                        {managedStatus?.kind === "ready" && (
                          <button
                            type="button"
                            onClick={() => void handleManagedLogout()}
                            // No `kind === "loading"` check here (unlike the
                            // Sign In button below): this button only renders
                            // when kind is already "ready", and the registry's
                            // single-discriminant status can't be both at
                            // once -- unlike the old dual-field
                            // {authenticated, state} shape, where a
                            // re-authenticate attempt could report
                            // authenticated: true and state: "connecting"
                            // simultaneously. A re-auth in progress now hides
                            // Sign Out entirely instead of disabling it.
                            disabled={signingOut}
                            className="whitespace-nowrap rounded-lg border border-[var(--border-color)] bg-[var(--bg-app)] px-3 py-2 font-mono text-[10px] font-bold text-[var(--text-normal)] transition-colors hover:border-[var(--color-status-danger)] hover:text-[var(--color-status-danger)] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {signingOut ? "Signing out…" : "Sign Out"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleManagedLogin()}
                          disabled={managedStatus?.kind === "loading"}
                          className="whitespace-nowrap rounded-lg bg-[var(--accent-color)] px-3 py-2 font-mono text-[10px] font-bold text-[var(--color-primary-foreground)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {managedStatus?.kind === "loading"
                            ? "Signing in…"
                            : managedStatus?.kind === "ready"
                              ? "Re-authenticate"
                              : isClaudeCode ? "Check Claude Login" : `Sign in with ${managedVendor}`}
                        </button>
                      </div>
                    </div>
                    {managedStatus?.kind === "loading" && managedStatus.userCode && (
                      <div className="rounded-xl border border-[var(--accent-color)]/40 bg-[var(--accent-bg)]/10 p-4 text-center">
                        <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--text-muted)]">
                          {managedVendor} device code
                        </div>
                        <button
                          type="button"
                          onClick={handleCopyManagedCode}
                          className="mt-2 font-mono text-2xl font-bold tracking-[0.18em] text-[var(--text-light)] hover:text-[var(--accent-color)]"
                          title="Copy device code"
                        >
                          {managedStatus.userCode}
                        </button>
                        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={handleCopyManagedCode}
                            className="flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-app)] px-3 py-2 font-mono text-[10px] font-bold text-[var(--text-normal)] hover:border-[var(--accent-color)] hover:text-[var(--text-light)]"
                          >
                            <Copy size={12} />
                            <span>Copy Code</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleOpenManagedVerification}
                            className="flex items-center gap-1.5 rounded-lg bg-[var(--accent-color)] px-3 py-2 font-mono text-[10px] font-bold text-[var(--color-primary-foreground)] hover:opacity-90"
                          >
                            <ExternalLink size={12} />
                            <span>Open {isCodex ? "OpenAI" : "GitHub"}</span>
                          </button>
                        </div>
                        <p className="mt-2 break-all font-mono text-[9px] text-[var(--text-muted)]">
                          {managedStatus.verificationUri
                            || (isCodex ? "https://auth.openai.com/codex/device" : "https://github.com/login/device")}
                        </p>
                      </div>
                    )}
                    {Boolean(managedStatus?.diagnostics?.length) && (
                      <details className="rounded-lg border border-[var(--border-color)]/60 bg-[var(--bg-app)]/60 p-3">
                        <summary className="cursor-pointer font-mono text-[10px] font-bold text-[var(--text-normal)]">
                          Authentication diagnostics
                        </summary>
                        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-app)] p-2 font-mono text-[9px] leading-relaxed text-[var(--text-muted)]">
                          {managedStatus?.diagnostics?.join("\n")}
                        </pre>
                        <button
                          type="button"
                          onClick={handleCopyManagedDiagnostics}
                          className="mt-2 flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] px-2.5 py-1.5 font-mono text-[9px] font-bold text-[var(--text-normal)] hover:border-[var(--accent-color)] hover:text-[var(--text-light)]"
                        >
                          <Copy size={11} />
                          <span>Copy Diagnostics</span>
                        </button>
                      </details>
                    )}
                    <div className="border-t border-[var(--border-color)]/50 pt-3 text-[10px] leading-relaxed text-[var(--text-muted)]">
                      {isCodex
                        ? "The official Codex app-server manages credentials in the same ~/.codex account used by Codex CLI/Desktop. Rusty never stores the OAuth token in provider settings."
                        : isClaudeCode
                          ? "The official Claude Agent SDK uses the local Claude Code account or sidecar API environment. Rusty never copies Claude OAuth credentials into provider settings."
                        : "GitHub Copilot CLI manages credentials, using the system credential store when available. Rusty never stores the OAuth token in provider settings."}
                    </div>
                  </div>
                ) : (
                  <>
                {/* 1. API Key Input */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="block text-xs font-bold text-[var(--text-normal)] uppercase font-mono tracking-wide flex items-center space-x-1.5">
                      <Key size={13} className="text-[var(--color-secondary)]" />
                      <span>API Authorization Key</span>
                    </label>
                    {authType !== "none" && (
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors cursor-pointer flex items-center space-x-1 font-mono"
                      >
                        {showKey ? (
                          <>
                            <Lock size={10} />
                            <span>Hide</span>
                          </>
                        ) : (
                          <>
                            <Unlock size={10} />
                            <span>Show</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  <input
                    type={showKey ? "text" : "password"}
                    placeholder={
                      selectedProvider.id === "openai" || selectedProvider.id === "anthropic"
                        ? "Enter key (falls back to process.env if left empty)"
                        : selectedProvider.id === "github-models"
                        ? "GitHub PAT with models:read scope (or use GITHUB_TOKEN)"
                        : authType === "none"
                        ? "This provider does not require a key"
                        : "Enter your API Key / Auth Token"
                    }
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={authType === "none"}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-xl px-3.5 py-2.5 text-xs text-[var(--text-light)] font-mono focus:outline-none focus:border-[var(--border-active)] placeholder-[var(--text-muted)]/70 shadow-inner disabled:opacity-50 disabled:cursor-not-allowed"
                  />

                  {(selectedProvider.id === "openai" || selectedProvider.id === "anthropic") && !apiKey && (
                    <span className="text-[10px] text-[var(--text-muted)] leading-relaxed italic block mt-1 font-mono">
                      ℹ Environment Variable configuration will be active for this provider since no custom key is provided.
                    </span>
                  )}
                  {selectedProvider.id === "github-models" && !apiKey && (
                    <span className="text-[10px] text-[var(--color-status-warning)] leading-relaxed italic block mt-1 font-mono flex items-center space-x-1">
                      <GitBranch size={10} className="flex-shrink-0" />
                      <span>Enter a PAT with <strong>models:read</strong>, or provide GITHUB_TOKEN to the sidecar environment.</span>
                    </span>
                  )}
                </div>

                {/* 2. Base URL Input */}
                <div className="space-y-2">
                  <label className="block text-xs font-bold text-[var(--text-normal)] uppercase font-mono tracking-wide flex items-center space-x-1.5">
                    <Globe size={13} className="text-[var(--color-secondary)]" />
                    <span>Connection Base URL</span>
                  </label>

                  <input
                    type="text"
                    placeholder="e.g. https://api.openai.com/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-xl px-3.5 py-2.5 text-xs text-[var(--text-light)] font-mono focus:outline-none focus:border-[var(--border-active)] placeholder-[var(--text-muted)]/70 shadow-inner"
                  />

                  {selectedProvider.id === "github-models" && (
                    <span className="text-[10px] text-[var(--text-muted)] leading-relaxed italic block mt-1 font-mono">
                      GitHub Models inference endpoint. You can change this if using a custom proxy or organizational endpoint.
                    </span>
                  )}

                </div>

                {/* 3. Model catalog URL */}
                <div className="space-y-2">
                  <label className="block text-xs font-bold text-[var(--text-normal)] uppercase font-mono tracking-wide flex items-center space-x-1.5">
                    <Layers size={13} className="text-[var(--color-secondary)]" />
                    <span>Model Catalog URL</span>
                  </label>
                  <input
                    type="text"
                    placeholder="Defaults to the base URL plus /models"
                    value={catalogUrl}
                    onChange={(e) => setCatalogUrl(e.target.value)}
                    className="w-full bg-[var(--bg-app)] border border-[var(--border-color)] rounded-xl px-3.5 py-2.5 text-xs text-[var(--text-light)] font-mono focus:outline-none focus:border-[var(--border-active)] placeholder-[var(--text-muted)]/70 shadow-inner"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <label className="block text-xs font-bold text-[var(--text-normal)] uppercase font-mono tracking-wide">
                      Default API Protocol
                    </label>
                    <CustomSelect
                      value={apiType}
                      onChange={setApiType}
                      options={API_PROTOCOL_OPTIONS}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="block text-xs font-bold text-[var(--text-normal)] uppercase font-mono tracking-wide">
                      Authentication
                    </label>
                    <CustomSelect
                      value={authType}
                      onChange={(value) => setAuthType(value as NonNullable<CustomProvider["authType"]>)}
                      options={AUTH_TYPE_OPTIONS}
                    />
                  </div>
                </div>
                  </>
                )}

                {/* 4. Default Target Model Dropdown */}
                <div className="space-y-2 pt-2">
                  <label className="block text-xs font-bold text-[var(--text-normal)] uppercase font-mono tracking-wide flex items-center space-x-1.5">
                    <Layers size={13} className="text-[var(--color-secondary)]" />
                    <span>Default Target Model</span>
                  </label>
                  <CustomSelect
                    value={activeModel}
                    onChange={(val) => setActiveModel(val)}
                    options={
                      selectedProvider.models.length > 0
                        ? selectedProvider.models
                            .filter((model) => model.supported !== false)
                            .flatMap(providerModelVariants)
                            .map((m) => ({ id: m.id, name: `${m.name} (${m.remoteId || m.id})` }))
                        : []
                    }
                    placeholder={isManagedAuthProvider && managedStatus?.kind !== "ready"
                      ? `Sign in with ${managedVendor} to load ${managedProduct} models`
                      : "No supported models available - fetch the provider catalog"}
                  />
                  {selectedProvider.models.some((model) => providerModelVariants(model).length > 1) && (
                    <span className="text-[10px] text-[var(--text-muted)] font-mono">
                      Reasoning-capable models are listed once per supported effort; the selected effort is sent with every request.
                    </span>
                  )}
                  {selectedProvider.models.some((model) => model.supported === false) && (
                    <span className="text-[10px] text-[var(--text-muted)] font-mono">
                      {selectedProvider.models.filter((model) => model.supported === false).length} catalog entries are hidden because their protocol or tool capabilities are not supported.
                    </span>
                  )}
                </div>

                {/* Save and Fetch buttons */}
                <div className="pt-4 flex flex-col space-y-3.5 border-t border-[var(--border-color)]/30">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleFetchModels}
                      disabled={fetchingModels || testingConnection || (isManagedAuthProvider && managedStatus?.kind !== "ready")}
                      className="whitespace-nowrap border border-[var(--border-color)] hover:border-[var(--accent-color)] bg-[var(--bg-app)] hover:bg-[var(--accent-bg)]/10 text-[var(--text-normal)] hover:text-[var(--text-light)] font-mono font-bold px-4 py-2.5 rounded-xl transition-all cursor-pointer flex items-center space-x-1.5 disabled:opacity-50"
                      title="Discover and normalize the provider's model catalog"
                    >
                      <RefreshCw size={13} className={fetchingModels ? "animate-spin text-[var(--accent-color)]" : ""} />
                      <span>{fetchingModels ? "Fetching..." : isManagedAuthProvider ? "Load Models" : "Fetch Models"}</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleTestConnection}
                      disabled={fetchingModels || testingConnection || (isManagedAuthProvider && managedStatus?.kind !== "ready")}
                      className="whitespace-nowrap border border-[var(--border-color)] hover:border-[var(--color-status-success-border)] bg-[var(--bg-app)] hover:bg-[var(--color-status-success-bg)] text-[var(--text-normal)] hover:text-[var(--text-light)] font-mono font-bold px-4 py-2.5 rounded-xl transition-all cursor-pointer flex items-center space-x-1.5 disabled:opacity-50"
                    >
                      <ShieldCheck size={13} className={testingConnection ? "animate-pulse text-[var(--color-status-success)]" : ""} />
                      <span>{testingConnection ? "Testing..." : "Test"}</span>
                    </button>

                    {!isManagedAuthProvider && (
                      <button
                        type="button"
                        onClick={handleSaveSettings}
                        className="whitespace-nowrap bg-[var(--accent-color)] hover:bg-[var(--accent-color)]/85 text-[var(--color-primary-foreground)] font-mono font-bold px-4 py-2.5 rounded-xl transition-all shadow-lg hover:shadow-[var(--accent-color)]/20 cursor-pointer flex items-center space-x-1.5"
                      >
                        <Save size={13} />
                        <span>Save Configuration</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center space-x-1.5 text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-app)]/50 border border-[var(--border-color)]/40 rounded-lg px-2.5 py-1.5 w-fit">
                    <ShieldCheck size={14} className="text-[var(--color-status-success)]" />
                    <span>Active Model: {activeModel || "None selected"}</span>
                  </div>
                </div>
              </div>

              {/* Informative Guidance Card */}
              <div className="bg-[var(--bg-app)] border border-[var(--border-color)] rounded-xl p-4.5 flex items-start space-x-3.5">
                <HelpIcon size={18} className="text-[var(--accent-color)] flex-shrink-0 mt-0.5" />
                <div className="flex flex-col space-y-1">
                  <span className="text-xs font-bold text-[var(--text-light)]">Integration Guide</span>
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed font-sans">
                    {providerHelpText(selectedProvider.id)}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-2xl p-8 text-center flex flex-col items-center justify-center min-h-[300px]">
              <Cpu size={40} className="text-[var(--text-muted)] opacity-30 mb-3" />
              <span className="text-sm font-bold text-[var(--text-light)] font-mono">No Active Provider Selected</span>
              <p className="text-xs text-[var(--text-muted)] max-w-sm mt-1">
                Select an LLM Integration provider from the sidebar menu to edit credentials, URLs, and customize models.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
