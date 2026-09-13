import { describe, expect, it } from "vitest";
import {
  BACKGROUND_POLL_INTERVAL_MS,
  FAST_POLL_INTERVAL_MS,
  FAST_POLL_MAX_DURATION_MS,
  isFastPollExpired,
  nextPollDelayMs,
  TAB_OPEN_POLL_INTERVAL_MS,
} from "./schedule";

const NOW = 1_000_000_000;

describe("nextPollDelayMs", () => {
  it("polls fast while connecting, within the cap", () => {
    expect(
      nextPollDelayMs({ isConnecting: true, connectingSinceMs: NOW - 1_000, isSetupTabOpen: false }, NOW),
    ).toBe(FAST_POLL_INTERVAL_MS);
  });

  it("polls fast even with the setup tab open -- fast beats tab-open", () => {
    expect(
      nextPollDelayMs({ isConnecting: true, connectingSinceMs: NOW - 1_000, isSetupTabOpen: true }, NOW),
    ).toBe(FAST_POLL_INTERVAL_MS);
  });

  it("drops to the tab-open tier once the fast-poll cap is reached", () => {
    expect(
      nextPollDelayMs(
        { isConnecting: true, connectingSinceMs: NOW - FAST_POLL_MAX_DURATION_MS, isSetupTabOpen: true },
        NOW,
      ),
    ).toBe(TAB_OPEN_POLL_INTERVAL_MS);
  });

  it("drops to the background tier once the fast-poll cap is reached and the tab is closed", () => {
    expect(
      nextPollDelayMs(
        { isConnecting: true, connectingSinceMs: NOW - FAST_POLL_MAX_DURATION_MS, isSetupTabOpen: false },
        NOW,
      ),
    ).toBe(BACKGROUND_POLL_INTERVAL_MS);
  });

  it("treats 'connecting' with no connectingSinceMs as not fast -- never trust an unstamped streak", () => {
    expect(nextPollDelayMs({ isConnecting: true, isSetupTabOpen: false }, NOW)).toBe(
      BACKGROUND_POLL_INTERVAL_MS,
    );
  });

  it("uses the tab-open tier when idle and the setup tab is open", () => {
    expect(nextPollDelayMs({ isConnecting: false, isSetupTabOpen: true }, NOW)).toBe(
      TAB_OPEN_POLL_INTERVAL_MS,
    );
  });

  it("uses the background tier when idle and the setup tab is closed", () => {
    expect(nextPollDelayMs({ isConnecting: false, isSetupTabOpen: false }, NOW)).toBe(
      BACKGROUND_POLL_INTERVAL_MS,
    );
  });

  it("three sidecar requests every ten seconds forever is exactly what the background tier must not be", () => {
    // The naive "just lift today's 10s poll to global scope" regression
    // this schedule exists to avoid -- pinned as an explicit inequality
    // rather than trusting a constant never gets fat-fingered back down.
    expect(BACKGROUND_POLL_INTERVAL_MS).toBeGreaterThan(TAB_OPEN_POLL_INTERVAL_MS * 10);
  });
});

describe("isFastPollExpired", () => {
  it("is false right when a connecting streak starts", () => {
    expect(isFastPollExpired(NOW, NOW)).toBe(false);
  });

  it("is false just under the cap", () => {
    expect(isFastPollExpired(NOW - (FAST_POLL_MAX_DURATION_MS - 1), NOW)).toBe(false);
  });

  it("is true exactly at the cap", () => {
    expect(isFastPollExpired(NOW - FAST_POLL_MAX_DURATION_MS, NOW)).toBe(true);
  });

  it("is true well past the cap", () => {
    expect(isFastPollExpired(NOW - FAST_POLL_MAX_DURATION_MS * 3, NOW)).toBe(true);
  });
});
