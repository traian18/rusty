# MCP Integration

`McpIntegrationModal` is a self-contained form for adding/editing a single MCP
(Model Context Protocol) server entry. It is rendered inside `McpIntegrationTab`,
which manages the full collection via the Zustand store's `mcpServers` state,
persisted as part of the app's encrypted secure config (`localStorage["rusty_secure_config"]`,
via `saveSecureConfig`/`loadSecureConfig` in `createIntegrationSlice.ts`). An
older, unrelated `localStorage["rusty_mcp_config"]` key was read at slice
creation but never written anywhere in the codebase; it was a dead read,
deleted in REFACTOR_PLAN.md PR 3a.

## Files

- `types.ts` — `McpServerConfig`, `McpConfigFile`, and form helper types.
- `constants.ts` — Form-level constants (transport options, auth options,
  grant options, default form values, probe timeout cap).
- `form-utils.ts` — Pure data transformation functions (`isValidUrl`,
  `toFormValues`, `toServerConfig`, `handleFormSubmit`).
- `connection-test.ts` — Connection-test types, probe functions, the
  `runConnectionTest` orchestrator, and the `useConnectionTest` hook.
- `form-sections.tsx` — Six extracted sub-components (`IdentitySection`,
  `TransportSection`, `AuthSection`, `EnvironmentSection`, `AdvancedSection`,
  `TestConnectionSection`). Each reads form state via `useFormContext`.
- `McpIntegrationModal.tsx` — The main component; a thin orchestrator that
  sets up the form, wires the hook, and composes the sections.
- `McpIntegrationModal.module.css` — Scoped styles.
- `McpIntegrationTab.tsx` — Host that lists servers and opens the modal.

## Component interface

```ts
interface McpIntegrationModalProps {
  initialConfig?: McpServerConfig; // populated when editing an existing server
  existingNames?: string[];         // for uniqueness validation
  onSave: (config: McpServerConfig) => void;
  onCancel: () => void;
}
```

`onSave` yields a **single** validated `McpServerConfig`. Your app is responsible
for assembling the persisted schema:

```ts
interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}
```

## Wiring `onSave` into your config store

The default host persists to `localStorage`. To persist into the app's Zustand
store (or any backend), replace the `handleSave` in `McpIntegrationTab` with a
store action, e.g.:

```tsx
import { useWorkspaceStore } from "../../store";

const addMcpServer = useWorkspaceStore((s) => s.addMcpServer);

const handleSave = (cfg: McpServerConfig) => {
  addMcpServer(cfg);            // store merges it into { mcpServers: { [cfg.name]: cfg } }
  setEditing(null);
};
```

Add the store slice + persistence (next to `saveSecureConfig`):

```ts
// in store.ts
mcpServers: {} as Record<string, McpServerConfig>,
addMcpServer: (cfg) => set((state) => ({
  mcpServers: { ...state.mcpServers, [cfg.name]: cfg },
})),
removeMcpServer: (name) => set((state) => {
  const next = { ...state.mcpServers };
  delete next[name];
  return { mcpServers: next };
}),
```

And include it in the secure config blob so it is saved/loaded with the rest of
the workspace:

```ts
// saveSecureConfig
await SecureStorageService.saveSecureData("rusty_secure_config", {
  ...,
  mcpServers: state.mcpServers,
});

// loadSecureConfig
if (config.mcpServers) updates.mcpServers = config.mcpServers;
```

Then pass `existingNames={Object.keys(mcpServers)}` so the uniqueness check is
driven by the real store instead of local state.

## Validation rules (enforced by react-hook-form)

- `name` — required, `/^[a-z0-9-_]+$/`, unique among `existingNames`.
- `url` — required when transport ≠ stdio, must be a valid `http(s)`/`ws(s)` URL.
- `command` — required when transport = stdio.
- Auth fields — required based on selected auth type
  (`apiKey`: header + value · `bearer`: token · `oauth2`: clientId, clientSecret,
  tokenUrl, grantType).

## Secrets

`apiKey` value, bearer `token`, and `clientSecret` use `type="password"` inputs
and are stored verbatim. Use `${ENV_VAR}` references so the real secret is
resolved from the runtime environment by the backend — they are never logged or
re-displayed in plaintext after entry.

## Test connection

- `sse` / `http` — `fetch(url, { mode: "no-cors" })` with an abortable timeout.
- `websocket` — URL validity check (browsers cannot probe `ws://`).
- `stdio` — simulated `--version` spawn (real spawn is backend-only).

Result is shown inline; no `alert()` is used.
