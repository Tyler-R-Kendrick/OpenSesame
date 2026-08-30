# ADR 0064 — The vault renders as a VFS; the keyboard is first-class

Status: Accepted
Date: 2026-08-29
References: ADR 0061 (ceremony per action, no prose), ADR 0063 (each vault
is a tomb), design language in `DESIGN.md` ("VFS interaction model"),
[`@pierre/trees` docs](https://trees.software/docs)

## Context

The vault list is a flat, pointer-first webpage list. The audience that
lives in a password manager daily — the KeePass power-user crowd — navigates
by keyboard, thinks in paths, and expects a filesystem, not a card wall. Our
own storage layer already made the same move (ADR 0063: every vault is a
tomb in an encrypted VFS). The UI should present the same model the storage
uses: **the vault is a filesystem.**

## Decision

- **Tree rendering.** The vault list becomes a file tree rendered by
  `@pierre/trees` (the [trees.software](https://trees.software) library —
  path-first model, built-in selection/focus/search, virtualized rows,
  compact density). Tomb root is the tree root; folders are directories;
  items are files addressed by canonical paths (`personal:/Work/GitHub`).
  The library is pinned to its installed beta and isolated behind one
  component (`VaultTree`) so a swap remains cheap.
- **TUI-grade keyboard navigation.** A cursor row owns focus in the tree;
  `j`/`k`/arrows move, `l`/`h` enter/climb, `gg`/`G` jump, `Enter` opens,
  `/` searches, single-key verbs (`y` copy secret, `u` copy username, `e`
  edit, `x` trash, `n` new, `.` favorite), `g <letter>` section jumps, `?`
  keymap sheet. The existing `/`-focuses-search shortcut is preserved.
- **Status line.** A ranger-style footer under the tree: focused path, item
  count, active filter.
- **Everything else stays.** Filters, favorites/trash views, the detail
  pane, import, and every existing pointer affordance — the tree replaces
  the row list, not the vault's capabilities.

### Deviations, recorded honestly

- **Beta dependency.** `@pierre/trees@1.0.0-beta.6` is pinned exact; the
  isolation boundary (`VaultTree` + `lib/vault/paths.ts`) keeps the blast
  radius to one component and one mapper if the beta moves.
- **Shadow DOM.** The library renders inside a shadow root; tests drive its
  model (paths, focus) through seams instead of DOM queries, matching our
  seam-test discipline.
- **Other sections keep their layouts.** The VFS treatment applies to the
  vault tree and the global keymap (section jumps); Access/Identity
  tables keep their own idioms per ADR 0061.

## Consequences

- One canonical path space spans storage (VFS tombs) and UI (tree) — the
  "each vault is a tomb" story becomes visible to the user.
- Power users can run the entire vault without a pointer; the keymap is
  documented in-app (`?`) and in `DESIGN.md`.
- Tests assert tree behavior through the model seam (visible rows, focused
  path), which is stabler than shadow-DOM scraping.
