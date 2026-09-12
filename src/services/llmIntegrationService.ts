import type { CustomProvider, ProviderModel, ProviderQuotaSnapshot } from "../store";
import { SIDECAR_HTTP_URL } from "../config/sidecar";
import { TimeoutError } from "../startup/withTimeout";

export interface CopilotConnectionStatus {
  state: "disconnected" | "connecting" | "connected" | "failed";
  authenticated: boolean;
  authType?: string;
  host?: string;
  login?: string;
  message?: string;
  verificationUri?: string;
  userCode?: string;
  diagnostics?: string[];
}

export interface CodexConnectionStatus {
  state: "disconnected" | "connecting" | "connected" | "failed";
  authenticated: boolean;
  authType?: string;
  email?: string;
  planType?: string;
  message?: string;
  verificationUri?: string;
  userCode?: string;
  diagnostics?: string[];
}

export type ClaudeCodeConnectionStatus = CodexConnectionStatus;

/**
 * Every endpoint here previously had NO client-side timeout at all -- a
 * bare `fetch` with no signal, so a hung sidecar request could stall its
 * caller forever. Copilot gets the most slack: its status/login checks
 * have no server-side timeout of their own (agent-sidecar/src/services/
 * copilotService.ts) and pay a full SDK cold start on first use. Codex and
 * Claude Code already have generous server-side timeouts (~20s each,
 * agent-sidecar/src/services/{codexService,claudeCodeService}.ts); these
 * are set past them rather than racing them. `/llm/models` can route to
 * Codex's paginated (up to 30s/page) model list depending on the provider,
 * so it needs slack too.
 *
 * This is 3a infrastructure landing ahead of its main 3b consumer: today's
 * only caller, useManagedProviderStatus.ts's polling hook, will now
 * surface `{state: "failed"}` after the relevant timeout instead of
 * stalling indefinitely on a hung request -- a real, intentional behavior
 * change (REFACTOR_PLAN.md PR 3a), not pinned by a characterization test
 * here since that hook's own consolidation into the provider registry is
 * 3b's job, not this one's.
 */
const DEFAULT_TIMEOUT_MS = 15_000;
const ENDPOINT_TIMEOUTS_MS: Record<string, number> = {
  "/llm/models": 35_000,
  "/llm/quota": 25_000,
  "/llm/copilot/status": 30_000,
  "/llm/copilot/login": 30_000,
  "/llm/copilot/logout": 30_000,
  "/llm/codex/status": 25_000,
  "/llm/codex/login": 25_000,
  "/llm/codex/logout": 25_000,
  "/llm/claude-code/status": 25_000,
  "/llm/claude-code/login": 25_000,
  "/llm/claude-code/logout": 25_000,
};

export function resolveTimeoutMs(path: string): number {
  return ENDPOINT_TIMEOUTS_MS[path] ?? DEFAULT_TIMEOUT_MS;
}

/**
 * Exported (not part of the public llmIntegrationService object below)
 * purely so tests can inject a short `timeoutMsOverride` -- AbortSignal
 * .timeout() runs on the platform's real clock, unaffected by vitest's
 * fake timers, so exercising the real per-endpoint durations (up to 35s)
 * in a test isn't practical; resolveTimeoutMs above is what pins those.
 */
export async function request<T>(path: string, init?: RequestInit, timeoutMsOverride?: number): Promise<T> {
  const timeoutMs = timeoutMsOverride ?? resolveTimeoutMs(path);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${SIDECAR_HTTP_URL}${path}`, { ...init, signal: timeoutSignal });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new TimeoutError(`Sidecar request to ${path} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Sidecar request failed (${response.status}).`);
  return payload as T;
}

async function post<T>(path: string, provider: CustomProvider): Promise<T> {
  const connectionConfig = { ...provider, models: [] };
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: connectionConfig }),
  });
}

export const llmIntegrationService = {
  async discoverModels(provider: CustomProvider): Promise<ProviderModel[]> {
    const result = await post<{ models: ProviderModel[] }>("/llm/models", provider);
    return result.models;
  },

  async testConnection(provider: CustomProvider): Promise<{ modelCount: number; supportedModelCount: number }> {
    return post<{ ok: true; modelCount: number; supportedModelCount: number }>("/llm/test", provider);
  },

  async getQuota(provider: CustomProvider): Promise<ProviderQuotaSnapshot> {
    return post<ProviderQuotaSnapshot>("/llm/quota", provider);
  },

  async getCopilotStatus(): Promise<CopilotConnectionStatus> {
    return request<CopilotConnectionStatus>("/llm/copilot/status");
  },

  async startCopilotLogin(): Promise<CopilotConnectionStatus> {
    return request<CopilotConnectionStatus>("/llm/copilot/login", {
      method: "POST",
    });
  },

  async logoutCopilot(): Promise<CopilotConnectionStatus> {
    return request<CopilotConnectionStatus>("/llm/copilot/logout", {
      method: "POST",
    });
  },

  async getCodexStatus(): Promise<CodexConnectionStatus> {
    return request<CodexConnectionStatus>("/llm/codex/status");
  },

  async startCodexLogin(): Promise<CodexConnectionStatus> {
    return request<CodexConnectionStatus>("/llm/codex/login", {
      method: "POST",
    });
  },

  async logoutCodex(): Promise<CodexConnectionStatus> {
    return request<CodexConnectionStatus>("/llm/codex/logout", {
      method: "POST",
    });
  },

  async getClaudeCodeStatus(): Promise<ClaudeCodeConnectionStatus> {
    return request<ClaudeCodeConnectionStatus>("/llm/claude-code/status");
  },

  async startClaudeCodeLogin(): Promise<ClaudeCodeConnectionStatus> {
    return request<ClaudeCodeConnectionStatus>("/llm/claude-code/login", { method: "POST" });
  },

  async logoutClaudeCode(): Promise<ClaudeCodeConnectionStatus> {
    return request<ClaudeCodeConnectionStatus>("/llm/claude-code/logout", { method: "POST" });
  },
};
