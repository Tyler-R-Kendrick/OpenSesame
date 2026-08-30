# Vault VFS — tree rendering + TUI keyboard navigation

Design contract. Decision record: [ADR 0064](../adr/0064-vault-vfs-keyboard-first.md).
Design language: `DESIGN.md` "VFS interaction model". Library:
[`@pierre/trees@1.0.0-beta.6` (installed)](https://trees.software/docs) —
React entry `@pierre/trees/react`.

Sibling rules that still apply: terse, no prose, ceremony per fork
([access-screen.md](access-screen.md) hard rules).

## Pieces

### 1. `lib/vault/paths.ts` (new)

The canonical path space, mirroring the VFS tombs (ADR 0063):

- `itemPath(item, folders) → string` — `Folder/Item Name` (root items at
  `Item Name`). The vault model currently supports one folder level. `/` in
  display names becomes the full-width `／`, because `@pierre/trees` reserves
  `/` as its path separator.
- `tombPath(tomb, path) → string` — display form `personal:/Work/GitHub`.
- Tests: folder/root items, slash preservation, tomb display.

### 2. `sections/vault/VaultTree.tsx` (new) — the isolation boundary

Wraps `useFileTree` + `<FileTree>`:

- Paths from unlocked items + folders (sorted folders-first, then name —
  the current `sortItems` order per folder).
- `density: "compact"`, `search` enabled with `fileTreeSearchMode:
  "hide-non-matches"`, folders collapsed by default (the KeePass idiom —
  you enter a directory deliberately); `initialExpandedPaths` from a
  per-tomb persisted expansion set (`config/tree-expansion` in the VFS,
  via `lib/vfs.ts`).
- Icons: object remap by "extension" → kind glyphs (map each item path to
  a kind pseudo-extension: `.login`, `.secret`, `.drop`, …) or
  `byFileNameContains` — pick the cleanest fit; folders keep directory
  icons. Kind colors off (`minimal` set, monochrome) per the no-noise rule.
- `onSelectionChange`/`onMutation` → the section reads focused path for
  the status line and opens detail on activation (Enter/click → navigate
  to `/vault/:id`).
- Exposes `vaultTreeSeams` — `{ useFileTree, FileTree }` (or a `createModel`
  factory) so tests drive a fake model instead of the shadow DOM.

### 3. The keymap engine — `lib/keymap.ts` + `components/KeymapSheet.tsx`

- Global listener (mounted in `AppShell`), ignored while typing in
  inputs/textareas/contenteditable or while a ceremony sheet owns focus.
- Map (DESIGN.md is the source of truth):
  `j/k/↓/↑` move cursor · `l/→` open · `h/←` climb/collapse · `gg/G`
  top/bottom · `Enter` open item · `/` tree search · `Esc` close/back ·
  `y` copy secret · `u` copy username · `e` edit · `x` trash · `n` new ·
  `.` favorite · `g v/c/a/i/s` section jumps · `?` keymap sheet.
- The engine talks to the tree model through seams (`focusNextItem`,
  `focusPreviousItem`, `focusFirstItem`, `focusLastItem`,
  `focusParentItem`, directory `expand/collapse/toggle`), never the DOM.
- `KeymapSheet`: the `?` overlay — a plain table of the map, Esc closes.
- Item verbs act on the focused path's item (copy via the existing
  clipboard helper with auto-clear; trash via store; favorite toggle).

### 4. Status line — in `VaultSection` under the tree

`personal:/Work/GitHub · 3 of 42 items · Favorites` — focused tomb path
(from the model's focused path), visible/total counts, active filter.
Mono, `--ink-3`, one line.

### 5. What changes in `VaultSection`

- The row `<ul>` + `ItemRow` list is replaced by `VaultTree` (filters,
  search, count, Import/New header, trash/favorites, folder grouping all
  preserved — the filter set maps onto tree state: favorites/trash are
  filtered path sets, folder grouping IS the tree).
- The existing `/`-focuses-search behavior now opens tree search.
- `ItemRow`'s favorite star / timer icon / share button move into row
  decoration (`renderRowDecoration`) — expiry chip for drops, star for
  favorites; the secret share action stays reachable (`?` sheet lists the
  key for it too: `s` share once on a secret row).

## Test plan

- `paths.test.ts`: mapping, escaping, round-trip, tomb display.
- `keymap.test.ts`: the engine drives model seams per key (j/k/gg/G/l/h,
  section jumps, typing-guard, ceremony-guard).
- `VaultSection.test.tsx`: replace row-DOM assertions with model-seam
  assertions (visible paths after filter/search, Enter opens detail,
  `y` copies the focused item's secret, `x` trashes, status line text).
  Keep the seam-injected fake `FileTree` model — no shadow-DOM queries.
- Expansion persistence: toggle writes `config/tree-expansion`; reopen
  restores.

Gates: `pnpm --filter @opensesame/pages test`, `tsc --noEmit`, per-file
oxlint anti-slop, biome, `npx impeccable detect apps/pages/src` = 0.
