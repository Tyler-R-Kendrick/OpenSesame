# ADR 0192 — Vault environments: values live on the items, the `.env.schema` is generated from them

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** OpenSesame maintainers
- **Supplements:** ADR 0130 ([operator-controlled capability composition](0130-operator-controlled-capability-composition.md)),
  ADR 0144 (field-time merge), ADR 0149 ([nothing stored in the clear](0149-nothing-stored-in-the-clear.md)),
  ADR 0157 ([logs and events carry no secrets](0157-logs-and-events-carry-no-secrets.md)),
  ADR 0158 ([Settings rows act or are absent](0158-settings-rows-act-or-are-absent.md))
- **Related:** ADR 0006 ([env-spec delivery modes](0006-env-spec-delivery-modes.md)),
  ADR 0087 ([vault item types are plugins](0087-vault-item-type-plugins.md)),
  ADR 0165 ([item-type packs](0165-item-type-packs-on-demand.md))

## Context

`vault.environments` was requested as: with the capability on, a vault can have
named environments; a `.env.schema` is generated to specify the keys; a person
toggles between environments to assign values; an item can be marked required
per environment; a required item with no value in an environment raises a
notification; and none of it exists in the minimal installation.

The module that shipped under that name passed its unit tests and did none of
that for a person. Switching the capability on in a running Pages build
(`pnpm dev:pwa`, guest vault, Settings › Features › Environments, which was
Settings › Capabilities › Environments until ADR 0189 split that page) showed:

1. **Nothing in the vault.** The only trace was a block at the bottom of
   Settings › Vaults, below the 23-row item-type list. The vault, where the
   items are, said nothing about environments.
2. **Nothing kept.** Environments, required flags and values lived in a
   module-level `Map`. A reload emptied it. The values were secrets, held in
   the clear in memory and drawn in a visible `<input>`, outside the sealed
   body that ADR 0149 requires for everything the client stores.
3. **Every item was a key.** The schema listed one key per vault item, so a
   vault of 500 logins would generate a 500-key schema.
4. **The notice was conditional on a panel.** The missing-value notice was
   computed in an effect of the Settings panel, so it could only exist while
   that panel was open, and it only looked at the active environment.

The decision here is what an environment *is* in the vault's data, and what the
`.env.schema` is relative to it. `.env.schema` as a new vault item type was the
first option raised, so it is weighed directly.

## Options considered

### A. `.env.schema` as a vault item type

One item per vault, of a new type whose body is the schema text.

- **For.** Reuses everything an item gets: sealing, sync, trash, search, a
  place in the list, a text editor. A person can read and edit the file.
- **Against.**
  - *It is two copies of one fact.* The keys are the vault's items and
    "required" is a per-environment flag. A schema item is either derived
    (stale the moment an item is renamed, trashed or purged, and nothing can
    re-derive it from a manifest) or authoritative (keys become free text
    detached from the items that hold their values, which is not "mark
    individual vault items as required").
  - *A manifest cannot generate.* ADR 0087: an item type is a JSON manifest,
    never a code path, from a closed field catalogue. "Compute my body from
    the other items" is a code path.
  - *It does not carry the values.* In the `@env-spec` model the schema holds
    keys, types and rules, and values live per environment (`.env.production`).
    The item would solve the file and leave the actual request, "assign values
    per environment", unmodelled.
  - *Off is not absent.* ADR 0165 makes non-core types packs switched on in
    Settings › Vaults. That is a second switch for one feature, and a vault
    synced from a device that has the item would show a schema item on a device
    that has neither the pack nor the capability. ADR 0158: a setting is not
    removable while something depends on it.
  - *Merge.* Concurrent edits to one text blob last-writer-wins the whole file.

### B. Folders as environments

`production/API_KEY`, `staging/API_KEY`: an environment is a top-level folder.

- **For.** No new data. Paths, sync, search and trash already work.
- **Against.** Duplicates an item per environment, so "required" has nowhere to
  live and the key's identity is a name coincidence. A required key missing from
  an environment is an *absent item*, which no list shows. It conflates the
  folder tree (organisation) with a dimension of the data, and folder grants
  would start meaning environment access.

### C. One vault-level document holding a matrix

`environments: { production: { <itemId>: { value, required } } }` on the body.

- **For.** One place; trivial to render the grid.
- **Against.** Cells are orphaned when an item is purged, renamed ids drift, and
  trashing an item does not take its values with it. The matrix merges as one
  value, so two devices assigning different cells lose one device's edit, unless
  a bespoke cell-wise merge is written beside the item merge that already does
  that job. Nothing about the item (share, export, restore from trash) carries
  its values.

### D. Cells on the items, names on the body, schema generated (chosen)

- Each item that is a key carries `environments: { <name>: { value?, required? } }`.
- The vault body carries the list of environment names.
- The `.env.schema` is a pure function of those two. It is a view, never stored.

## Decision

### 1. Data

`BaseItem.environments?: Readonly<Record<string, EnvironmentCell>>` with
`EnvironmentCell = { value?: string; required?: boolean }`. **An item is a key
in the schema exactly when it has an `environments` object**, so a vault that
never uses the feature carries nothing, and a vault of 500 logins and 4 keys
generates 4 keys. Removing a key from the schema deletes the property.

`VaultBody.environments?: Readonly<Record<string, { at: string; removed?: true }>>`
is the environment list: name → when it was added, or when it was removed. A
removal stays as a marker so another device cannot resurrect the name; per name,
the later `at` wins and a tie goes to removal, so either merge order agrees.

Both are sealed in the body and covered by ADR 0149 like every other field, and
neither can reach a subtitle, search text or a file name (ADR 0087's
concealment rule): environment values are concealed fields in everything but
name.

Merge reuses ADR 0144's machinery instead of a second one. A cell is its own
field time, `environments.<name>`, exactly as a typed item's `values.<name>`
already is, so production edited on one device and staging on another both
survive. The body list uses the restamping rule `masterWrap` already uses (a
hybrid logical clock, so a wrong clock cannot lose an edit).

Which environment the sheet is looking at is held per tab, in memory, and is not
vault data: choosing what to look at must not be a write that syncs. A new tab
starts on the first environment.

### 2. The generated schema

`renderEnvSchema(names, keys)` emits `@env-spec`, which the repo's pinned
`@env-spec/parser` (the one `crates/env-spec` and `opensesame dev check` use)
reads in a test, so the text is the real dialect and not a lookalike:

```
# Generated by OpenSesame from this vault's environments. Holds no values.
# @currentEnv=$APP_ENV @defaultRequired=false
# ---

# @type=enum(development, staging, production) @required @public
APP_ENV=development

# @sensitive @required=forEnv(staging, production)
STRIPE_API_KEY=

# @sensitive @required
DATABASE_URL=

# @sensitive
DEBUG=
```

"Required per environment" is expressible in one file: varlock's
`@required=forEnv(...)` against `@currentEnv`. A key required in every
environment is a bare `@required`; one required nowhere carries no decorator.
Every key says `@sensitive` itself rather than leaning on a header default,
because OpenSesame's own reader (`packages/env-spec-bridge`) looks at a key's
decorators only. Values are never written into the schema (it is the file that
gets committed); they stay in the vault, per environment.

The variable is derived from the item's name (`environmentKey`): upper-cased,
runs of non-alphanumerics to `_`, a leading digit prefixed. Two items that derive
the same name are told apart by `_2`, `_3` in creation order, deterministically,
so every device derives the same schema from the same vault; `APP_ENV` is the
schema's own flag and is reserved.

### 3. Capability

`vault.environments` stays an optional capability, **off by default and absent
from the minimal profile** (`minimal-surface.test.ts`, the profile fixtures).
With it off nothing loads: no key, no sheet, no notice, no code. Data already in
a body is left alone and untouched, never deleted by turning the switch off, and
other devices that sync it simply carry it.

There is no second per-vault "enabled" switch. A vault has environments when it
has one, and the first is created from the sheet. A second switch would be a
state with no action behind it (ADR 0158).

### 4. Surface: in the vault, not in Settings

- The Settings panel is removed. Configuration lives where the data is.
- A **key in the vault's path strip** (`vault-command`, the seam Import and
  Export use) with an `Entry` in the Add button's menu on a phone. It opens the
  **Environments sheet**, addressed as `/vault?environments=1` (the vault's own
  route, so a notice can point at it and Back closes it).
  A phone has no key strip, and the Add button's touch road (hold and slide) has
  two zones that Import and Export hold, so a finger reaches the sheet by typing
  `/environments` in the command bar (a `command-path` and a redirect `route`
  that lands on the vault's own address), or from the notice's open key once an
  environment has a gap. The Add menu entry is the road for a keyboard, a mouse
  or a screen reader. A third slide zone, or a vault rail entry contributed by a
  capability, would add a pointing road and is not part of this decision.
- The sheet: an environment switch (a tab per name; with none yet, the three
  usual names are one press each) and an add-name field; one row per key with a
  *required* switch, a concealed value input with reveal and copy, and a
  `StatusMark` (set, missing). An *add key* search over the vault's items (a
  vault of 500 logins is searched, never listed); a *remove key* key on each
  row and a *remove environment* key on the tabs, each asking twice because each
  deletes values. Below, the generated `.env.schema` with a copy key. A value is
  committed when typing settles, on blur, and when the sheet closes, not per
  keystroke; a row exists per key *and* environment so a tab change can never
  commit a value into the environment it was not typed in.
- It follows ADR 0158 and DESIGN.md: icon keys with accessible names, state as
  `StatusMark`, failures in the tray, no explainer prose, square corners, one
  way out (the close key).

### 5. Notification

A required key with an empty value in any environment raises one status notice
in the tray, `vault.environments.missing`: *"Environment values missing"*, body
`production: STRIPE_API_KEY, DATABASE_URL`. Keys and environment names only,
never a value (ADR 0157). Its `open` target is the sheet. It is owned by a
`background-job` of the capability, not a panel, so it exists whenever the vault
is unlocked and the capability is on, tracks every environment rather than the
active one, clears the moment the last gap is filled, and is withdrawn when the
capability is disposed. Locking clears the tray, and the job reasserts it on the
next unlock.

The earlier "the same secret value in production and another environment"
warning (`vault.environments.reuse`) is kept, now comparing sealed values in
memory directly rather than through a short hash that suggested a blindness it
did not have. The notice names keys only.

### 6. Agent surfaces

None. Environment values are secrets and the capability owns no operation
(ADR 0065): there is no MCP, WebMCP or CLI verb that reads or writes one, and
the capability registry records the exclusion with this ADR. An agent that needs
a value gets a `ConnectionRef` and an Intent (ADR 0005), not a `.env`.

## Consequences

- An environment survives a reload, a lock, and a second device, and its values
  are sealed with the vault. Previously none of those held.
- The schema cannot go stale: it is recomputed from the items on every render.
- Renaming an item renames its schema key. That is deliberate (the item *is* the
  key) and the sheet shows the derived key beside each row so it is never a
  surprise.
- Trash, purge, restore and field-level merge behave for cells because the cells
  are on the item. A purged item leaves no orphan cell.
- The pass-style sealed-store bridge enumerates item properties by kind; it
  carries `environments` in its JSON trailer so a round trip does not erase a
  key's cells.
- Not done here, and deliberately: exporting a plaintext `.env.<name>`, importing
  an existing `.env.schema` to create keys, renaming an environment, an
  *Environments* section on the item's own view, and a Host/daemon reader. Each
  is additive over this data. A plaintext export in particular is a second-press
  ceremony of its own (ADR 0086's pattern), not a side effect of editing.
- A new `.env.schema` item type remains possible later as an *import* source
  (parse a pasted schema into keys). It would not be where the data lives.
