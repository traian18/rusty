// ============================================================
// constants.ts — Form-level constants for MCP integration
// ============================================================

import type { TransportType, AuthType, McpFormValues } from "./types";

/** Transport protocol options for the MCP server connection. */
export const TRANSPORT_OPTIONS: { value: TransportType; label: string }[] = [
  { value: "http", label: "HTTP (Streamable)" },
  { value: "sse", label: "SSE (Server-Sent Events)" },
  { value: "websocket", label: "WebSocket" },
  { value: "stdio", label: "Stdio (local process)" },
];

/** Authentication method options for the MCP server. */
export const AUTH_OPTIONS: { value: AuthType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "apiKey", label: "API Key (header)" },
  { value: "bearer", label: "Bearer Token" },
  { value: "oauth2", label: "OAuth 2.0" },
];

/** OAuth 2.0 grant type options. */
export const GRANT_OPTIONS: { value: string; label: string }[] = [
  { value: "client_credentials", label: "Client Credentials" },
  { value: "authorization_code", label: "Authorization Code" },
];

/**
 * Default form values used when no initial config is provided.
 * Mirrors the shape of McpFormValues with sensible defaults.
 */
export const EMPTY_FORM_VALUES: McpFormValues = {
  name: "",
  displayName: "",
  description: "",
  enabled: true,
  transportType: "http",
  url: "",
  command: "",
  args: [],
  env: [],
  authType: "none",
  header: "",
  value: "",
  token: "",
  clientId: "",
  clientSecret: "",
  tokenUrl: "",
  scopesText: "",
  grantType: "client_credentials",
  timeout: 30000,
  maxRetries: 3,
  retryDelay: 1000,
};
