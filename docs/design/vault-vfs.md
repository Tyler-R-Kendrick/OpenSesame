# Vault VFS — first-party tree + TUI keyboard navigation

Design contract. Decision records: [ADR 0064](../adr/0064-vault-vfs-keyboard-first.md)
(interaction contract), [ADR 0073](../adr/0073-first-party-vfs-tree.md)
(first-party rendering, rail-as-tree, folders open by default).
Design language: `DESIGN.md` "VFS interaction model".

Sibling rules that still apply: terse, no prose, ceremony per fork
([access-screen.md](access-screen.md) hard rules).

## Pieces

### 1. `lib/vault/paths.ts`

The canonical path space, mirroring the VFS tombs (ADR 0063):

- `pathSegment(name)` — display segment; `/` in names becomes the
  full-width `／` so it can never read as a separator.
- `itemPath(item, folders)` — `Folder/Item Name` (root items at `Item Name`).
- `tombPath(tomb, path)` — display form `personal:/Work/GitHub`.

### 2. `sections/vault/VaultTree.tsx` — the pane

First-party, light-DOM, everything mono:

- **Rows.** Directories first (trailing `/`, chevron, child count), then
  root items; items are `name` + dimmed kind pseudo-extension: `.login`,
  `.passkey`, `.card`, `.secret`, `.drop`, `.note`, `.cert`. Row order is
  the section's `sortItems` order per folder.
- **Cursor.** One row is always the cursor (accent wash + hairline inset
  ring; name goes weight-650). It follows the open item, else holds its row,
  else falls to the first row. The container is `role="tree"` with
  `tabIndex=0` and `aria-activedescendant`; rows are flat `treeitem`s with
  `aria-level`/`aria-expanded`/`aria-selected`.
- **Path strip.** Top of the pane: `personal:/` (tomb accent-colored) left;
  clickable `/` and `?` key chips right (`?` goes through
  `showKeymapHelp()` in `lib/keymap.ts`).
- **Search.** `/` opens a vim-style command line at the pane's foot — a real
  `<input>`, so the keymap's typing guard holds. Filtering hides
  non-matches, forces matched directories open, and highlights the matched
  substring; `Esc` clears and closes, `Enter` returns focus to the tree.
- **Expansion.** Folders open by default; collapse persists per tomb at
  `config/tree-collapsed` (JSON array of `Dir/` paths) via `lib/vfs.ts`.
- **Decorations.** Drop expiry clock (`Expires …` title), favorite star,
  SYNTHETIC chip. Pointer verbs live in a per-row `⋯` menu (Open,
  Favorite/Unfavorite, Share once on secrets, Edit, Trash).
- **Status line.** Ranger-style `<output>`: focused tomb path left
  (`personal:/Sample data/GitHub.login`), `visible/total · filter` right —
  or `matches/total · /query` while searching.
- Seams: `vaultTreeSeams = { activeTomb, loadCollapsed, saveCollapsed }`;
  tests drive the real DOM, not a model fake.

### 3. The keymap — `lib/keymap.ts` + `components/KeymapSheet.tsx`

- Global window listener (mounted in `AppShell`), ignored while typing in
  inputs/textareas/contenteditable or while a dialog owns the page.
- Map (DESIGN.md is the source of truth): `j/k/↓/↑` move · `l/→` open/dive ·
  `h/←` collapse/climb · `gg/G` first/last · `Enter` activate · `/` search ·
  `Esc` close · `y` copy secret · `u` copy username · `e` edit · `x` trash ·
  `n` new · `.` favorite · `s` share once · `g v/c/a/i/s` section jumps ·
  `?` keymap sheet.
- `registerVaultKeymap(target)` binds the tree; `registerKeymapHelp(show)` /
  `showKeymapHelp()` give pointer twins a way to open the `?` sheet.

### 4. The rail — `components/AppShell.tsx` `NavTree`

The rail renders the same filesystem one level up, mono:

- Root line `personal:/` (active tomb).
- Sections as directories: `vault/ 7 gv`, `connections/ gc`, `access/ ga`,
  `identity/ gi`, `settings/ gs` — count on vault, `g`-jump key chip on all.
- The active section is the open directory. Under `vault/`: `all`,
  `favorites`, kind views (`logins`, `passkeys`, `cards`, `secrets`,
  `drops`, `notes`, `certs`), `trash`, the real folders (`Sample data/`),
  and `health`, each with live counts, indent-guided. Under `settings/`:
  the five categories.
- Active row takes the cursor treatment (accent wash + ring). The mobile
  tab bar keeps its labeled icons.

## Test plan (implemented)

- `paths.test.ts`: mapping, escaping, tomb display.
- `keymap.test.ts`: per-key dispatch, typing/ceremony guards, `g` chords.
- `VaultSection.test.tsx`: rows as files with extensions, visible cursor
  driven by `j/k/gg/G`, status-line path + counts, `/` command line filters
  and never leaks keys, `h`/`l` climb/dive, collapse persistence round-trip
  (`config/tree-collapsed`), decorations, `⋯` menu, filters/chips, verbs.
- `AppShell.test.tsx`: rail directories + `g`-jump chips, vault entries and
  counts, settings categories under `settings/`, active-row marking.

Gates: `pnpm --filter @opensesame/pages test`, `tsc --noEmit`, per-file
oxlint anti-slop, biome, `npx impeccable detect apps/pages/src` = 0.
