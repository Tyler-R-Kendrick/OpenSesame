# Vault VFS — first-party tree + TUI keyboard navigation

Design contract. Decision records: [ADR 0064](../adr/0064-vault-vfs-keyboard-first.md)
(interaction contract), [ADR 0073](../adr/0073-first-party-vfs-tree.md)
(first-party rendering, rail-as-tree, folders open by default).
Design language: `DESIGN.md` "VFS interaction model".

Sibling rules that still apply: terse, no prose, ceremony per fork
([access-screen.md](access-screen.md) hard rules).

## Pieces

### 1. `packages/vault-core/src/paths.ts`

The canonical path space, mirroring the VFS tombs (ADR 0063):

- `pathSegment(name)` — display segment; `/` in names becomes the
  full-width `／` so it can never read as a separator.
- `itemPath(item, folders)` — `Folder/Item Name` (root items at `Item Name`).
- `tombPath(tomb, path)` — display form `personal:/Work/GitHub`.

### 2. `sections/vault/VaultTree.tsx` — the pane

First-party, light-DOM, everything mono:

- **Rows.** Directories first (trailing `/`, chevron, child count), then
  root items; items are `name` + dimmed kind pseudo-extension, each type's
  own (`KIND_EXT` is the fallback for a legacy kind): `.account`,
  `.passkey`, `.card`, `.secret`, `.drop`, `.note`, `.cert`, and an
  installed type's. Row order is the section's `sortItems` order per folder.
- **Cursor.** One row is always the cursor (inverse video: paper on ink,
  name weight 600). It follows the open item, else holds its row,
  else falls to the first row. The container is `role="tree"` with
  `tabIndex=0` and `aria-activedescendant`; rows are flat `treeitem`s with
  `aria-level`/`aria-expanded`/`aria-selected`.
- **Path strip** (`VaultPathbar.tsx`). Top of the pane: the crumb trail
  (`Vault › Accounts`, `Vault › Work › Webmail`) left; the pane's command
  icon keys and a `?` key right (`?` goes through `showKeymapHelp()` in
  `lib/keymap.ts`). The tomb path is the pane's status line, not the strip.
- **Search.** The pane draws no field. `/` writes `/? ` into the command bar
  and focuses it (`searchInCommandBar`); the words narrow the list as they are
  typed (`use-vault-search.ts`, `lib/command-bar/search.ts`). Filtering hides
  non-matches, forces matched directories open, and highlights the matched
  substring; `Esc` clears the words, `Enter` returns focus to the tree.
- **Expansion.** Folders open by default; collapse persists per tomb at
  `config/tree-collapsed` (JSON array of `Dir/` paths) via `lib/vfs.ts`.
- **Decorations.** Drop expiry clock (`Expires …` title), favorite star.
  Pointer verbs live in a per-row `⋯` menu (Open, Edit, copy, Favorite/
  Unfavorite, Share on secrets, Trash; Open, Restore and Delete permanently
  in the trash).
- **Status line.** Ranger-style `<output>`: focused tomb path left
  (`personal:/Work/GitHub.account`), `visible/total · filter` right —
  or `matches/total · /query` while searching.
- Seams: `vaultTreeSeams = { activeTomb, loadCollapsed, saveCollapsed }`;
  tests drive the real DOM, not a model fake.

### 3. The keymap — `lib/keymap.ts` + `components/KeymapSheet.tsx`

- Global window listener (mounted in `AppShell`), ignored while typing in
  inputs/textareas/contenteditable or while a dialog owns the page.
- Map (DESIGN.md is the source of truth; the catalogue is
  `packages/app-core/src/lib/keymap/commands.ts`, overlaid by the person's
  bindings — ADR 0156). One handler (`createKeymapHandler`) resolves every
  press through the effective keymap, including vim counts (`5j`) and the `g`
  leader (`gg`, `gv`). `j/k/↓/↑` move · `[count]` repeats
  a motion · `Ctrl-d/u` half-page · `Ctrl-f/b` `PgUp/PgDn` page · `H/M/L`
  window edges · `l/→` open/dive · `h/←` `Backspace` collapse/climb ·
  `gg/0/Home` first · `G/$/End` last (`nG` the nth row) · `F6` other
  listing · `Tab`/`Shift-Tab` native control order (never trapped) ·
  `Enter` activate the focused control · `/` search · `Esc` close and focus the tree ·
  `y` copy secret · `u` copy username · `e` edit · `x` trash · `n` new ·
  `.` favorite · `s` share once · `g v/c/a/i/w/y/s` section jumps (`g` times
  out) · `?` keymap sheet.
- `registerVaultKeymap(target)` binds the vault listing;
  `registerRailKeymap(target)` binds the rail; `registerKeymapHelp(show)` /
  `showKeymapHelp()` give pointer twins a way to open the `?` sheet. The
  motion target is whichever listing holds the keyboard, else the vault,
  else the rail.

### 4. The rail — `components/AppShell.tsx` over `components/NavTree.tsx`

The rail renders the same filesystem one level up, mono:

- Root line `personal:/` (active tomb).
- Sections as directories: `vault/ 7 gv`, `connections/ gc`, `access/ ga`,
  `identity/ gi`, `wallet/ gw`, `activity/ gy`, `settings/ gs` — count on
  vault, `g`-jump key chip on all. Sections other than `vault/` and
  `settings/` are contributed by capabilities, so the rail lists only those
  in the plan.
- The active section is the open directory. Under `vault/`: `all`,
  `favorites`, one directory per item type (platform kinds, then installed
  types: `accounts`, `passkeys`, `cards`, `secrets`, `drops`, `notes`,
  `certs`, …), `trash` (hidden until the rail shows hidden items, or while
  you stand in it) and the real folders (`Work/`) that no type directory
  holds, each with live counts, indent-guided. Under `settings/`: the
  categories (General, Keybindings, Security, Vaults, Capabilities, Danger,
  and any a capability contributes). Password health is not an entry.
- Active row takes the cursor treatment (inverse video). On a phone the
  same tree is the vault's first pane (tree → list → item, a back key each).

## Test plan (implemented)

- `packages/vault-core/src/paths.test.ts`: mapping, escaping, tomb display.
- `keymap.test.ts`: per-key dispatch, typing/ceremony guards, `g` chords. <!-- gitleaks:allow -- test filenames, not a credential -->
- `VaultSection.test.tsx`: rows as files with extensions, visible cursor
  driven by `j/k/gg/G`, status-line path + counts, the command bar's words
  narrow the list, `h`/`l` climb/dive, collapse persistence round-trip
  (`config/tree-collapsed`), decorations, `⋯` menu, filters/chips, verbs.
- `AppShell.test.tsx`: rail directories + `g`-jump chips, vault entries and
  counts, settings categories under `settings/`, active-row marking.

Gates: `pnpm --filter @opensesame/pages test`, `tsc --noEmit`, per-file
oxlint anti-slop, biome, `npx impeccable detect apps/pages/src` = 0.
