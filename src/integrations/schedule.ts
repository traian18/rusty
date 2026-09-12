/**
 * Pure polling cadence for the integration coordinator (REFACTOR_PLAN.md PR
 * 3b) -- a function of a status snapshot and a clock, no timers or I/O, so
 * it's testable directly under vitest's plain `environment: "node"`.
 * Everything timer-shaped (actually scheduling `setTimeout`, actually
 * calling the sidecar) lives in coordinator.ts and is verified by hand.
 *
 * Replaces today's mount-scoped useManagedProviderStatus.ts cadence (1s
 * while `state === "connecting"`, 10s otherwise, and only ever running
 * while LlmSetupTab happens to be mounted) with three tiers instead of two:
 *
 *   - `connecting`, within the fast-poll cap: 1s. Unavoidable -- Copilot's
 *     device code has no transport but a later status poll
 *     (agent-sidecar/src/services/copilotService.ts), and there is no
 *     push/event for login success anywhere in the app; polling is the
 *     only signal for all three managed providers.
 *   - otherwise, LLM Setup open: 10s. Preserves today's felt responsiveness
 *     where a human is actually watching the tab.
 *   - otherwise: 5 minutes, matching ProviderQuotaControl's existing
 *     REFRESH_INTERVAL_MS.
 *
 * The fast cap is the genuinely new part: today's 1s poll is only ever
 * bounded by the LLM Setup tab unmounting (its `keepAlive: "active-only"`
 * policy, src/tabs/policy.ts). Once polling runs outside React that
 * accidental bound disappears, so a sidecar wedged in `connecting` would
 * otherwise 1s-poll for the life of the session.
 */

export const FAST_POLL_INTERVAL_MS = 1_000;
export const FAST_POLL_MAX_DURATION_MS = 5 * 60 * 1_000;
export const TAB_OPEN_POLL_INTERVAL_MS = 10_000;
export const BACKGROUND_POLL_INTERVAL_MS = 5 * 60 * 1_000;

export const STALLED_LOGIN_MESSAGE =
  "This sign-in appears stalled. Checking less frequently -- try signing in again.";

export interface ScheduleInput {
  /** The sidecar's own reported state, not a client-side "login in
      flight" flag -- see coordinator.ts's module comment for why a
      client flag can strand (tab closed mid-login, app quit while the
      sidecar's own login attempt is still live) where the server's
      reported state is self-healing. */
  isConnecting: boolean;
  /** When the current unbroken `connecting` streak began, in ms since
      epoch. Required to mean anything when `isConnecting` is true;
      ignored otherwise. */
  connectingSinceMs?: number;
  /** Whether the LLM Setup tab is currently mounted. */
  isSetupTabOpen: boolean;
}

/** True once a continuous `connecting` streak has run past the fast-poll
 * cap -- the point at which the coordinator should both slow down and
 * write STALLED_LOGIN_MESSAGE into the entry. */
export function isFastPollExpired(connectingSinceMs: number, nowMs: number): boolean {
  return nowMs - connectingSinceMs >= FAST_POLL_MAX_DURATION_MS;
}

export function nextPollDelayMs(input: ScheduleInput, nowMs: number): number {
  const stillFast = input.isConnecting
    && input.connectingSinceMs !== undefined
    && !isFastPollExpired(input.connectingSinceMs, nowMs);
  if (stillFast) return FAST_POLL_INTERVAL_MS;
  return input.isSetupTabOpen ? TAB_OPEN_POLL_INTERVAL_MS : BACKGROUND_POLL_INTERVAL_MS;
}
