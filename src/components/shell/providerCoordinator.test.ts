import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../store";
import { llmIntegrationService } from "../../services/llmIntegrationService";
import {
  logoutManaged,
  mapManagedStatus,
  refreshProviderQuota,
  setQuotaWatch,
  startManagedLogin,
  startProviderCoordinator,
  stopProviderCoordinator,
} from "./providerCoordinator";
import {
  BACKGROUND_POLL_INTERVAL_MS,
  FAST_POLL_INTERVAL_MS,
  FAST_POLL_MAX_DURATION_MS,
  STALLED_LOGIN_MESSAGE,
  TAB_OPEN_POLL_INTERVAL_MS,
} from "../../integrations/schedule";

vi.mock("../../services/llmIntegrationService", () => ({
  llmIntegrationService: {
    getCopilotStatus: vi.fn(),
    getCodexStatus: vi.fn(),
    getClaudeCodeStatus: vi.fn(),
    discoverModels: vi.fn(),
    getQuota: vi.fn(),
    startCopilotLogin: vi.fn(),
    startCodexLogin: vi.fn(),
    startClaudeCodeLogin: vi.fn(),
    logoutCopilot: vi.fn(),
    logoutCodex: vi.fn(),
    logoutClaudeCode: vi.fn(),
  },
}));

/** A minimal, deterministic provider fixture -- NOT the real defaultProviders
 * (createIntegrationSlice.ts), since this test file runs against the real,
 * singleton useWorkspaceStore and must not depend on incidental fields
 * (apiKey/authType) of the app's actual default catalog. */
const REGULAR_PROVIDER_WITH_KEY = {
  id: "regular-with-key",
  name: "Regular (API key)",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  apiType: "openai-completions",
  authType: "bearer" as const,
  models: [],
};
const REGULAR_PROVIDER_NO_KEY = {
  id: "regular-no-key",
  name: "Regular (no key)",
  baseUrl: "https://example.test/v1",
  apiKey: "",
  apiType: "openai-completions",
  authType: "bearer" as const,
  models: [],
};
const MANAGED_PROVIDER_FIXTURE = {
  id: "github-copilot",
  name: "GitHub Copilot",
  baseUrl: "",
  apiKey: "",
  apiType: "copilot-sdk",
  authType: "environment" as const,
  models: [],
};

function resetManagedProviderStatus() {
  useWorkspaceStore.setState({
    providerStatus: {},
    tabs: [],
    customProviders: [REGULAR_PROVIDER_WITH_KEY, REGULAR_PROVIDER_NO_KEY, MANAGED_PROVIDER_FIXTURE],
  } as any);
}

describe("mapManagedStatus", () => {
  it("maps 'connected' to 'ready', carrying the account label through", () => {
    expect(
      mapManagedStatus({ state: "connected", authenticated: true, login: "octocat" } as any),
    ).toEqual({
      kind: "ready",
      checkedAt: expect.any(String),
      message: undefined,
      diagnostics: undefined,
      account: "octocat",
    });
  });

  it("prefers `login` over `email` when both happen to be present", () => {
    expect(
      mapManagedStatus({ state: "connected", authenticated: true, login: "octocat", email: "x@example.com" } as any)
        .account,
    ).toBe("octocat");
  });

  it("falls back to `email` for Codex/Claude Code", () => {
    expect(
      mapManagedStatus({ state: "connected", authenticated: true, email: "dev@example.com" } as any).account,
    ).toBe("dev@example.com");
  });

  it("maps 'connecting' to 'loading', carrying the device code through", () => {
    expect(
      mapManagedStatus({
        state: "connecting",
        authenticated: false,
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
      } as any),
    ).toEqual({
      kind: "loading",
      checkedAt: expect.any(String),
      message: undefined,
      diagnostics: undefined,
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
    });
  });

  it("maps 'disconnected' to 'unauthenticated' -- distinct from 'error'", () => {
    expect(mapManagedStatus({ state: "disconnected", authenticated: false } as any).kind).toBe(
      "unauthenticated",
    );
  });

  it("maps 'failed' to 'error', carrying the message and diagnostics through", () => {
    expect(
      mapManagedStatus({
        state: "failed",
        authenticated: false,
        message: "Sign-in expired.",
        diagnostics: ["exit code 1"],
      } as any),
    ).toEqual({
      kind: "error",
      checkedAt: expect.any(String),
      message: "Sign-in expired.",
      diagnostics: ["exit code 1"],
      account: undefined,
    });
  });
});

describe("providerCoordinator", () => {
  beforeEach(() => {
    resetManagedProviderStatus();
    vi.mocked(llmIntegrationService.getCopilotStatus).mockReset();
    vi.mocked(llmIntegrationService.getCodexStatus).mockReset();
    vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockReset();
    vi.mocked(llmIntegrationService.discoverModels).mockReset().mockResolvedValue([]);
    vi.mocked(llmIntegrationService.getQuota).mockReset();
    vi.mocked(llmIntegrationService.startCopilotLogin).mockReset();
    vi.mocked(llmIntegrationService.startCodexLogin).mockReset();
    vi.mocked(llmIntegrationService.startClaudeCodeLogin).mockReset();
    vi.mocked(llmIntegrationService.logoutCopilot).mockReset();
    vi.mocked(llmIntegrationService.logoutCodex).mockReset();
    vi.mocked(llmIntegrationService.logoutClaudeCode).mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopProviderCoordinator();
    setQuotaWatch(null);
    vi.useRealTimers();
  });

  it("checks all three managed providers immediately on start", async () => {
    vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
    vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
    vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

    startProviderCoordinator();
    await vi.advanceTimersByTimeAsync(0);

    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);
    expect(llmIntegrationService.getCodexStatus).toHaveBeenCalledTimes(1);
    expect(llmIntegrationService.getClaudeCodeStatus).toHaveBeenCalledTimes(1);
  });

  it("starting twice is a no-op -- does not double the in-flight checks", async () => {
    vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
    vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
    vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

    startProviderCoordinator();
    startProviderCoordinator();
    await vi.advanceTimersByTimeAsync(0);

    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);
  });

  it("writes the mapped status into the registry once a check settles", async () => {
    vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({
      state: "connected",
      authenticated: true,
      login: "octocat",
    });
    vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
    vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

    startProviderCoordinator();
    await vi.advanceTimersByTimeAsync(0);

    expect(useWorkspaceStore.getState().providerStatus["github-copilot"]).toMatchObject({
      kind: "ready",
      account: "octocat",
    });
  });

  it("bounds concurrency -- the third status check does not start until one of the first two finishes", async () => {
    let copilotResolve!: (value: any) => void;
    const copilotPending = new Promise((resolve) => (copilotResolve = resolve));
    vi.mocked(llmIntegrationService.getCopilotStatus).mockReturnValue(copilotPending as any);
    let codexResolve!: (value: any) => void;
    const codexPending = new Promise((resolve) => (codexResolve = resolve));
    vi.mocked(llmIntegrationService.getCodexStatus).mockReturnValue(codexPending as any);
    vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

    startProviderCoordinator();
    await vi.advanceTimersByTimeAsync(0);

    // Two of the three loaders were invoked; the third's underlying
    // llmIntegrationService call must not have started yet, since the
    // semaphore (concurrency 2) is holding both slots on the first two.
    expect(llmIntegrationService.getClaudeCodeStatus).not.toHaveBeenCalled();

    copilotResolve({ state: "connected", authenticated: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(llmIntegrationService.getClaudeCodeStatus).toHaveBeenCalledTimes(1);

    codexResolve({ state: "disconnected", authenticated: false });
    await vi.advanceTimersByTimeAsync(0);
  });

  it("polls again at the fast (1s) interval while a provider reports 'connecting'", async () => {
    vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "connecting", authenticated: false });
    vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
    vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

    startProviderCoordinator();
    await vi.advanceTimersByTimeAsync(0);
    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FAST_POLL_INTERVAL_MS - 1);
    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(2);
  });

  it("polls at the background (5 min) interval once settled and the setup tab is closed", async () => {
    vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "connected", authenticated: true });
    vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
    vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

    startProviderCoordinator();
    await vi.advanceTimersByTimeAsync(0);
    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL_MS - 1);
    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(2);
  });

  it("polls at the tab-open (10s) interval once settled while the LLM Setup tab is mounted", async () => {
    useWorkspaceStore.setState({
      tabs: [{ id: "llm-setup", type: "llm-setup", title: "LLM Integrations", status: "idle", dirty: false }],
    } as any);
    vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "connected", authenticated: true });
    vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
    vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

    startProviderCoordinator();
    await vi.advanceTimersByTimeAsync(0);
    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TAB_OPEN_POLL_INTERVAL_MS - 1);
    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(2);
  });

  it("drops out of the fast tier and records a stalled-login message once a connecting streak outlives the cap", async () => {
    vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "connecting", authenticated: false });
    vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
    vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

    startProviderCoordinator();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MAX_DURATION_MS);

    expect(useWorkspaceStore.getState().providerStatus["github-copilot"].message).toBe(STALLED_LOGIN_MESSAGE);
    // Sanity: the fast tier really was in effect for most of that stretch,
    // not something else entirely -- roughly one call per second.
    expect(vi.mocked(llmIntegrationService.getCopilotStatus).mock.calls.length).toBeGreaterThan(
      FAST_POLL_MAX_DURATION_MS / FAST_POLL_INTERVAL_MS - 5,
    );
  }, 20_000);

  it("stopProviderCoordinator cancels pending timers so no further checks fire", async () => {
    vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "connecting", authenticated: false });
    vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
    vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

    startProviderCoordinator();
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeStop = vi.mocked(llmIntegrationService.getCopilotStatus).mock.calls.length;

    stopProviderCoordinator();
    await vi.advanceTimersByTimeAsync(FAST_POLL_INTERVAL_MS * 5);

    expect(vi.mocked(llmIntegrationService.getCopilotStatus).mock.calls.length).toBe(callsBeforeStop);
  });

  // The requestSeq/latestRequestSeq guard (see this module's own comment
  // above applySettled/applyError) exists to protect against a manual
  // refresh -- or any other future second trigger for the same provider --
  // superseding an older, still-in-flight check. The coordinator's own
  // poll loop can never produce that race by itself (scheduleNextPoll only
  // runs after the previous check for that provider has already settled),
  // so there is nothing to exercise it against yet without leaking a
  // permanently-queued task into the shared concurrency semaphore. It gets
  // a real test once a manual-refresh entry point exists (a later commit).

  describe("background model discovery", () => {
    const discoveredModels = [{ id: "regular-with-key/some-model", name: "Some Model", supported: true }];

    it("discovers models on start for a regular provider with an API key", async () => {
      vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.discoverModels).mockImplementation(async (provider: any) =>
        provider.id === "regular-with-key" ? discoveredModels : [],
      );

      startProviderCoordinator();
      await vi.advanceTimersByTimeAsync(0);

      expect(llmIntegrationService.discoverModels).toHaveBeenCalledWith(
        expect.objectContaining({ id: "regular-with-key" }),
      );
      const provider = useWorkspaceStore.getState().customProviders.find((p) => p.id === "regular-with-key");
      expect(provider?.models).toEqual(discoveredModels);
      expect(provider?.modelsFetchedAt).toEqual(expect.any(String));
    });

    it("never discovers a regular provider with no API key", async () => {
      vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

      startProviderCoordinator();
      await vi.advanceTimersByTimeAsync(0);

      const calledIds = vi.mocked(llmIntegrationService.discoverModels).mock.calls.map((call) => call[0].id);
      expect(calledIds).not.toContain("regular-no-key");
    });

    it("does not discover a managed provider until its status is 'ready'", async () => {
      vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "connecting", authenticated: false });
      vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

      startProviderCoordinator();
      await vi.advanceTimersByTimeAsync(0);

      const calledIds = vi.mocked(llmIntegrationService.discoverModels).mock.calls.map((call) => call[0].id);
      expect(calledIds).not.toContain("github-copilot");
    });

    it("discovers a managed provider's models as soon as its status settles to 'ready'", async () => {
      vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "connected", authenticated: true });
      vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

      startProviderCoordinator();
      await vi.advanceTimersByTimeAsync(0);

      expect(llmIntegrationService.discoverModels).toHaveBeenCalledWith(
        expect.objectContaining({ id: "github-copilot" }),
      );
    });

    it("does not re-discover a catalog that was fetched within the TTL", async () => {
      useWorkspaceStore.setState((state) => ({
        customProviders: state.customProviders.map((p) =>
          p.id === "regular-with-key" ? { ...p, modelsFetchedAt: new Date().toISOString() } : p,
        ),
      }));
      vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

      startProviderCoordinator();
      await vi.advanceTimersByTimeAsync(0);

      const calledIds = vi.mocked(llmIntegrationService.discoverModels).mock.calls.map((call) => call[0].id);
      expect(calledIds).not.toContain("regular-with-key");
    });

    it("bounds discovery concurrency across providers", async () => {
      vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "connected", authenticated: true });
      vi.mocked(llmIntegrationService.getCodexStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.getClaudeCodeStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      let activeDiscoveries = 0;
      let maxObserved = 0;
      vi.mocked(llmIntegrationService.discoverModels).mockImplementation(async () => {
        activeDiscoveries++;
        maxObserved = Math.max(maxObserved, activeDiscoveries);
        await Promise.resolve();
        activeDiscoveries--;
        return [];
      });

      startProviderCoordinator();
      await vi.advanceTimersByTimeAsync(0);

      // Three eligible providers by the time copilot settles to "ready"
      // (regular-with-key, and github-copilot once ready) -- concurrency
      // is bounded at DISCOVERY_CONCURRENCY (2).
      expect(maxObserved).toBeLessThanOrEqual(2);
    });
  });

  describe("quota watch", () => {
    const quotaSnapshot = {
      providerId: "regular-with-key",
      providerName: "Regular (API key)",
      state: "available" as const,
      source: "test",
      fetchedAt: "2026-09-12T00:00:00.000Z",
      windows: [],
    };

    it("fetches quota immediately when a provider starts being watched", async () => {
      vi.mocked(llmIntegrationService.getQuota).mockResolvedValue(quotaSnapshot);

      setQuotaWatch(REGULAR_PROVIDER_WITH_KEY as any);
      await vi.advanceTimersByTimeAsync(0);

      expect(llmIntegrationService.getQuota).toHaveBeenCalledTimes(1);
      expect(useWorkspaceStore.getState().providerStatus["regular-with-key"]).toMatchObject({
        quota: quotaSnapshot,
        quotaLoading: false,
      });
    });

    it("re-fetches at the 5-minute interval while still watched", async () => {
      vi.mocked(llmIntegrationService.getQuota).mockResolvedValue(quotaSnapshot);

      setQuotaWatch(REGULAR_PROVIDER_WITH_KEY as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(llmIntegrationService.getQuota).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 - 1);
      expect(llmIntegrationService.getQuota).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(llmIntegrationService.getQuota).toHaveBeenCalledTimes(2);
    });

    it("switching the watched provider cancels the previous one's timer", async () => {
      vi.mocked(llmIntegrationService.getQuota).mockResolvedValue(quotaSnapshot);

      setQuotaWatch(REGULAR_PROVIDER_WITH_KEY as any);
      await vi.advanceTimersByTimeAsync(0);
      setQuotaWatch(REGULAR_PROVIDER_NO_KEY as any);
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(llmIntegrationService.getQuota).mockClear();

      // If the first provider's timer were still alive, this would fire an
      // extra call for it.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      expect(llmIntegrationService.getQuota).toHaveBeenCalledTimes(1);
      expect(llmIntegrationService.getQuota).toHaveBeenCalledWith(
        expect.objectContaining({ id: "regular-no-key" }),
      );
    });

    it("passing null stops watching entirely", async () => {
      vi.mocked(llmIntegrationService.getQuota).mockResolvedValue(quotaSnapshot);
      setQuotaWatch(REGULAR_PROVIDER_WITH_KEY as any);
      await vi.advanceTimersByTimeAsync(0);

      setQuotaWatch(null);
      vi.mocked(llmIntegrationService.getQuota).mockClear();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

      expect(llmIntegrationService.getQuota).not.toHaveBeenCalled();
    });

    it("records a quota error without clobbering existing status fields", async () => {
      useWorkspaceStore.getState().setProviderStatus("regular-with-key", { kind: "unknown", account: "keep-me" });
      vi.mocked(llmIntegrationService.getQuota).mockRejectedValue(new Error("quota endpoint down"));

      setQuotaWatch(REGULAR_PROVIDER_WITH_KEY as any);
      await vi.advanceTimersByTimeAsync(0);

      expect(useWorkspaceStore.getState().providerStatus["regular-with-key"]).toMatchObject({
        account: "keep-me",
        quotaError: "quota endpoint down",
        quotaLoading: false,
      });
    });

    it("refreshProviderQuota fetches once without disturbing the watch timer's own cadence", async () => {
      vi.mocked(llmIntegrationService.getQuota).mockResolvedValue(quotaSnapshot);
      setQuotaWatch(REGULAR_PROVIDER_WITH_KEY as any);
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(llmIntegrationService.getQuota).mockClear();

      refreshProviderQuota(REGULAR_PROVIDER_WITH_KEY as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(llmIntegrationService.getQuota).toHaveBeenCalledTimes(1);

      // The watch's own timer, started before the manual refresh, still
      // fires on its original schedule -- matching today's handleRefresh,
      // which never reset the underlying setInterval either.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      expect(llmIntegrationService.getQuota).toHaveBeenCalledTimes(2);
    });

    it("discards a quota response superseded by a newer request for the same provider", async () => {
      let firstResolve!: (value: any) => void;
      const firstPending = new Promise((resolve) => (firstResolve = resolve));
      vi.mocked(llmIntegrationService.getQuota)
        .mockReturnValueOnce(firstPending as any)
        .mockResolvedValueOnce({ ...quotaSnapshot, source: "second" });

      setQuotaWatch(REGULAR_PROVIDER_WITH_KEY as any);
      await vi.advanceTimersByTimeAsync(0);
      refreshProviderQuota(REGULAR_PROVIDER_WITH_KEY as any);
      await vi.advanceTimersByTimeAsync(0);

      firstResolve({ ...quotaSnapshot, source: "first-should-be-dropped" });
      await vi.advanceTimersByTimeAsync(0);

      expect(useWorkspaceStore.getState().providerStatus["regular-with-key"]?.quota?.source).toBe("second");
    });
  });

  describe("startManagedLogin / logoutManaged", () => {
    it("starts a login and re-checks status immediately, surfacing the fresh result", async () => {
      vi.mocked(llmIntegrationService.startCopilotLogin).mockResolvedValue({
        state: "connecting",
        authenticated: false,
        verificationUri: "https://github.com/login/device",
      });
      vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({
        state: "connecting",
        authenticated: false,
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
      });

      await startManagedLogin(MANAGED_PROVIDER_FIXTURE as any);
      await vi.advanceTimersByTimeAsync(0);

      expect(llmIntegrationService.startCopilotLogin).toHaveBeenCalledTimes(1);
      expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);
      expect(useWorkspaceStore.getState().providerStatus["github-copilot"]).toMatchObject({
        kind: "loading",
        userCode: "ABCD-1234",
      });
    });

    it("records an error status and rethrows when the login call itself fails", async () => {
      vi.mocked(llmIntegrationService.startCopilotLogin).mockRejectedValue(new Error("network down"));

      await expect(startManagedLogin(MANAGED_PROVIDER_FIXTURE as any)).rejects.toThrow("network down");

      expect(useWorkspaceStore.getState().providerStatus["github-copilot"]).toMatchObject({
        kind: "error",
        message: "network down",
      });
      // No status re-check on a failed login -- there's nothing fresh to
      // confirm.
      expect(llmIntegrationService.getCopilotStatus).not.toHaveBeenCalled();
    });

    it("is a no-op for a non-managed provider id", async () => {
      await startManagedLogin(REGULAR_PROVIDER_WITH_KEY as any);
      expect(llmIntegrationService.startCopilotLogin).not.toHaveBeenCalled();
      expect(llmIntegrationService.startCodexLogin).not.toHaveBeenCalled();
    });

    it("logs out and re-checks status immediately", async () => {
      vi.mocked(llmIntegrationService.logoutCopilot).mockResolvedValue({ state: "disconnected", authenticated: false });
      vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "disconnected", authenticated: false });

      await logoutManaged(MANAGED_PROVIDER_FIXTURE as any);
      await vi.advanceTimersByTimeAsync(0);

      expect(llmIntegrationService.logoutCopilot).toHaveBeenCalledTimes(1);
      expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);
      expect(useWorkspaceStore.getState().providerStatus["github-copilot"]?.kind).toBe("unauthenticated");
    });

    it("a login supersedes whatever poll timer was already scheduled -- it doesn't wait for it", async () => {
      vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "disconnected", authenticated: false });
      startProviderCoordinator();
      await vi.advanceTimersByTimeAsync(0);
      // First poll settled "disconnected" -> background cadence (minutes
      // away). Without forcePollNow, a login here would sit unconfirmed
      // until that far-off timer fires.
      vi.mocked(llmIntegrationService.getCopilotStatus).mockClear();
      vi.mocked(llmIntegrationService.startCopilotLogin).mockResolvedValue({ state: "connecting", authenticated: false });
      vi.mocked(llmIntegrationService.getCopilotStatus).mockResolvedValue({ state: "connecting", authenticated: false });

      await startManagedLogin(MANAGED_PROVIDER_FIXTURE as any);
      await vi.advanceTimersByTimeAsync(0);

      expect(llmIntegrationService.getCopilotStatus).toHaveBeenCalledTimes(1);
      expect(useWorkspaceStore.getState().providerStatus["github-copilot"]?.kind).toBe("loading");
    });
  });
});
