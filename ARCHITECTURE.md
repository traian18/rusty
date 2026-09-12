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

- `createGitSlice.ts` imports `invoke` from `@tauri-apps/api/core` at module
  scope — a slice reaching directly into the transport layer.
  ~~`createIntegrationSlice.ts` did too~~ — its own `invoke` usage was the
  workspace-restore block PR 3a commit 10 extracted into
  `components/shell/startupSteps.ts`'s `restoreWorkspace`, which is a
  component-adjacent module, not a slice, so this is resolved for that file.
  `createGitSlice.ts`'s remains, targeted by PR 4/PR 5.
- Components own agent WebSockets directly (`Workspace.tsx`'s
  `executeNode`/`socketsRef`) instead of going through a shared client.
  Targeted by PR 4 and PR 7. This is also why the `agent` tab policy declares
  `keepAlive: "always"` — an agent's run dies with its component.

## Slice import-time purity

**Rule:** a slice creator must not perform I/O at creation time — no
`localStorage` reads, no timers, no network calls before the first user
action.

**Resolved in PR 3a.** All three creation-time violations this rule used to
list are fixed:

- ~~`createIntegrationSlice.ts` called `loadStoredMcpServers()` (a dead read
  besides — the key it read was never written anywhere) and
  `loadStoredThemeId()` (with no `typeof localStorage` guard) during slice
  creation.~~ `activeThemeId`/`mcpServers` now initialize to constants;
  `hydrateTheme()` does the guarded read, called from `main.tsx` synchronously
  before `createRoot` — not moved off the pre-paint path, since every
  `--color-*` variable is JS-supplied (`theme.ts`) with no CSS fallback to
  catch a flash.
- ~~`createMetricsSlice.ts` called `agentHarnessClient.subscribeAll(...)` at
  slice-creation time.~~ Moved into an explicit `initMetricsSubscription()`
  action, called once from `AppBootstrapBoundary`.
- ~~`createPreferencesSlice.ts` called `loadTypographyPreferences()`/
  `loadKeyboardShortcuts()` at creation~~ — a third violation this document
  never actually recorded. Same fix: constants at creation,
  `hydrateTypography()`/`hydrateShortcuts()` do the reads.

Concretely, this means **the composed `src/store.ts` now imports cleanly
under a bare Node environment** — verified directly: `(await
import("./store")).useWorkspaceStore.getState()` no longer throws, and no
socket opens. `src/test/tabTestStore.ts` and its siblings
(`uiTestStore.ts`, `workspaceTestStore.ts`, `integrationTestStore.ts`, …)
still compose only the slice(s) under test, but that is now a **test
isolation** choice — narrower module graphs, no incidental coupling to
`agentHarnessClient`/`secureStorageService`/Tauri's `invoke` — not a
workaround for a hard failure. Follow the same narrow-composition pattern
for new slice tests; there is no longer a technical reason a new test
*couldn't* import the full store, just no reason to prefer it either.

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

## The startup coordinator

`AppBootstrapBoundary` (PR 2) established the seam; PR 3a is the machine
behind it. The generic executor and the application's actual steps are
deliberately split across two directories with different import rules:

```
src/startup/                          (no store/service/React import -- see below)
├── types.ts       StepId, StepOutcome, StartupStep, StartupResult, StartupState
├── runStartup.ts  the executor: ordering, per-step + global deadlines, dependsOn skip, abort
├── withTimeout.ts races a promise against a timeout (does not cancel the loser)
├── buildRetryStepList.ts   swaps an already-"ok" step for a no-op, for Retry
└── layering.test.ts        enforces the rule above

components/shell/
├── startupSteps.ts          the real steps: secure-config, sidecar-health, workspace-restore
└── AppBootstrapBoundary.tsx  runs them, translates StartupState into the view's props
```

**Why the split.** `runStartup.ts` is tested with fake steps under vitest's
plain `environment: "node"` — no mocking of `invoke`/`fetch`/WebCrypto needed
— which only holds because it imports nothing from `../store` or
`../services`; `src/startup/layering.test.ts` enforces this the same way
`src/tabs/layering.test.ts` enforces the store/view split. The actual steps
(`startupSteps.ts`) need the real store and Tauri's `invoke`, so they live
next to their only consumer, `AppBootstrapBoundary.tsx` — the same pattern
`consoleFormat.ts` follows next to `DevLogBridge.tsx`.

**`StartupState` is a discriminated union**
(`idle | running | ready | degraded | failed`), not a flat phase-name union:
a flat union can't express "running, at the workspace step, with the sidecar
step already degraded." Shaped like the existing `LspStatus`
(`src/services/lspService.ts`).

**"Settled" means resolved, timed out, or skipped — never "succeeded."**
`runStartup` enforces one **absolute** global deadline (truncating any
individual step's own `timeoutMs` to whatever budget remains, rather than
letting steps sum past it) and lets a non-critical step's failure degrade
the run without stopping it. Exactly one step, `secure-config`
(`critical: true`), can produce a hard `failed` result — and only if it
actually failed or timed out; a critical step merely *skipped* by an early
abort degrades instead, matching "Continue anyway."

**`dependsOn` is what makes an unreachable sidecar cheap.** A step whose
dependency didn't settle `"ok"` is skipped without running, transitively —
one health-check budget instead of N sequential provider timeouts once PR
3b adds those steps. In PR 3a's own three-step registry, only
`workspace-restore` uses it (`dependsOn: ["secure-config"]`).

**StrictMode:** a module-level in-flight promise
(`AppBootstrapBoundary.tsx`'s `activeRun`), not a `runIdRef`. A `runIdRef`
guard (PR 2's original shape) only suppresses the *second* invocation's
React state updates — it doesn't stop the second invocation's actual work,
so a `runIdRef`-guarded effect still runs every side effect twice under
StrictMode. The module-level promise means the second invocation *adopts*
the first rather than starting a second run — the same dedupe
`agentHarnessClient.connect()` already uses via its own `connectPromise`.
Never cleared by the effect's own cleanup (that fires *between*
StrictMode's two invocations; aborting there would kill the only run) —
only by the run finishing, or by `retryStartup()` explicitly discarding it.

**`secureConfigLoaded` guards against a real data-loss bug, not a
hypothetical one.** `saveSecureConfig` writes the *entire* snapshot
(providers, API keys, `lastWorkspacePath`, MCP servers) and nine call
sites fire it via `setTimeout` on nearly every settings mutation. Before
the initial load (and any pending workspace restore) has settled,
`saveSecureConfig` is a no-op: otherwise, a settings change during that
window — always possible, and routine once `degraded` is a normal
outcome rather than a rare failure — would silently overwrite a real,
previously-saved encrypted blob with default state. The flag is owned by
whichever step last touches the state it protects: `loadSecureConfig` sets
it directly only when nothing was ever saved (nothing to restore, safe
immediately); otherwise the `workspace-restore` step is the sole owner,
setting it in `finally` **unconditionally** (not gated on the abort
signal) — a step that times out has its non-cancellable `invoke()` still
running in the background, and if the flag only flipped on the happy
path, a slow restore would leave saving blocked for the rest of the
session.

**The dev sidecar port mismatch was a real, load-bearing bug**, not just a
constraint: `src/config/sidecar.ts` deliberately splits `SIDECAR_PORT`
between dev (4001) and release (4000) so a `tauri dev` instance never
fights an installed release copy, but `src-tauri/src/lib.rs`'s
`spawn_sidecar` — which runs unconditionally in both dev and release —
always bound the child process to a hardcoded 4000 with no `PORT` env
passed through. `npm run tauri dev` alone, without also following
`BUILD.md`'s separate manual-sidecar instructions, had no reachable
sidecar at all. Fixed by making the Rust-side constant `cfg!
(debug_assertions)`-aware and passing it through as the child's `PORT` env.

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

Why store tests still compose only the slice(s) under test rather than
reaching for `src/store.ts`: see "Slice import-time purity" above — as of
PR 3a this is a test-isolation preference (a narrower module graph, no
incidental coupling to `agentHarnessClient`/`secureStorageService`/Tauri's
`invoke`), not a workaround for the composed store throwing, which it no
longer does. `src/test/tabTestStore.ts` and its siblings are the pattern
to follow for a new slice test.
