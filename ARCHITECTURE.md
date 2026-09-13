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
- **`shared/`** — a source-only package (`shared/agent-protocol/`, split
  from a single `agentProtocol.ts` file in PR 4a) consumed by both sides
  via relative import. `agent-sidecar/tsconfig.json` pulls it in with
  `rootDir: ".."`, so it is compiled twice, once under each side's module
  settings — a real constraint that has bitten this directory once
  already (PR 4a: a class using `ErrorOptions.cause` in its `super()` call
  typechecked fine when it lived only in the sidecar's ES2022 config, but
  failed once moved here because the frontend's tsconfig targets ES2020).

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
  `createGitSlice.ts`'s remains -- PR 5 (Git integration/submodules,
  done) grew this file substantially but did not resolve this
  violation, since it was about the git.rs backend and store fields,
  not slice/transport layering. Still unresolved, not targeted by any
  currently-planned PR.
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
dependency didn't settle `"ok"` is skipped without running, transitively.
In PR 3a's own three-step registry, only `workspace-restore` uses it
(`dependsOn: ["secure-config"]`) — it turned out PR 3b did not need this
for provider steps after all, since provider checks are not startup steps
at all (see "The integration registry" below); the mechanism remains as
forward-looking infrastructure for whichever future step needs it.

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

## The integration registry

PR 3b's producer half (3c, not yet started, is the consumer half): one
global map of provider auth/model/quota status, so every application
surface can eventually see the same settled state without visiting LLM
Setup. Before this, that state lived entirely inside components that
unmount: three `useManagedProviderStatus` polls and a `connectionStatus`
map inside `LlmSetupTab` (destroyed by its `keepAlive: "active-only"` tab
policy on every tab switch), and a separate quota cache inside
`ProviderQuotaControl`.

```
src/integrations/                     (no store/service/React import -- see below)
├── registryTypes.ts    ProviderStatusKind, ProviderStatusEntry<TQuota>, providerStatusOrUnknown
├── schedule.ts          pure polling cadence: (status, now) -> next delay ms
├── discoveryPolicy.ts   pure eligibility/staleness rules for model discovery and quota
├── concurrency.ts        a minimal counting semaphore
└── layering.test.ts      enforces the rule above

src/store/slices/createProviderRegistrySlice.ts   providerStatus: Record<id, ProviderStatus>
components/shell/providerCoordinator.ts            owns the timers and sidecar calls
```

**Why the split, again.** Same argument as the startup coordinator's own
`src/startup/` vs `components/shell/startupSteps.ts` split: `schedule.ts`,
`discoveryPolicy.ts`, and `concurrency.ts` are pure functions of a status
map and a clock, so they're directly testable under plain `environment:
"node"`. `providerCoordinator.ts` is where the actual `setTimeout` calls
and `llmIntegrationService` requests happen — it cannot live under
`src/integrations/` (its own `layering.test.ts` forbids exactly that
import), so it sits next to `startupSteps.ts` instead, verified partly by
mocked unit tests and partly by hand in a live browser.

**`ProviderStatusEntry`'s `kind` is a five-value discriminant**
(`unknown | loading | ready | unauthenticated | error`), and
`unauthenticated` being distinct from `error` is the entire point: before
this, `selectableProviderModels` (`store/providerHelpers.ts`) filtered an
unauthenticated managed provider out of the array entirely, so its models
just vanished from every dropdown with no explanation, and (via
`AgentTab.tsx`'s mount effect, still true today — that's 3c's job) the
global model selection could be silently rewritten to something else
entirely. `unknown`/`loading` existing as separate kinds only makes sense
under a background-settling model — a design that blocked startup on
these checks would never let a surface observe either one.

**Provider work is not a startup step, on purpose.** `runStartup`'s global
deadline is 8s; Copilot's status check alone has no server-side timeout
of its own and pays a full SDK cold start, and Codex's model list is
paginated at 30s/page with no cap. Verifying those actual costs (not just
assuming) is what killed the plan's original draft, which had cached
catalogs/auth checks/model discovery as startup steps 3-5. Instead,
`startProviderCoordinator()` is called once, idempotently, from
`AppBootstrapBoundary`'s existing module-level run promise — in the
`.then()` right after the blocking run settles, regardless of whether it
ended `ready`, `degraded`, or `failed`.

**The polling cadence has three tiers, not the naive two.** Today's
`useManagedProviderStatus` had 1s while `state === "connecting"`, 10s
otherwise — bounded only by the LLM Setup tab unmounting. Running outside
React removes that accidental bound, so `schedule.ts` adds an explicit
cap (`FAST_POLL_MAX_DURATION_MS`, 5 minutes) on the fast tier, and splits
"otherwise" into two: 10s while LLM Setup happens to be open (preserving
felt responsiveness where a human is actually watching), 5 minutes
otherwise (matching `ProviderQuotaControl`'s pre-existing refresh
interval) — never a blanket "poll all three providers every 10 seconds
forever," which would mean three sidecar requests capable of cold-
starting an SDK client or spawning a child process every 10 seconds for
the life of the session.

**The stale-response guard is a monotonic sequence number, not a
timestamp comparison.** Every status check, login, logout, and quota
fetch bumps a per-provider counter before issuing its request; a response
is only applied if that counter hasn't advanced since — so a slow poll
that resolves after a fresh login (or a manual refresh) has already
superseded it is dropped rather than clobbering newer state. No clock-
resolution edge cases, and it behaves identically whether the superseded
request failed, timed out, or simply arrived late.

**Login and logout write through the same path a poll would.**
`startManagedLogin`/`logoutManaged` don't maintain their own status
shape — they call the sidecar, then `forcePollNow()` (cancel this
provider's pending timer, re-run `checkProviderStatus` immediately). A
login is just another reason a status can change, not a separate write
path with its own guarantees to keep in sync.

**Quota stays scoped to one watched provider, not every eligible one.**
`ProviderQuotaControl` only ever shows a single provider's quota;
`setQuotaWatch` mirrors that exactly rather than proactively fetching
every eligible provider's quota on a timer. Claude Code's quota path
deliberately bypasses its own status cache on every single call — there
is no warm-state amortization that would make fetching it for every
eligible provider every 5 minutes forever anything but a pure added cost.

**Model discovery is background, TTL'd, and never touches `activeModel`.**
`CustomProvider.modelsFetchedAt` (optional) records when a catalog was
last actually discovered; absent or older than 24h is stale. A managed
provider is only eligible once its registry status is `ready` — fixing
the same bug `selectableProviderModels`-style filters have: `authType
"environment"` used to mean "always configured" regardless of whether
the provider was actually signed in. Background discovery always writes
only `models`/`modelsFetchedAt`, deliberately never `activeModel` — unlike
`LlmSetupTab`'s own user-initiated Fetch, a background refresh silently
changing what's selected would surprise nobody who asked for it.

**Lifted actions take a provider object, not an id.**
`LlmSetupTab.tsx`'s `providerWithDraftSettings()` merges unsaved form
edits over the store's saved provider before Fetch/Test run — a lifted
action taking only an id would silently test or discover against stale
saved credentials while the user is still editing them. The draft merge
stays in the component; `discoverModelsForProvider`,
`startManagedLogin`, and `logoutManaged` all take a `CustomProvider`.

**`saveSecureConfig`'s nine call sites are coalesced into one debounced
scheduler**, keyed by the store's `get` via a `WeakMap` (so multiple test
stores never share a pending timer) rather than a bare module-level
timer. `saveSecureConfig` writes the *entire* encrypted blob through
PBKDF2 at 100,000 iterations; without coalescing, background discovery
stamping `modelsFetchedAt` on every eligible provider at launch would
have triggered a full rewrite per provider, every launch.

**PR 3c moved every remaining consumer onto this registry** — the
producer/consumer split above is 3b; 3c is everything that reads from
it. Three shared primitives replace what used to be reimplemented per
call site:

- `selectableModelProviders`/`selectableProviderModels`
  (`src/store/providerHelpers.ts`) gained a `providerStatus` parameter:
  a managed provider is included only once its status is `ready`,
  exactly mirroring `isEligibleForDiscovery`'s rule. Before this, every
  model picker in the app still treated `authType === "environment"`
  alone as "configured" — the same bug 3b fixed for discovery/quota,
  never applied to the pickers themselves.
- `resolveExecutionProvider` (`src/store/resolveExecutionProvider.ts`)
  is the one execution-time resolver, replacing 9 independent
  `getState()` lookups (8 originally scoped across `Workspace.tsx`,
  `useExplorerWebSocket.ts` ×3, `useEdgeWebSocket.ts`, `AgentTab.tsx`,
  `SkillsTab.tsx`, `ReconciliationGraphPane.tsx` ×2 — plus a 9th,
  `InlineChat.tsx`, found only while migrating its picker, missed by
  the original survey). A managed provider not yet `ready` is refused
  with a distinct message for `status-pending` (`unknown`/`loading` —
  normal for the first several seconds after launch) versus
  `not-authenticated` (`unauthenticated`/`error` — actually needs sign
  in); a regular provider is never gated on status at all, mirroring
  the same asymmetry as the helper above.
- `useSelectableModels` (`src/hooks/useSelectableModels.ts`) is the one
  picker hook, replacing 11 separate option-list constructions across 5
  label formats with one (`${provider.name} / ${model.name}`), adding
  uniform memoization (previously only one picker memoized), and a
  companion `unauthenticatedProviders` list so a picker can render "Sign
  in to X" instead of silently going empty.

**The MCP "Test Connection" button now does a real handshake.**
`agent-sidecar/src/services/mcpClient.ts`'s `testMcpConnection` shares
`createClient()` with `createMcpTools()` but does not swallow a connect
failure the way that function deliberately does for run-time graceful
degradation — a test button needs the real thrown error. Reached via a
new `POST /mcp/test` sidecar route and a frontend `mcpTestService.ts`
that reuses `llmIntegrationService.ts`'s `request()` directly. On demand
only, exactly as decided for 3b: no MCP validation happens at startup.

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
