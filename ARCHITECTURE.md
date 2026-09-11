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
  Targeted by PR 4 and PR 7. This is also why the `agent` tab policy declares
  `keepAlive: "always"` — an agent's run dies with its component.

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

This is exactly why the tab characterization tests
(`src/store/slices/createTabsSlice.test.ts`,
`src/store/slices/createAgentSlice.test.ts`) compose only the slices under
test via `src/test/tabTestStore.ts`, rather than importing the composed
`src/store.ts`. PR 3 (startup procedure) is where this gets fixed at the
source.

## The tab system

Tabs live in a single flat collection — `tabs: TabInstance[]` plus
`activeTabId` — and every behavioral decision about a tab type is declared once
in `src/tabs/`, not re-derived at call sites.

**`TabInstance` is a discriminated union on `type`**, with per-type fields
named for what they are: `{type:"file", path, line?}`,
`{type:"git-diff", repoPath, path, diffType, commitHash?}`. There is no
general-purpose `key` field; the old one meant a file path, a canvas id or a
task node id depending on the tab type, which is exactly what made call sites
guess.

**The registry is split in two tables keyed by the same `TabType`**, and that
split is load-bearing:

| Module | Owns | Imported by |
|---|---|---|
| `src/tabs/policy.ts` | identity, uniqueness, keepAlive, close guards, prune rules | the store |
| `src/tabs/views.tsx` | React component, icon, surface | the view only |

Keeping them apart is what lets the store declare tab behavior without pulling
all 13 tab components into its import graph — which would make the store
untestable under a bare Node environment. `src/tabs/layering.test.ts` fails the
build if `src/store/**` or any non-view `src/tabs/*.ts` imports React or
`views.tsx`. For the same reason, non-store cleanup lives in
`src/tabs/effects.ts` rather than in the policy table: a policy that reached
into services would create a store → policy → service → store cycle.

**Identity rules.** `openTab(request)` resolves the policy, computes a
canonical identity, and either activates the existing tab with that id or
creates one — so `id === identity` for every live tab. Global singletons use
their own type name as the identity, which means the ordinary lookup doubles as
the singleton check with no special-casing. File identity is a canonicalized,
root-resolved path; case folding applies to the identity string only, never to
the stored `path`, which is handed verbatim to Tauri, Monaco and git. Canvas
identity is deliberately unprefixed because `canvasFileService` round-trips it
through `.rusty/canvas/*.json`.

**Close guards are pure.** `evaluateClose(state, tabId)` returns either
`allow` or a description of what needs confirming; the view renders the modal.
Every close affordance — tab strip, overflow menu, keyboard shortcut — routes
through the `src/tabs/closeRequests.ts` event channel so the guards cannot be
bypassed.

## The application shell

The shell (PR 2) is composition, not logic: every file under
`src/components/shell/`, `navigation/`, `drawer/`, and `workspace/` is thin —
either a container reading the store and handing props down, or a `.view.tsx`
rendering them. Behavior lives in `createUiSlice` and two pure modules
(`preferences/shellLayout.ts`, `components/shell/consoleFormat.ts`), which is
what makes the shell testable at the store level without `@testing-library/
react` (see "Testing topology" below).

```
App  (DevLogBridge, GlobalShortcuts, AlertModal — all outside the boundary)
└── AppBootstrapBoundary        (hydrateUi, initTerminalState, loadSecureConfig, loadSkills)
    └── AppShell
        ├── Header
        ├── NavigationRail      (sibling of the card — see below)
        ├── .surface            (the one bordered/radiused/shadowed card; overflow: hidden)
        │   ├── ContextDrawer   ({drawerOpen && …}, lazy-loaded content)
        │   └── MainWorkspace   (wraps Workspace.tsx — does not absorb it, see "The tab system")
        └── SearchPalette       ({searchOpen && …})
```

**`DevLogBridge`, `GlobalShortcuts`, and `AlertModal` mount outside
`AppBootstrapBoundary`, on purpose.** `DevLogBridge` needs to be capturing
`console.error` before the boundary can fail into it; `GlobalShortcuts`
registers once, for the app's lifetime, with `[]` deps — reading
`keyboardShortcuts` live via `useWorkspaceStore.getState()` inside the handler
rather than subscribing, which is what keeps Cmd+R/Cmd+K suppression working
during boot and prevents the store from re-registering the listener every time
an unrelated field changes (the bug this replaced: the old listener's
dependency array included a callback whose identity changed on every sidebar
width commit).

**The rail is a sibling of `.surface`, never a child.** `.surface`'s `overflow:
hidden` is what collapses what used to be two floating cards (rail + drawer,
each with their own border/radius/shadow) into one; a `Tooltip` placed
`"right"` on a rail button would be clipped by that same `overflow: hidden` if
the rail were inside it. `NavigationRail.module.css` carries a comment
warning against ever adding `overflow` to `.rail` for the same reason.

**Drawer state lives in `createUiSlice`, not component state.** `drawerOpen`,
`drawerView`, `drawerWidth`, and `searchOpen` are UI-only state with one
persisted field (`drawerWidth`, via `preferences/shellLayout.ts`, mirroring
`preferences/shortcuts.ts`'s `typeof localStorage` guard). Per "Slice
import-time purity" above, the slice initializes `drawerWidth` to a constant
and only reads `localStorage` inside `hydrateUi()`, called once from
`AppBootstrapBoundary` — not at slice creation.

`toggleDrawerView` (the rail's click handler) and `openDrawer` (used by
`revealFileInTree`) are deliberately different actions: the former closes the
drawer on a same-view re-press, the latter never closes it. `revealFileInTree`
(`createWorkspaceSlice.ts`) sets `drawerOpen`/`drawerView` in the *same*
`set()` call as `revealPath`/`expandedPaths` — not via a `window` event on a
later tick — because `ContextDrawer` (and `FileTree` inside it) only exists in
the tree once `drawerOpen` is true; a listener reacting after the fact risked
firing before anything existed to consume `revealPath`.

**GPU compositing is composed, not classname-matched.** `src/styles/
compositing.module.css`'s `.gpuLayer` is `composed` into each surface's CSS
Module (`MainWorkspace.module.css`, `ContextDrawer.module.css`, `TabStrip
.module.css`) rather than targeted by a global selector in `index.css` listing
each surface's classname by hand — the latter is exactly how three surfaces'
worth of hardware acceleration silently stopped applying, one at a time, as
this refactor renamed them. `index.css` keeps only `.monaco-editor`, which
nothing here renames.

**`Tooltip` (`components/ui/Tooltip/`) wraps its trigger; it does not live
inside it.** `aria-label` on the trigger stays its accessible *name*;
`aria-describedby` (pointing at the tooltip's own id) is its *description* —
folding tooltip text into the trigger's own children, as the pre-PR-2 sidebar
did, makes an icon button announce its label twice.

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
