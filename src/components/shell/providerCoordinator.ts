import { useWorkspaceStore } from "../../store";
import { llmIntegrationService } from "../../services/llmIntegrationService";
import type {
  ClaudeCodeConnectionStatus,
  CodexConnectionStatus,
  CopilotConnectionStatus,
} from "../../services/llmIntegrationService";
import { createSemaphore } from "../../integrations/concurrency";
import { isFastPollExpired, nextPollDelayMs, STALLED_LOGIN_MESSAGE } from "../../integrations/schedule";
import { DISCOVERY_CONCURRENCY, isCatalogStale, isEligibleForDiscovery } from "../../integrations/discoveryPolicy";
import { providerStatusOrUnknown } from "../../integrations/registryTypes";
import type { CustomProvider, ProviderStatus } from "../../store/types";

/**
 * Owns the out-of-React polling that populates the integration registry
 * (REFACTOR_PLAN.md PR 3b) -- deliberately NOT under src/integrations/,
 * the same reason startupSteps.ts sits next to AppBootstrapBoundary.tsx
 * instead of under src/startup/: this module needs the real store and a
 * real service (llmIntegrationService), and src/integrations/
 * layering.test.ts forbids exactly those imports for the generic,
 * pure-testable pieces (registryTypes.ts, schedule.ts, concurrency.ts).
 *
 * Replaces today's three useManagedProviderStatus hooks, each mounted only
 * while LlmSetupTab is (its `keepAlive: "active-only"` policy unmounts and
 * destroys all three on tab switch) -- this runs for the life of the
 * session regardless of what tab is open, which is the entire point.
 *
 * Not started from here: startProviderCoordinator() is called once
 * AppBootstrapBoundary's startup run settles (a later commit), never at
 * this module's own import time -- providers don't exist meaningfully in
 * the store until the secure-config step completes.
 */

const MANAGED_PROVIDER_IDS = ["github-copilot", "openai-codex", "anthropic-claude-code"] as const;
type ManagedProviderId = (typeof MANAGED_PROVIDER_IDS)[number];

type ManagedStatus = CopilotConnectionStatus | CodexConnectionStatus | ClaudeCodeConnectionStatus;

const STATUS_LOADERS: Record<ManagedProviderId, () => Promise<ManagedStatus>> = {
  "github-copilot": () => llmIntegrationService.getCopilotStatus(),
  "openai-codex": () => llmIntegrationService.getCodexStatus(),
  "anthropic-claude-code": () => llmIntegrationService.getClaudeCodeStatus(),
};

/**
 * Bounds how many of the three managed-provider status checks run at once.
 * Each one can be expensive on the sidecar side (Copilot: a full SDK client
 * cold start with no server-side timeout of its own; Codex: a child-process
 * spawn plus a 20s initialize; Claude Code: up to a 10s keychain read plus a
 * 20s execFile) -- unbounded concurrency at every launch would mean all
 * three paying their worst case simultaneously.
 */
const STATUS_CHECK_CONCURRENCY = 2;
const statusCheckSemaphore = createSemaphore(STATUS_CHECK_CONCURRENCY);

interface ManagedProviderRuntime {
  timer?: ReturnType<typeof setTimeout>;
  /** When the current unbroken "connecting" streak began. Lives here,
      not in the store: it's scheduler bookkeeping schedule.ts's fast-poll
      cap needs a wall-clock anchor for, not application state any
      surface should read. */
  connectingSinceMs?: number;
}

const runtime = new Map<ManagedProviderId, ManagedProviderRuntime>();

/**
 * Discards a response that arrives after a newer request for the same
 * provider has already been issued -- the case that matters is a slow poll
 * response landing after startManagedLogin (a later commit) or a manual
 * refresh has already superseded it. A monotonic sequence number rather
 * than comparing timestamps: no clock-resolution edge cases, and it works
 * identically for a request that fails, times out, or races a stop().
 */
let requestSeq = 0;
const latestRequestSeq = new Map<ManagedProviderId, number>();

let started = false;

function isSetupTabOpen(): boolean {
  return useWorkspaceStore.getState().tabs.some((tab) => tab.type === "llm-setup");
}

/** CopilotConnectionStatus reports `login`; Codex/Claude Code report
 * `email` -- accessed via a loose cast rather than an `in` narrowing on the
 * union, which TS accepts either way but this is more obviously correct at
 * a glance. */
function accountLabel(status: ManagedStatus): string | undefined {
  const asAny = status as { login?: string; email?: string };
  return asAny.login || asAny.email || undefined;
}

/**
 * Exported for direct unit testing -- the mapping from the sidecar's
 * {state, authenticated, ...} shape to the registry's ProviderStatusKind is
 * the one piece of this module worth pinning without going through the
 * timer/network machinery around it.
 */
export function mapManagedStatus(status: ManagedStatus): ProviderStatus {
  const checkedAt = new Date().toISOString();
  const shared = {
    checkedAt,
    message: status.message,
    diagnostics: status.diagnostics,
  };
  switch (status.state) {
    case "connected":
      return { ...shared, kind: "ready", account: accountLabel(status) };
    case "connecting":
      // Unauthenticated to start (no code yet), then filled in as the
      // sidecar's own module-global login attempt progresses -- Copilot's
      // device code specifically only ever arrives via a LATER poll
      // (agent-sidecar/src/services/copilotService.ts), never the login
      // response itself.
      return { ...shared, kind: "loading", verificationUri: status.verificationUri, userCode: status.userCode };
    case "disconnected":
      return { ...shared, kind: "unauthenticated" };
    case "failed":
      return { ...shared, kind: "error" };
  }
}

function applySettled(id: ManagedProviderId, status: ManagedStatus, mySeq: number): void {
  if (latestRequestSeq.get(id) !== mySeq) return;
  useWorkspaceStore.getState().patchProviderStatus(id, mapManagedStatus(status));
  // A managed provider's models can only ever be discovered once it's
  // actually signed in -- check right away rather than waiting for the
  // next hourly sweep, so a fresh sign-in doesn't sit with an empty
  // catalog for up to an hour.
  maybeDiscoverForProvider(id);
}

function applyError(id: ManagedProviderId, error: unknown, mySeq: number): void {
  if (latestRequestSeq.get(id) !== mySeq) return;
  useWorkspaceStore.getState().patchProviderStatus(id, {
    kind: "error",
    checkedAt: new Date().toISOString(),
    message: error instanceof Error ? error.message : "Status check failed.",
  });
}

async function checkProviderStatus(id: ManagedProviderId): Promise<void> {
  const mySeq = ++requestSeq;
  latestRequestSeq.set(id, mySeq);
  try {
    const status = await statusCheckSemaphore.run(() => STATUS_LOADERS[id]());
    applySettled(id, status, mySeq);
  } catch (error) {
    applyError(id, error, mySeq);
  }
  scheduleNextPoll(id);
}

function scheduleNextPoll(id: ManagedProviderId): void {
  if (!started) return;
  const rt = runtime.get(id) ?? {};
  runtime.set(id, rt);

  const entry = useWorkspaceStore.getState().providerStatus[id];
  const isConnecting = entry?.kind === "loading";
  if (isConnecting) {
    if (rt.connectingSinceMs === undefined) rt.connectingSinceMs = Date.now();
  } else {
    rt.connectingSinceMs = undefined;
  }

  const now = Date.now();
  if (isConnecting && rt.connectingSinceMs !== undefined && isFastPollExpired(rt.connectingSinceMs, now)) {
    useWorkspaceStore.getState().patchProviderStatus(id, { message: STALLED_LOGIN_MESSAGE });
  }

  const delay = nextPollDelayMs(
    { isConnecting, connectingSinceMs: rt.connectingSinceMs, isSetupTabOpen: isSetupTabOpen() },
    now,
  );
  rt.timer = setTimeout(() => void checkProviderStatus(id), delay);
}

/**
 * Background model discovery (REFACTOR_PLAN.md PR 3b commit 7). Separate
 * from the status-check semaphore above: Copilot/Codex/Claude Code's
 * discovery calls are just as expensive as their status checks, and a
 * regular (non-managed) provider's discovery has no status-check cycle to
 * piggyback on at all, so it needs its own bound.
 */
const discoverySemaphore = createSemaphore(DISCOVERY_CONCURRENCY);
/** Guards against the same provider being discovered twice concurrently --
 * e.g. a managed provider settling to "ready" right as the hourly sweep is
 * already checking it. */
const discoveryInFlight = new Set<string>();

function isDueForDiscovery(provider: CustomProvider, nowMs: number): boolean {
  const status = providerStatusOrUnknown(useWorkspaceStore.getState().providerStatus, provider.id);
  const isManaged = (MANAGED_PROVIDER_IDS as readonly string[]).includes(provider.id);
  const eligible = isEligibleForDiscovery({
    isManaged,
    statusKind: status.kind,
    authType: provider.authType,
    hasApiKey: Boolean(provider.apiKey?.trim()),
  });
  return eligible && isCatalogStale({ modelsFetchedAt: provider.modelsFetchedAt }, nowMs);
}

/**
 * Only ever called with the CURRENT saved provider object (never a form
 * draft) -- unlike LlmSetupTab's user-initiated Fetch/Test, which must
 * operate on unsaved edits (providerWithDraftSettings, LlmSetupTab.tsx),
 * background discovery has no draft to merge: it runs against whatever is
 * already persisted. Writes only `models`/`modelsFetchedAt` -- deliberately
 * never touches activeModel, unlike LlmSetupTab's own success handler,
 * since a background refresh silently changing what the user has selected
 * would be a surprise no user asked for.
 */
async function discoverModelsForProvider(provider: CustomProvider): Promise<void> {
  if (discoveryInFlight.has(provider.id)) return;
  discoveryInFlight.add(provider.id);
  try {
    await discoverySemaphore.run(async () => {
      const models = await llmIntegrationService.discoverModels(provider);
      useWorkspaceStore.getState().updateProviderSettings(provider.id, {
        models,
        modelsFetchedAt: new Date().toISOString(),
      });
    });
  } catch (error) {
    console.error(`Background model discovery failed for "${provider.id}":`, error);
  } finally {
    discoveryInFlight.delete(provider.id);
  }
}

function maybeDiscoverForProvider(providerId: string): void {
  if (!started) return;
  const provider = useWorkspaceStore.getState().customProviders.find((candidate) => candidate.id === providerId);
  if (!provider || !isDueForDiscovery(provider, Date.now())) return;
  void discoverModelsForProvider(provider);
}

/**
 * Covers regular (non-managed) providers, which have no status-check cycle
 * to trigger discovery from, and re-checks managed providers too in case
 * one came due for a refresh between poll-driven checks. An hour between
 * sweeps against a 24h TTL is deliberately coarse -- discovery isn't
 * urgent, and every sweep tick costs at most DISCOVERY_CONCURRENCY
 * simultaneous sidecar calls.
 */
const DISCOVERY_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
let discoverySweepTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleDiscoverySweep(): void {
  if (!started) return;
  discoverySweepTimer = setTimeout(() => {
    void runDiscoverySweep().finally(scheduleDiscoverySweep);
  }, DISCOVERY_SWEEP_INTERVAL_MS);
}

async function runDiscoverySweep(): Promise<void> {
  const now = Date.now();
  const due = useWorkspaceStore.getState().customProviders.filter((provider) => isDueForDiscovery(provider, now));
  await Promise.all(due.map((provider) => discoverModelsForProvider(provider)));
}

/**
 * Quota (REFACTOR_PLAN.md PR 3b commit 8). Deliberately scoped to ONE
 * watched provider at a time, matching ProviderQuotaControl's existing
 * behavior exactly (it only ever shows the single provider selected in its
 * dropdown) -- proactively fetching quota for every eligible provider on a
 * timer would be a real, avoidable new cost: Claude Code's quota path in
 * particular re-probes fully on every single call (it deliberately bypasses
 * its own status cache, agent-sidecar/src/services/claudeCodeService.ts),
 * so there is no warm-state amortization to rely on.
 */
const QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
let quotaWatchProviderId: string | null = null;
let quotaWatchTimer: ReturnType<typeof setTimeout> | undefined;
let quotaRequestSeq = 0;
const latestQuotaRequestSeq = new Map<string, number>();

async function refreshQuotaNow(provider: CustomProvider): Promise<void> {
  const mySeq = ++quotaRequestSeq;
  latestQuotaRequestSeq.set(provider.id, mySeq);
  useWorkspaceStore.getState().patchProviderStatus(provider.id, { quotaLoading: true, quotaError: undefined });
  try {
    const quota = await llmIntegrationService.getQuota(provider);
    if (latestQuotaRequestSeq.get(provider.id) !== mySeq) return;
    useWorkspaceStore.getState().patchProviderStatus(provider.id, { quota, quotaLoading: false, quotaError: undefined });
  } catch (error) {
    if (latestQuotaRequestSeq.get(provider.id) !== mySeq) return;
    useWorkspaceStore.getState().patchProviderStatus(provider.id, {
      quotaLoading: false,
      quotaError: error instanceof Error ? error.message : "Quota request failed.",
    });
  }
}

/**
 * Sets which single provider's quota is being actively watched -- called
 * by ProviderQuotaControl on mount and whenever its selection changes.
 * Fetches immediately, then re-fetches (re-reading the provider fresh from
 * the store each time, in case its authType/apiKey changed) every
 * QUOTA_REFRESH_INTERVAL_MS. Pass null to stop watching entirely.
 */
export function setQuotaWatch(provider: CustomProvider | null): void {
  if (quotaWatchTimer !== undefined) clearTimeout(quotaWatchTimer);
  quotaWatchTimer = undefined;
  quotaWatchProviderId = provider?.id ?? null;
  if (!provider) return;

  void refreshQuotaNow(provider);
  quotaWatchTimer = setTimeout(() => {
    const current = useWorkspaceStore.getState().customProviders.find((p) => p.id === quotaWatchProviderId);
    if (current) setQuotaWatch(current);
  }, QUOTA_REFRESH_INTERVAL_MS);
}

/** The dropdown's manual "Refresh" button -- independent of the watch
 * timer's own cadence, matching today's handleRefresh (which never reset
 * the underlying setInterval either). */
export function refreshProviderQuota(provider: CustomProvider): void {
  void refreshQuotaNow(provider);
}

/**
 * Idempotent -- a second call while already started is a no-op, the same
 * shape as beginRun()'s own activeRun guard in AppBootstrapBoundary.tsx.
 */
export function startProviderCoordinator(): void {
  if (started) return;
  started = true;
  for (const id of MANAGED_PROVIDER_IDS) {
    void checkProviderStatus(id);
  }
  void runDiscoverySweep().finally(scheduleDiscoverySweep);
}

/** Cancels every pending timer and resets all bookkeeping. Exported for
 * tests, which need isolation between cases against this module's
 * otherwise-persistent state -- there is no product-code caller of this
 * today; the coordinator runs for the life of the session once started. */
export function stopProviderCoordinator(): void {
  started = false;
  for (const rt of runtime.values()) {
    if (rt.timer !== undefined) clearTimeout(rt.timer);
  }
  runtime.clear();
  latestRequestSeq.clear();
  if (discoverySweepTimer !== undefined) clearTimeout(discoverySweepTimer);
  discoverySweepTimer = undefined;
  discoveryInFlight.clear();
  if (quotaWatchTimer !== undefined) clearTimeout(quotaWatchTimer);
  quotaWatchTimer = undefined;
  quotaWatchProviderId = null;
  latestQuotaRequestSeq.clear();
}
