import { afterEach, describe, expect, it, vi } from "vitest";
import { request, resolveTimeoutMs } from "./llmIntegrationService";
import { TimeoutError } from "../startup/withTimeout";

describe("resolveTimeoutMs", () => {
  it("gives Copilot's endpoints the most slack -- no server-side timeout of its own", () => {
    expect(resolveTimeoutMs("/llm/copilot/status")).toBe(30_000);
    expect(resolveTimeoutMs("/llm/copilot/login")).toBe(30_000);
    expect(resolveTimeoutMs("/llm/copilot/logout")).toBe(30_000);
  });

  it("gives Codex and Claude Code endpoints slack past their ~20s server-side timeouts", () => {
    expect(resolveTimeoutMs("/llm/codex/status")).toBeGreaterThan(20_000);
    expect(resolveTimeoutMs("/llm/claude-code/status")).toBeGreaterThan(20_000);
  });

  it("gives /llm/models the most slack of all -- can route to Codex's paginated (30s/page) list", () => {
    const modelsTimeout = resolveTimeoutMs("/llm/models");
    expect(modelsTimeout).toBeGreaterThan(30_000);
    expect(modelsTimeout).toBeGreaterThanOrEqual(resolveTimeoutMs("/llm/copilot/status"));
  });

  it("falls back to a default for an unlisted path", () => {
    expect(resolveTimeoutMs("/llm/some-future-endpoint")).toBe(15_000);
  });
});

describe("request", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves with the parsed JSON payload on a successful response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hello: "world" }),
    });

    await expect(request("/llm/test")).resolves.toEqual({ hello: "world" });
  });

  it("throws the sidecar's own error message for a non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "sidecar exploded" }),
    });

    await expect(request("/llm/test")).rejects.toThrow("sidecar exploded");
  });

  it("falls back to a generic message when a non-ok response has no error field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error("not json")),
    });

    await expect(request("/llm/test")).rejects.toThrow("Sidecar request failed (503).");
  });

  it("propagates a non-abort fetch failure as-is (e.g. connection refused)", async () => {
    const connectionError = new Error("connection refused");
    globalThis.fetch = vi.fn().mockRejectedValue(connectionError);

    await expect(request("/llm/test")).rejects.toBe(connectionError);
  });

  it("throws TimeoutError once the (overridden, short) timeout elapses on a hung request", async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    await expect(request("/llm/test", undefined, 20)).rejects.toBeInstanceOf(TimeoutError);
  }, 1000);
});
