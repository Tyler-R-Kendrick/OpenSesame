# ADR 0181 — The editor's title row is one path control, and every field has a cap

- **Status:** Accepted — implemented in Pages and `@opensesame/app-core`
- **Date:** 2026-10-07
- **Deciders:** OpenSesame maintainers
- **Supplements:** ADR 0087 ([vault item types](0087-vault-item-type-plugins.md)),
  ADR 0156 ([keybindings and macros](0156-keybindings-and-macros.md))

## Context

An item is a file: a folder, a name and an extension (`Work/Taxes/` `Account`
`.account`). The editor drew that as three unrelated controls on one line — a
native folder `<select>`, a text input, a native type `<select>` — in the same
grey. Choosing a folder or a type meant leaving the keyboard flow for a
platform menu that cannot be searched, themed or kept to the row's width; a
typed path (`./Work/entry`) worked, but only after the field lost focus; and
nothing said how long a name, a folder path or any other field could be.

## Decision

1. **One row, one control.** `EditorTitle` draws `folder/` `name` `.type` as a
   single `.pathfield`: one rule beneath it that darkens when any part holds
   focus, three inputs inside it. The folder always leads and the type always
   ends; both are drawn in the accent ink and the name keeps the title's own,
   so the two special parts read as structure rather than as part of a name.
2. **The folder and the type are editable comboboxes over a closed list**
   (`PathSegment`, the APG editable combobox with list autocomplete). A click,
   typing or ArrowDown opens the list; typing narrows it (prefix, then folder
   segment, then substring); the best match is highlighted, so Enter — or Tab on
   the way out — takes it. **Text that is not on the list is never kept**:
   leaving the field puts back what was chosen, unless the text names a row
   exactly, which chooses it. Focus alone opens nothing, so tabbing through the
   row shows no menu. Enter never submits the form from these fields. Escape
   closes an open list before anything else sees it.
3. **A folder can still be made, only by choosing it.** When the typed path is
   one a folder could have and none has it, the list ends with one row that
   makes it (`+ Clients/2026/`). It is last, so the best match is what Enter
   takes; the path is rooted where it is typed, not under the folder now chosen.
4. **A slash in the name finishes a folder.** `Work/Taxes/` typed at the start
   of the name moves into the folder segment as the slash is typed, resolved
   against the folder already chosen with `./` and `../` as before
   (`resolveItemPath`); only the leaf stays in the name. A prefix that cannot
   resolve yet stays as typed and is reported when the field is left.
5. **The row is navigable as one thing.** ArrowLeft and ArrowRight at an edge of
   one field cross into the next; Tab still visits each field once, in order.
6. **A type the route fixed is a label.** Only the untyped new-item route offers
   the type list, and only the types this installation may create.
7. **Every field has a cap, from one table.** `FIELD_LIMITS` in
   `packages/app-core/src/lib/vault/field-limits.ts` holds the number for each
   kind of field (name 120, folder path 240, label 64, line 256, list 1024, web
   address 2048, secret 4096, free text 50 000, card number 19). Editor inputs
   read it as `maxLength`; the path resolver refuses a name or new folder over it
   with a message that names the limit. The name field holds a typed path's
   leaf and prefix to their own limits so a paste neither loses its leaf to a
   long prefix nor the reverse. A cap stops text growing: a value stored before
   it is never truncated, an edit that shortens one is taken as made, and
   writing one back unchanged is refused until it is shortened.

## Consequences

- The native selects are gone from the row, so the browser contracts that drove
  them (`editor-path-contract`, `editor-tab-order-contract`, the tailnet
  sync walk) choose rows from the list with the pointer, as a person does
  (`scripts/lib/editor-type.mjs`).
- The type list is searched by extension, id and title, so `.apikey`, `api-key`
  and `API key` find the same row.
- Caps are enforced where a person types and where a path is written, not in
  the vault store: an item that arrives by sync or import is not rejected for
  being long, and the next edit of it is what meets the cap.
- Fields outside the item editor keep the limits they already had; the table is
  where a new one should look first.
