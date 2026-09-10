# Rusty Application Refactor Plan

## Master checklist

- [x] PR 0 — Establish the baseline and test harness
- [x] PR 1 — Replace editor groups with a declarative single-workspace tab system
- [ ] PR 2 — Refactor the application shell and hide the explorer by default
- [ ] PR 3 — Add an extensible application startup procedure
- [ ] PR 4 — Complete the shared sidecar agent protocol migration
- [ ] PR 5 — Complete Git integration, including detached HEAD and submodules
- [ ] PR 6 — Add major-language syntax highlighting and safe file handling
- [ ] PR 7 — Finish workspace decomposition, lifecycle cleanup, and visual polish
- [ ] All requirement-level acceptance criteria pass
- [ ] Full frontend, sidecar, Rust, and application smoke-test suite passes

## Objective

Refactor Rusty so the workspace becomes the primary application surface, every tab has centrally defined behavior and state, split editors are removed, the explorer is hidden until requested, Git works reliably across ordinary repositories and submodules, all agent features use one replaceable protocol, major programming languages are supported by the file editor, and all integrations are initialized before the application becomes interactive.

The work should be delivered as a sequence of focused migrations rather than one large rewrite.

## Current architecture findings

- ~~Tabs are stored as `editorGroups`, with split and move behavior in `src/store/slices/createEditorSlice.ts`.~~ Resolved in PR 1.
- ~~Tab uniqueness is duplicated and hard-coded instead of being enforced through `src/components/tabs/TabRegistry.ts`.~~ Resolved in PR 1 (`src/tabs/policy.ts`).
- ~~Agent tabs bypass `openTab` and always create another instance.~~ Resolved in PR 1.
- `src/components/Workspace.tsx` handles layout, tab rendering, agent execution, sockets, close interception, VFS operations, permissions, and reconciliation. (PR 1 removed the layout and tab-rendering halves; agent execution, sockets, VFS and permissions remain, for PR 7.)
- The project explorer starts open in `src/App.tsx`.
- A versioned agent protocol already exists in `shared/agentProtocol.ts`, but most consumers still use a WebSocket compatibility facade.
- Integration polling begins when `LlmSetupTab` mounts instead of during application startup.
- Git history uses `git log --all`; this can omit the currently checked-out commit when `HEAD` is detached and unreferenced.
- Subproject discovery is a filesystem scan limited to three directory levels instead of a Git-aware repository and submodule model.
- Language detection is a manually maintained switch and falls back to plaintext for many common languages.
- There are no frontend tab/store tests or Rust Git fixture tests.

## Target application structure

```text
App
└── AppBootstrapBoundary
    └── AppShell
        ├── Header
        ├── NavigationRail
        ├── ContextDrawer
        │   ├── Project Explorer
        │   └── Source Control
        └── MainWorkspace
            ├── TabStrip
            ├── TabOutlet
            └── BottomPanel / Terminal
```

### Workspace behavior

- `MainWorkspace` is always the primary surface.
- A narrow navigation rail remains available.
- Explorer and source control appear in a contextual drawer opened only by explicit user action.
- The explorer starts closed on every application launch.
- Drawer width may persist, but open/closed state should persist only during the current session.
- Only one tab outlet exists.
- Split panes, editor groups, group resizing, cross-group dragging, and split actions are removed.
- Horizontal tab reordering can remain as a simple operation if desired.
- The terminal remains a global collapsible bottom panel unless a later product decision makes it tab-specific.
- Background agent runs belong to an application service, not the mounted lifetime of a tab.

## Tab architecture

Replace `EditorGroup[]`, `activeGroupId`, and `groupSizes` with a single tab collection:

```ts
interface TabState {
  tabs: TabInstance[];
  activeTabId: string | null;
}

interface TabInstance<TPayload = unknown> {
  id: string;
  type: TabType;
  title: string;
  identity: string;
  payload: TPayload;
  status: "idle" | "busy" | "error";
  dirty: boolean;
}

interface TabDefinition<TPayload = unknown> {
  type: TabType;
  uniqueness: "global" | "resource" | "multiple";
  getIdentity: (request: OpenTabRequest<TPayload>) => string;
  keepAlive: "active-only" | "while-busy" | "always";
  closable: boolean;
  render: React.ComponentType<TabProps<TPayload>>;
}
```

### Tab opening rules

`openTab(request)` must:

1. Resolve the tab definition from the registry.
2. Calculate its canonical identity.
3. Find an existing matching tab.
4. Activate that tab or create a new instance.
5. Return the resulting tab ID.

### Proposed tab policies

| Tab | Uniqueness identity | Mount policy |
| --- | --- | --- |
| Onboarding | Global singleton | Active only |
| Workspace chooser | Global singleton | Active only |
| Settings | Global singleton | Active only |
| Integrations | Global singleton | Active only; polling belongs to the startup service |
| Skills | Global singleton | Active only |
| MCP integration | Global singleton | Active only |
| Metrics | Global singleton | Active only |
| Agent | Global singleton | Always while a run exists |
| File | Canonical absolute path | Active only |
| Canvas | Saved canvas ID; new canvases receive instance IDs | While busy |
| Task auditor | Canvas ID and task ID | While busy |
| Git history | Repository ID and optional canonical file path | Active only |
| Git diff | Repository ID, file, diff kind, and commit | Active only |

### Tab invariants

- File identities use normalized canonical paths, including separator and platform-appropriate case normalization.
- Opening the same file with a new line number activates its existing tab and updates its navigation target.
- Agent creation becomes `openTab({ type: "agent" })`; `createAgentTab` must not mutate tab storage directly.
- Domain state remains in domain stores keyed by tab identity. Tab descriptors contain routing and lifecycle data, not large editor, chat, or canvas state.
- Close protection is registry-driven through a `beforeClose` hook for unsaved canvases and running agents.
- Closing the final tab opens the documented onboarding or workspace-empty fallback.
- Any persisted editor groups are flattened in visual order and deduplicated through the new identity rules.

## PR 0 — Baseline and safety harness

### Checklist

- [x] Add a frontend unit-test runner.
- [x] Add root scripts for frontend tests, sidecar tests, Rust tests, and combined verification.
- [x] Add initial store-level characterization tests before changing tab state.
- [x] Add Rust helpers for temporary Git repository fixtures.
- [x] Upgrade the development Node runtime to a Vite-supported version. (Node was already 22.23.1; `.nvmrc` and `engines` pinned to keep it that way.)
- [x] Resolve stale Tauri generated-permission metadata referencing another worktree. (Root cause was `src-tauri/target/` and the gitignored `src-tauri/resources/sidecar/` staging dir, not `gen/schemas`; both regenerated.)
- [x] Document the architectural invariants and migration rules.
- [x] Confirm the complete baseline suite passes.

### Completion criteria

One command validates frontend types and build, frontend tests, sidecar protocol tests, and Rust Git tests.

## PR 1 — Declarative tabs and a single workspace outlet

### Checklist

- [x] Make the typed tab registry authoritative. (Authored as `src/tabs/`; the old `TabRegistry.ts` was dead code and was deleted rather than migrated.)
- [x] Introduce `tabs`, `activeTabId`, `openTab`, `activateTab`, `closeTab`, `updateTab`, and optional `reorderTab` actions. (`reorderTab` deliberately not added — see deviations.)
- [x] Implement `global`, `resource`, and `multiple` uniqueness strategies. (`multiple` is implemented and tested but unused by any current tab type.)
- [x] Define typed payloads for every tab type. (Flat discriminated union rather than a nested `payload` — see deviations.)
- [x] Route canvas creation through `openTab`.
- [x] Route agent creation through `openTab` and enforce its global singleton policy.
- [x] Make file tabs unique by canonical path.
- [x] Make Git tabs unique by repository-aware identity. (The tab components now also *use* `repoPath`, so identity and behavior agree.)
- [x] Convert `FileTab`, `TaskTab`, and `GitDiffTab` away from `groupId`.
- [x] Update canvas helpers to resolve the active canvas without editor groups.
- [x] Centralize close guards and mounted-lifecycle policies.
- [x] ~~Add migration logic for any persisted editor-group state.~~ **Moot — nothing persists tab state.** Verified: no zustand persist middleware, `saveSecureConfig` stores seven non-tab keys, `.rusty/canvas/*.json` holds one canvas's graph with no layout, no localStorage key holds tabs, and `tauri-plugin-window-state` is window geometry only.
- [x] Remove `EditorGroup`, `editorGroups`, `activeGroupId`, and `groupSizes`.
- [x] Remove `splitTab`, `moveTab`, group resizers, split buttons, and cross-group drop targets.

### Required tests

- [x] Every global singleton opens only once.
- [x] The agent tab opens only once.
- [x] Two different files open two tabs.
- [x] Relative, absolute, and normalized references to one file resolve to one tab.
- [x] Reopening a file updates its requested line and activates it.
- [x] Dirty and running close guards still work.
- [x] Closing active, inactive, first, last, and only tabs selects the correct fallback.
- [x] Workspace and branch transitions leave valid tab state.
- [x] Canvas state does not leak between canvas tabs.

### Deviations from this plan, and why

- **Flat discriminated union instead of `TabInstance<TPayload>`.** Per-type fields are named for what they are (`path`, `canvasId`, `repoPath`) rather than nested under `payload`. Same type safety, one less indirection at ~46 read sites.
- **No separate `identity` field.** With nothing persisted and no type using `multiple`, `id === identity` for every live tab; a second field would need syncing at every call site for no present benefit. Adding it later is purely additive.
- **No `reorderTab`.** The plan allows reordering "if desired", but no intra-strip reorder existed to preserve — the only drag-and-drop was cross-group tab moves, which died with split editors. Better as an isolated follow-up than bundled here.
- **`type: "rusty"` dropped here rather than in PR 7.** Nothing ever constructed one, and its remaining read sites were all in files this PR rewrote. PR 7's "remove compatibility aliases" item is correspondingly smaller.
- **Cleanup-on-close pulled forward from PR 7.** `VfsRegistry.destroy` had zero callers and `closeTab` pruned nothing, so canvas contexts, chat histories and VFS instances leaked for the process lifetime — and `resetForBranchChange` leaked them again on every branch switch. A flat tab array made "is this tab still open?" a one-liner, so fixing it here was cheap. PR 7 still owns the broader lifecycle-owner work.

### Known gaps left for later

- A canvas auto-save pending inside its debounce window is still dropped when the tab closes. Pre-existing; fixing it properly needs `saveCanvasNow` to take a state snapshot instead of reading the live store.
- Reopening a file at the *same* line it already has does not re-scroll, because `FileTab`'s effect is keyed on `[tab.line]`. A monotonic navigation counter would fix it.
- `revealFileInTree` splits on `/` and will mismatch native Windows separators now that `tab.path` is canonicalized. Flagged for PR 6.

## PR 2 — Clean application shell

### Checklist

- [ ] Extract `AppBootstrapBoundary`.
- [ ] Extract `AppShell`.
- [ ] Extract `NavigationRail`.
- [ ] Extract `ContextDrawer`.
- [ ] Extract `MainWorkspace`, `TabStrip`, and `TabOutlet`.
- [ ] Make the explorer closed at application launch.
- [ ] Put explorer and source control in the contextual drawer.
- [ ] Move drawer visibility and width into a focused UI store slice.
- [ ] Preserve the drawer width without automatically reopening it after restart.
- [ ] Make the drawer overlay the workspace at narrow widths.
- [ ] Preserve search, explorer toggle, and close-tab shortcuts.
- [ ] Remove split-editor controls and styles.
- [ ] Remove unnecessary nested card borders and shadows.
- [ ] Standardize spacing, radii, typography, focus states, and tooltips.
- [ ] Verify keyboard-only navigation and focus restoration.

### Visual direction

- Neutral, spacious main workspace.
- Restrained borders and shadows.
- One clear primary accent.
- Consistent controls with fewer permanently visible actions.
- Navigation and secondary controls should support the workspace rather than compete with it.

### Completion criteria

The workspace occupies the main window, no split affordance remains, and explorer content is neither mounted nor visible until explicitly opened.

## PR 3 — Extensible application startup procedure

### Startup state

```ts
type StartupPhase =
  | "idle"
  | "sidecar"
  | "configuration"
  | "integrations"
  | "workspace"
  | "ready"
  | "degraded"
  | "failed";
```

### Checklist

- [ ] Create a bootstrap coordinator independent of `App.tsx`.
- [ ] Start and health-check the sidecar.
- [ ] Load secure configuration and preferences.
- [ ] Load cached provider catalogs immediately.
- [ ] Check Codex, Claude Code, and Copilot authentication concurrently.
- [ ] Discover or refresh models for every configured provider with bounded concurrency.
- [ ] Load MCP configuration.
- [ ] Validate configured MCP servers where startup validation is appropriate.
- [ ] Restore the last workspace.
- [ ] Load skills for the restored workspace.
- [ ] Discover repositories and load Git status.
- [ ] Load usage metrics.
- [ ] Mark startup ready only after all integration checks have settled.
- [ ] Add per-operation timeouts and cancellation.
- [ ] Add Retry and Continue in degraded mode actions.
- [ ] Start background provider-status and quota refreshers.
- [ ] Remove integration status polling from the lifecycle of `LlmSetupTab`.
- [ ] Store provider status globally as `unknown`, `loading`, `ready`, `unauthenticated`, or `error`.
- [ ] Make every model selector consume the same global integration registry.

### Startup order

1. Sidecar readiness.
2. Secure configuration and local preferences.
3. Cached provider catalogs.
4. Managed authentication checks.
5. Provider model discovery.
6. MCP configuration.
7. Workspace restoration.
8. Skills, Git repositories/status, and metrics.
9. Ready or degraded state.
10. Background refresh services.

### Completion criteria

Immediately after startup, every application surface sees the same settled provider, model, authentication, quota, and integration error state. Visiting or hovering over the integrations UI is not required.

## PR 4 — Shared sidecar agent protocol

Preserve and extend the existing versioned protocol instead of creating a competing protocol.

### Proposed module layout

```text
shared/agent-protocol/
├── envelope.ts
├── capabilities.ts
├── commands.ts
├── events.ts
├── rpc.ts
├── errors.ts
├── validation.ts
└── index.ts
```

### Transport boundary

```ts
interface AgentTransport {
  connect(): Promise<NegotiatedSession>;
  send(message: ClientProtocolMessage): Promise<void>;
  subscribe(listener: ProtocolEventListener): Unsubscribe;
  disconnect(): Promise<void>;
}
```

The current WebSocket implementation becomes one adapter. A future replacement for the sidecar or harness must only require another adapter.

### Checklist

- [ ] Retain version negotiation and capability negotiation.
- [ ] Define a discriminated command map.
- [ ] Define a discriminated event map.
- [ ] Validate every payload at runtime, not just the envelope.
- [ ] Document stable conversation, run, message, correlation, parent-agent, and sequence semantics.
- [ ] Define terminal outcomes: completed, failed, cancelled, timed out, and disconnected.
- [ ] Define typed reverse RPC for file reads, file writes, permissions, questions, and logs.
- [ ] Define cancellation and reconnection behavior.
- [ ] Define replay, ordering, duplicate, and idempotency behavior.
- [ ] Define stable structured error codes.
- [ ] Implement the transport-neutral client interface.
- [ ] Keep integration HTTP calls behind a separate replaceable control-plane interface.
- [ ] Keep LSP on its own protocol and transport boundary.

### Consumer migration checklist

- [ ] Canvas node execution.
- [ ] Agent tab.
- [ ] Global and explorer chat.
- [ ] Task generation.
- [ ] Skill generation.
- [ ] Edge reconciliation.
- [ ] Graph reconciliation.
- [ ] Test and build execution.
- [ ] Inline chat.
- [ ] Command permission handling.

### Cleanup checklist

- [ ] Remove component-owned agent WebSockets.
- [ ] Delete `createAgentHarnessSocket` after the final consumer migrates.
- [ ] Reject legacy un-enveloped messages at the main protocol boundary.
- [ ] Keep legacy support only in an explicit compatibility adapter if it is still required.
- [ ] Add contract tests that run against both client and sidecar parsing.

### Completion criteria

No React component constructs, sends, parses, or owns an agent WebSocket. All agent-capable nodes and the Agent tab communicate through the same typed client.

## PR 5 — Complete Git integration and submodule support

### Repository model

```ts
interface GitRepository {
  id: string;
  worktreePath: string;
  gitDir: string;
  kind: "workspace" | "submodule" | "nested" | "worktree";
  parentId?: string;
  submodulePath?: string;
  initialized: boolean;
  head: {
    mode: "branch" | "detached" | "unborn";
    branch?: string;
    oid?: string;
  };
}
```

### Backend checklist

- [ ] Discover root repository metadata through Git.
- [ ] Discover recursive submodules with `git submodule status --recursive` or an equivalent Git-aware command.
- [ ] Support repositories represented by `.git` directories and `.git` files.
- [ ] Support linked worktrees where present.
- [ ] Remove the depth-limited filesystem scan as the source of truth.
- [ ] Return explicit branch, detached, and unborn HEAD states.
- [ ] Include `HEAD` explicitly in history traversal alongside refs.
- [ ] Distinguish a valid repository with no commits from a failed Git command.
- [ ] Parse status using NUL-delimited porcelain output.
- [ ] Correctly handle spaces, Unicode, renames, copies, conflicts, and ignored path edge cases.
- [ ] Report submodule state separately: uninitialized, modified worktree, untracked content, and changed gitlink.
- [ ] Scope every Git command to an explicit repository.
- [ ] Return structured errors with operation, repository, exit code, and stderr.
- [ ] Validate file operations remain inside the selected worktree.
- [ ] Correctly list files for root commits.

### Frontend checklist

- [ ] Replace the single global `gitStatus` with repository descriptors and `statusByRepositoryId`.
- [ ] Add an explicit `activeRepositoryId`.
- [ ] Display repository kind and path in the repository selector.
- [ ] Display detached and unborn HEAD states correctly.
- [ ] Run status, branch, history, diff, blame, commit, fetch, pull, push, stash, switch, reset, and revert against the selected repository.
- [ ] Disable branch-only operations while detached and explain why.
- [ ] Add initialize-submodule action.
- [ ] Add update-submodule action.
- [ ] Add sync-submodule action.
- [ ] Allow a submodule repository to be selected and opened.
- [ ] Allow the parent gitlink to be staged after a submodule commit.
- [ ] Refresh both child and parent status after a submodule HEAD change.
- [ ] Include repository identity in Git history and diff tab identities.

### Git fixture tests

- [ ] Normal branch repository.
- [ ] Unborn repository.
- [ ] Detached `HEAD` whose commit is not referenced by a branch.
- [ ] Initialized submodule.
- [ ] Uninitialized submodule.
- [ ] Nested submodules.
- [ ] `.git` file and linked-worktree repository.
- [ ] Filenames containing spaces and Unicode.
- [ ] Renamed and copied files.
- [ ] Root commit file listing.
- [ ] Dirty submodule and modified parent gitlink.
- [ ] Repository without a remote.
- [ ] Branch without an upstream.

### Completion criteria

Detached history includes the checked-out commit, empty repositories are represented correctly, and supported Git operations work consistently for root repositories and recursive submodules.

## PR 6 — Major-language file support

Create one language registry used by editor language selection, file icons, file filtering, inline chat, and LSP mapping.

### Language checklist

- [ ] TypeScript, JavaScript, JSX, and TSX.
- [ ] HTML, CSS, Sass, and Less.
- [ ] JSON, JSONC, YAML, XML, TOML, and INI.
- [ ] Markdown and MDX.
- [ ] Python.
- [ ] Java, Kotlin, and Scala.
- [ ] C, C++, and Objective-C.
- [ ] C# and F#.
- [ ] Rust and Go.
- [ ] Swift.
- [ ] PHP, Ruby, Lua, and Dart.
- [ ] R and SQL.
- [ ] Shell and PowerShell.
- [ ] Dockerfile, Makefile, and CMake.
- [ ] Terraform and HCL.
- [ ] GraphQL.
- [ ] Protocol Buffers.
- [ ] Vue and Svelte where Monaco tokenization support is available.

### File handling checklist

- [ ] Recognize important extensionless files such as `Dockerfile`, `Makefile`, and `Gemfile`.
- [ ] Detect shebangs for extensionless scripts.
- [ ] Treat unknown text files as plaintext.
- [ ] Detect binary files before opening Monaco.
- [ ] Show an unsupported/binary preview rather than corrupt text.
- [ ] Add a configurable large-file threshold.
- [ ] Open oversized text files in a safe read-only mode.
- [ ] Preserve Markdown edit and preview modes.
- [ ] Keep syntax highlighting independent from optional LSP support.
- [ ] Add table-driven mapping tests for filename, extension, shebang, Monaco language, and LSP key.

### Completion criteria

All listed major languages receive correct syntax highlighting or an explicitly documented fallback. Binary and oversized files cannot destabilize the editor.

## PR 7 — Workspace decomposition and lifecycle cleanup

### Checklist

- [ ] Move canvas execution from `Workspace.tsx` into an `AgentRunCoordinator`.
- [ ] Move tab rendering into registry-backed tab components.
- [ ] Move close interception into a reusable tab lifecycle controller.
- [ ] Move sidebar presentation state into the shell/UI slice.
- [ ] Ensure closing an Agent tab follows the defined running-work policy.
- [ ] Ensure background work is not accidentally tied to component mounting.
- [ ] Give Monaco models an explicit lifecycle owner.
- [ ] Give LSP bindings an explicit lifecycle owner.
- [ ] Give protocol subscriptions and runs an explicit lifecycle owner.
- [ ] Give VFS instances an explicit lifecycle owner.
- [ ] Replace remaining `any` tab types with discriminated payload types.
- [ ] Remove compatibility aliases such as `canvas`/`rusty` after state migration. (`rusty` was already dropped in PR 1 — nothing constructed one, and its read sites were in files PR 1 rewrote.)
- [ ] Add an error boundary per tab.
- [ ] Complete visual consistency and accessibility QA.
- [ ] Remove dead components, state fields, CSS, and compatibility code.

## Requirement-level acceptance checklist

### Workspace and layout

- [ ] The workspace is the main application surface.
- [ ] The workspace contains one tab strip and one content outlet.
- [ ] Project explorer content is not visible or mounted until requested.
- [ ] No split state, split UI, resize handle, drag target, or split shortcut remains.

### Tabs

- [ ] Every tab type has a centrally declared identity and lifecycle policy.
- [ ] Onboarding is globally unique.
- [ ] Agent is globally unique.
- [ ] A file is unique by canonical path.
- [ ] Different files can be open in different tabs.
- [ ] Git tab identities include their repository.
- [ ] Dirty and running tabs have deterministic close behavior.

### Git

- [ ] Root repositories work.
- [ ] Nested repositories and worktrees are discoverable.
- [ ] Initialized and uninitialized recursive submodules work.
- [ ] Detached `HEAD` is displayed correctly.
- [ ] Detached history contains the checked-out commit.
- [ ] An unborn repository is not reported as a history failure.
- [ ] All Git actions target the selected repository.

### Agent protocol

- [ ] All agent-capable nodes use the shared protocol client.
- [ ] The Agent tab uses the shared protocol client.
- [ ] Commands, events, RPC, errors, cancellation, and replay are typed and validated.
- [ ] Replacing the sidecar transport does not require component changes.

### File editor

- [ ] All planned major languages have syntax highlighting or a documented fallback.
- [ ] Markdown source and preview work.
- [ ] Binary files do not open as editable text.
- [ ] Large files use the safe fallback.

### Startup

- [ ] Startup is represented by an explicit state machine.
- [ ] All configured integrations settle before the app becomes interactive.
- [ ] Integration information is available without opening or hovering over the integrations tab.
- [ ] Failures time out and produce actionable degraded state rather than blocking forever.

## Final verification checklist

- [ ] Frontend type checking passes.
- [ ] Frontend production build passes.
- [ ] Frontend tab and startup tests pass.
- [ ] Sidecar type checking passes.
- [ ] Sidecar protocol and architecture tests pass.
- [ ] Rust formatting and lint checks pass.
- [ ] Rust Git fixture tests pass.
- [ ] Tauri desktop smoke test passes on macOS.
- [ ] Windows and Linux build checks pass in CI.
- [ ] Keyboard navigation and focus behavior pass manual QA.
- [ ] Explorer closed-at-start behavior passes manual QA.
- [ ] Agent run persistence and cancellation pass manual QA.
- [ ] Git root, detached, unborn, and submodule flows pass manual QA.
- [ ] No compatibility WebSocket consumers remain.
- [ ] No editor-group or split-editor state remains.

## Baseline recorded on 2026-09-09

- Working tree was clean before creating this plan.
- Frontend TypeScript and Vite production build passed.
- The local Node version was `22.1.0`; Vite reported that Node `22.12+` is required.
- Vite reported a large main bundle and mixed static/dynamic import warnings.
- Sidecar type checking passed.
- All 32 sidecar architecture tests passed.
- `cargo check` was blocked by stale generated Tauri permission metadata referencing `/Users/suciuvictortraian/Development/axiom`.
- The sidecar has named test scripts but no generic `test` script.
- Frontend tab/store tests and Rust Git fixture tests were not present.

## Recommended execution order

The PR order above is intentional:

1. Establish tests and a reliable build baseline.
2. Simplify tab state before rebuilding the visual shell.
3. Move integration state into startup before more consumers depend on it.
4. Complete the protocol boundary before further agent feature work.
5. Rebuild Git around repository identity after tabs support repository-aware keys.
6. Centralize language support after the File tab lifecycle is stable.
7. Remove compatibility code and complete visual/lifecycle cleanup last.

Each PR should leave the application buildable and should remove its superseded path before being considered complete.
