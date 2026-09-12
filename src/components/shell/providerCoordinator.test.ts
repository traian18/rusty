import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../store";
import { llmIntegrationService } from "../../services/llmIntegrationService";
import {
  mapManagedStatus,
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
  },
}));

function resetManagedProviderStatus() {
  useWorkspaceStore.setState({
    providerStatus: {},
    tabs: [],
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
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopProviderCoordinator();
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
});
