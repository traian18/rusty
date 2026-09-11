# Rusty theming

The application uses semantic theme tokens. Components describe the role of a
color (`surface`, `foreground`, `status`, `log`, or `editor`) instead of using a
palette color directly.

## Adding a theme

Add one entry to `themeSeeds` in `src/theme.ts`. A theme seed contains its name,
explicit light/dark appearance, workbench surfaces, foregrounds, accent, border,
and syntax palette. Rusty derives the complete `AppTheme` contract—including
primary/secondary colors, control states, status colors, logs, terminal, diff,
and accessible muted text—from that entry. The Settings list is generated from
the same registry.

## Using colors in a component

Prefer the semantic variables:

- `--color-primary` and `--color-secondary` for product emphasis.
- `--color-fg-default`, `--color-fg-muted`, and `--color-fg-strong` for text.
- `--color-surface-*` for the app, workspace, panels, inputs, and overlays.
- `--color-border-*` and `--color-interaction-*` for component states.
- `--color-status-{info,success,warning,danger}*` for statuses and actions.
- `--color-log-*`, `--color-terminal-background`, and `--syntax-*` for code-like UI.

The older `--bg-*`, `--text-*`, and `--accent-*` variables are compatibility
aliases and should not be used by new code. They remain temporarily for
unmigrated components and are isolated in the compatibility section of
`src/theme.ts`.

## Component styling

Component appearance belongs in a colocated CSS Module. Tailwind remains
available for straightforward layout while migration is in progress, but new
palette-specific colors and large arbitrary presentation strings are not
allowed. Runtime-calculated geometry—such as editor height, canvas position, or
resizing width—may remain inline. Prefer a CSS custom property
(`style={{ "--foo": value } as React.CSSProperties}`, cast because React's
types still reject custom properties) over `.style.<property>` when a value
needs to work under more than one CSS context — for example the context
drawer's width, which the same property has to satisfy in both its normal
docked layout and its narrow-shell overlay's `max-width` clamp.

### Radius scale

Four steps, each with one job — do not reach for a bigger one because it "looks
about right":

- `--radius-sm` (0.375rem) — inline controls: tool buttons, badges.
- `--radius-md` (0.5rem) — buttons and inputs.
- `--radius-lg` (0.75rem) — tabs, menus, cards-in-content.
- `--radius-xl` (1rem) — the application shell's single card only
  (`AppShell.module.css`'s `.surface`). Nothing else should use it; introducing
  a second `--radius-xl` consumer is a sign two cards are about to nest again.

`--shadow-elevated` is likewise deliberately singular: after PR 2 consolidated
what used to be two floating cards (the sidebar's and the workspace's) into
one, there is exactly one elevated shell surface. A `--shadow-sm`/
`--shadow-md` scale was considered and skipped — with only one consumer, a
second elevation token would sit unused the same way `--space-6` did before
this note existed.

### Focus

`:focus-visible` gets its own rule, never folded into `:hover`. A combined
`:hover, :focus-visible { outline: none }` (the shape `Header.module.css` and
`CustomSelect.module.css` both had before PR 2) silences the keyboard focus
ring along with the mouse hover style — the two states need different
treatment even when they happen to share other properties, because one of
them is the *only* signal a keyboard user gets.

### Tooltip

Use `components/ui/Tooltip/` for a hover/focus description — not `title=`,
and not text placed inside the trigger's own children. Two rules:

- **The trigger keeps its own `aria-label`** as its accessible name;
  `<Tooltip>` clones `aria-describedby` onto it, pointing at the bubble. Never
  let the tooltip text double as the name (an icon button whose visible
  tooltip content *is* its only label doesn't need a separate `<Tooltip>` at
  all — use `aria-label` alone).
- **`placement="right"` needs an unclipped ancestor.** `NavigationRail` is a
  sibling of the shell's card specifically so its tooltips aren't cut off by
  the card's `overflow: hidden` — see ARCHITECTURE.md's "The application
  shell". Placing a right-hand tooltip inside any `overflow: hidden`
  container will clip it.

`title=` remains correct where `Tooltip` cannot work: `TabStrip`'s tabs sit in
an `overflow-x: auto` container, and per spec a non-`visible` value on one
axis forces `overflow` to `auto` on both — a bottom-placed bubble there would
be clipped vertically. Fixing that needs a portal, tracked as app-wide
tooltip-migration follow-up work rather than solved ad hoc.

## Typography

Typography preferences are independent of themes and are persisted under
`rusty_typography_preferences`. The root runtime exposes these roles:

- `--font-size-ide` and `--font-size-ui-*` for application chrome.
- `--font-size-chat` and `--font-size-chat-*` for chat and Markdown.
- A numeric editor size passed through `src/editor/monacoOptions.ts` for Monaco.

Use `.ide-typography-scope` at the application shell and
`.chat-typography-scope` around chat surfaces. Xterm buffer text and
user-authored React Flow node text intentionally remain independent.

Run `npm run theme:check` and `npm run build` after changing UI colors. Fixed
brand artwork and user-selectable sticky-note colors are intentional exceptions.
