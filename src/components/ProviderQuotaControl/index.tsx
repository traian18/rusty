import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWorkspaceStore } from "../../store";
import type { CustomProvider } from "../../store";
import { isEligibleForQuota } from "../../integrations/discoveryPolicy";
import { providerStatusOrUnknown } from "../../integrations/registryTypes";
import { refreshProviderQuota, setQuotaWatch } from "../shell/providerCoordinator";
import type { Option } from "../CustomSelect";
import { ProviderQuotaControlView } from "./ProviderQuotaControl.view";
import { SELECTED_QUOTA_PROVIDER_KEY } from "./helpers";

/**
 * Controls the display of provider quota information. All fetching,
 * caching, the module-global stale-response counter, and the 5-minute
 * auto-refresh now live in providerCoordinator.ts's quota watch
 * (REFACTOR_PLAN.md PR 3b) -- this component's own job is reduced to:
 * which provider is selected in the dropdown, and telling the coordinator
 * to watch it. Quota data itself is read straight from the registry
 * (providerStatus[id].quota/quotaError/quotaLoading), so it survives this
 * component unmounting and is visible to any other surface that reads the
 * registry, unlike the local state this replaces.
 *
 * Eligibility (`isEligibleForQuota`) now checks the registry's actual
 * status for managed providers, rather than the old isConfiguredProvider
 * (deleted -- see helpers.ts's history), which treated authType
 * "environment" as always configured regardless of whether the provider
 * was actually signed in.
 */
export const ProviderQuotaControl: React.FC = () => {
  const customProviders = useWorkspaceStore((s) => s.customProviders);
  const activeProviderId = useWorkspaceStore((s) => s.activeCustomProviderId);
  const providerStatus = useWorkspaceStore((s) => s.providerStatus);

  const providers = useMemo(
    () =>
      customProviders.filter((provider) =>
        isEligibleForQuota({
          isManaged: MANAGED_PROVIDER_IDS.has(provider.id),
          statusKind: providerStatusOrUnknown(providerStatus, provider.id).kind,
          authType: provider.authType,
          hasApiKey: Boolean(provider.apiKey?.trim()),
        }),
      ),
    [customProviders, providerStatus],
  );

  const [selectedId, setSelectedId] = useState(() =>
    localStorage.getItem(SELECTED_QUOTA_PROVIDER_KEY) || activeProviderId || "",
  );
  const [open, setOpen] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);

  const selectedProvider = providers.find((p) => p.id === selectedId) ?? null;
  const selectedEntry = selectedProvider ? providerStatusOrUnknown(providerStatus, selectedProvider.id) : undefined;
  const selectedQuota = selectedEntry?.quota;
  const selectedError = selectedEntry?.quotaError;
  const loading = Boolean(selectedEntry?.quotaLoading);

  /* ── Effects ───────────────────────────────────────────────────────────── */

  useFallbackProviderEffect(providers, activeProviderId, selectedId, setSelectedId);
  usePersistSelectedIdEffect(selectedId);
  useQuotaWatchEffect(selectedProvider);
  useDismissEffect(open, setOpen, rootRef);

  /* ── Handlers ──────────────────────────────────────────────────────────── */

  const handleToggleOpen = useCallback(() => {
    setOpen((v) => !v);
  }, []);

  const handleProviderChange = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const handleRefresh = useCallback(() => {
    if (!selectedProvider) return;
    refreshProviderQuota(selectedProvider);
  }, [selectedProvider]);

  const handleOpenManageUrl = useCallback(() => {
    if (selectedQuota?.manageUrl) {
      void openUrl(selectedQuota.manageUrl);
    }
  }, [selectedQuota?.manageUrl]);

  /* ── Derived data ──────────────────────────────────────────────────────── */

  const providerOptions: Option[] = useMemo(
    () => providers.map((p) => ({ id: p.id, name: p.name })),
    [providers],
  );

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <ProviderQuotaControlView
      selectedProvider={selectedProvider}
      selectedQuota={selectedQuota}
      selectedError={selectedError}
      loading={loading}
      open={open}
      providerOptions={providerOptions}
      rootRef={rootRef}
      onToggleOpen={handleToggleOpen}
      onProviderChange={handleProviderChange}
      onRefresh={handleRefresh}
      onOpenManageUrl={handleOpenManageUrl}
    />
  );
};

export default ProviderQuotaControl;

const MANAGED_PROVIDER_IDS = new Set(["github-copilot", "openai-codex", "anthropic-claude-code"]);

/* ── Effects ─────────────────────────────────────────────────────────────── */

/**
 * Falls back to the active or first provider when the current selection
 * is no longer available.
 */
function useFallbackProviderEffect(
  providers: CustomProvider[],
  activeId: string | null,
  selectedId: string,
  setSelectedId: React.Dispatch<React.SetStateAction<string>>,
) {
  useEffect(() => {
    const isSelectedStillValid = providers.some((p) => p.id === selectedId);
    if (isSelectedStillValid) return;

    const fallback = providers.find((p) => p.id === activeId) || providers[0];
    if (fallback) setSelectedId(fallback.id);
  }, [activeId, providers, selectedId, setSelectedId]);
}

/**
 * Persists the selected provider ID to localStorage.
 */
function usePersistSelectedIdEffect(selectedId: string) {
  useEffect(() => {
    if (!selectedId) return;
    localStorage.setItem(SELECTED_QUOTA_PROVIDER_KEY, selectedId);
  }, [selectedId]);
}

/**
 * Tells the coordinator's quota watch which provider to track, on mount and
 * whenever the selection changes -- replaces the old useQuotaFetchEffect +
 * useAutoRefreshEffect pair, both of which owned local fetch/interval logic
 * this component no longer does.
 */
function useQuotaWatchEffect(provider: CustomProvider | null) {
  useEffect(() => {
    setQuotaWatch(provider);
  }, [provider]);
}

/**
 * Handles outside-click and Escape-key dismissal for the dropdown.
 */
function useDismissEffect(
  open: boolean,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  rootRef: React.RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (!open) return;

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-custom-select-dropdown]")) return;
      if (!rootRef.current?.contains(target)) setOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, setOpen, rootRef]);
}
