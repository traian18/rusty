# Architecture and Invariants

This document records the structural rules the codebase is meant to follow,
alongside the places it honestly does not yet follow them. `REFACTOR_PLAN.md`
sequences the work that closes those gaps; this file exists so each PR in
that plan has a stable set of invariants to check itself against, rather than
rediscovering them from scratch.

## Project topology

Three independent npm projects, not an npm/pnpm workspace:

- **Root** (`package.json`) — the Tauri frontend. ESM (`"type": "module"`),
  `moduleResolution: "bundler"`, built with Vite.
- **`agent-sidecar/`** — the headless Node agent runner. CommonJS,
  `moduleResolution: "node"`, its own `package.json` and lockfile.
- **`shared/`** — a source-only package (`shared/agentProtocol.ts`) consumed
  by both sides via relative import. `agent-sidecar/tsconfig.json` pulls it
  in with `rootDir: ".."`, so it is compiled twice, once under each side's
  module settings.

**Invariant:** `shared/` must stay dependency-free and syntactically valid
under both ESM/bundler and CommonJS/node resolution. This is the constraint
PR 4 (shared agent protocol) leans on hardest — anything added there has to
compile cleanly on both sides.

## Layer boundaries

The intended flow is:

```
components (React) -> zustand store slices -> services -> transport
                                                  (Tauri invoke | sidecar WebSocket | LSP)
```

**Rule:** slices must not import React; components must not construct
transports directly.

Current violations, recorded rather than hidden:

- `createGitSlice.ts` and `createIntegrationSlice.ts` import `invoke` from
  `@tauri-apps/api/core` at module scope — slices reaching directly into the
  transport layer. Targeted by PR 3/PR 4.
- Components own agent WebSockets directly (`Workspace.tsx`'s
  `executeNode`/`socketsRef`) instead of going through a shared client.
  Targeted by PR 4 and PR 7.

## Slice import-time purity

**Rule:** a slice creator must not perform I/O at creation time — no
`localStorage` reads, no timers, no network calls before the first user
action.

Current violations:

- `createIntegrationSlice.ts:151-152` calls `loadStoredMcpServers()` and
  `loadStoredThemeId()` during slice creation; `loadStoredThemeId` calls
  `localStorage.getItem` with no `typeof localStorage` guard, so importing
  the composed store throws under a bare Node environment.
- `createMetricsSlice.ts:16-24` calls `agentHarnessClient.subscribeAll(...)`
  at slice-creation time, touching the `agentHarnessClient` singleton (which
  reads `SIDECAR_WS_URL` in its constructor).

This is exactly why the tab/editor characterization tests
(`src/store/slices/createEditorSlice.test.ts`,
`src/store/slices/createAgentSlice.test.ts`) compose only the slices under
test via `src/test/tabTestStore.ts`, rather than importing the composed
`src/store.ts`. PR 3 (startup procedure) is where this gets fixed at the
source.

## Tab identity

The target model (full detail in `REFACTOR_PLAN.md`'s "Tab architecture"
section) is a single `tabs`/`activeTabId` collection with a typed registry
governing uniqueness, identity, and lifecycle per tab type.

Today, identity is computed ad hoc at each call site, in at least two
incompatible formats for file tabs alone:

- `` `file_${path.replace(/[^a-zA-Z0-9]/g, "_")}` `` — used in
  `FileTree.tsx`, `SearchPalette.tsx`, `AgentTab.tsx`,
  `FileTreePresenter.ts`, and `contextNode/helpers.ts`'s `sanitizeTabId`.
- `` `file-${path}` `` — used in `monacoLspBinding.ts` and `FileTab.tsx`.

These diverge for the same file (opening it from the tree vs. from "go to
definition" can produce two tabs for one file) and the first scheme is not
injective (`/a/b.ts` and `/a-b.ts` collide). `git-history` tabs have a
similar split between a fixed id and a key-scoped id. See
`src/components/tabs/tabIdentity.test.ts` for the executable record of the
current state.

`src/components/tabs/TabRegistry.ts` already declares a `TAB_CONFIGS` table
with per-type `isSingleton`/`allowDuplicates` flags, but it is **dead code**
today — nothing imports it. PR 1 makes it authoritative; until then, treat it
as documentation of intent rather than a source of truth.

## Migration rules (for PRs 1-7)

- Each PR leaves the app buildable (`npm run build` passes) at every commit
  that lands on the target branch.
- Each PR removes its superseded path before it is considered complete — no
  parallel old/new implementations surviving past the PR that replaces them.
- A behavior change is first pinned by a characterization test, which the
  same PR then deliberately updates (not silently, and not in a later PR) to
  reflect the new intended behavior.
- `npm run verify` is green before merge.

## Testing topology

| Layer | Runner | Scope |
|---|---|---|
| Frontend (`src/**`) | vitest | `src/**/*.test.{ts,tsx}` (see `vitest.config.ts`) |
| Sidecar (`agent-sidecar/src/**`) | Node's built-in `node --test` + `ts-node` | `agent-sidecar/src/**/*.test.ts` |
| Rust (`src-tauri/src/git/**`) | `cargo test` | in-crate `#[cfg(test)]` modules |

Why the frontend has a separate `tsconfig.test.json`: the root
`tsconfig.json` (`include: ["src", "shared"]`, no `exclude`) backs
`npm run build`'s release-gating `tsc` step. Test files are excluded from it
so a test-only type error never blocks a release build, and are instead
typechecked at the same strictness via `npm run typecheck:test` against
`tsconfig.test.json`.

Why the store tests never import the composed `src/store.ts`: see "Slice
import-time purity" above. `src/test/tabTestStore.ts` composes only the
slices under test, and that pattern should be followed by any future slice
test rather than reaching for the full store.
