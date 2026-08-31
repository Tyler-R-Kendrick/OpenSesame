# ADR 0073 — The VFS tree is first-party, and the rail is part of it

Status: Accepted
Date: 2026-08-30
References: ADR 0064 (vault renders as a VFS; keyboard first-class — this ADR
supersedes its rendering decision and keeps its interaction contract), ADR 0063
(each vault is a tomb), design language in `DESIGN.md` ("VFS interaction
model").

## Context

ADR 0064 shipped the vault tree on `@pierre/trees@1.0.0-beta.6`. The built
result was rejected on review, for reasons the library's rendering model made
structural rather than cosmetic:

- **The cursor was invisible.** The keymap drove the library's focus model,
  but no visible cursor row appeared — `j`/`k` did nothing a person could
  see, which defeats the entire point of a keyboard-first tree.
- **The tree read as a generic web widget.** Proportional font, a large
  rounded search box, disclosure chevrons — nothing signaled "filesystem".
  The shadow root kept the design system's tokens out of the rows.
- **Search leaked keystrokes.** The library's search field lives inside its
  shadow root, so the global keymap's typing guard (`event.target instanceof
  HTMLInputElement`) never matched; typing "git" into search fired `g`+`i`
  and jumped the user to the Identity section mid-word.
- **The vault opened looking empty** (every folder collapsed by default).

Separately, the navigation rail still read as a webpage sidebar — icon links
and uppercase group labels — while claiming the product is a filesystem.

## Decision

1. **First-party tree.** `VaultTree` renders the tree itself: plain
   light-DOM rows in the design system's mono stack, virtualization-free
   (vault scale is hundreds of rows, not millions). `@pierre/trees` is
   removed. The ADR 0064 interaction contract (keymap, verbs, `/` search,
   status line, pointer parity) is unchanged and now actually delivered:
   - a visible cursor row (accent wash + hairline ring) that `j`/`k`/arrows
     move, independent of DOM focus, with `aria-activedescendant` tracking
     it on the `role="tree"` container;
   - items render as files — name plus a dimmed kind pseudo-extension
     (`.login`, `.secret`, `.card`, `.drop`, `.passkey`, `.note`, `.cert`) —
     and folders as directories with a trailing `/` and child count;
   - `/` opens a vim-style command line at the foot of the pane backed by a
     real `<input>`, so the typing guard holds; matches highlight,
     non-matches hide, `Esc` clears, `Enter` returns focus to the tree;
   - a path strip pins the tomb root (`personal:/`) at the top of the pane
     and advertises `/` and `?` as clickable key chips;
   - the ranger status line stays: focused path left, `visible/total ·
     filter` (or the live `/query`) right;
   - pointer parity via row click, a per-row `⋯` menu (Open / Favorite /
     Share once / Edit / Trash), and the existing header buttons.
2. **Folders open by default.** ADR 0064's collapsed-by-default made the
   vault look empty on arrival. The tree now opens expanded; collapse is a
   per-tomb persisted choice (`config/tree-collapsed` in the VFS, replacing
   `config/tree-expansion`).
3. **The rail is the same filesystem.** Navigation renders as a mono tree
   rooted at the active tomb (`personal:/`): sections are directories
   (`vault/`, `connections/`, `access/`, `identity/`, `settings/`), each
   advertising its `g`-jump key (`gv` … `gs`) as a key chip. The active
   section is the open directory: the vault's filter views, folders, and
   `health` hang under `vault/` as entries with live counts; the settings
   categories hang under `settings/`. The mobile tab bar keeps its labeled
   icons — thumbs are not a keyboard.

## Consequences

- One beta dependency gone; the tree is ~400 lines of owned React against
  the same seams the tests already drive (`vaultTreeSeams`), now asserting
  real DOM instead of a shadow-DOM model.
- The ranger reading becomes literal: rail = parent listing, vault pane =
  cwd, detail = preview.
- Collapse state saved under the old `config/tree-expansion` key is ignored
  (dev-stage preference data; the new key starts fresh).
- Tests drive the real rows: cursor position, filtering, expansion, and the
  command line are asserted on rendered markup.
