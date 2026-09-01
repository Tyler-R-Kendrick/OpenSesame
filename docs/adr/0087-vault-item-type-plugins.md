# ADR 0087 — Vault item types are plugins: one definition format, one native secret

Status: Accepted
Date: 2026-08-31
Supplements: ADR 0005 ([authority handle / ConnectionRef](0005-authority-handle-connectionref.md)),
ADR 0052 ([password-manager ecosystem bridging](0052-password-manager-ecosystem-bridging.md)),
ADR 0063 ([encrypted VFS tombs](0063-encrypted-vfs-tombs.md)),
ADR 0064 ([vault VFS, keyboard-first](0064-vault-vfs-keyboard-first.md)),
ADR 0065 ([connector/hook architecture](0065-connector-hook-architecture.md)),
ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md)),
ADR 0073 ([first-party VFS tree](0073-first-party-vfs-tree.md))
Research: [docs/research/vault-item-types.md](../research/vault-item-types.md)

## Context

OpenSesame's vault knows seven item kinds — `login`, `passkey`, `card`,
`secret`, `note`, `certificate`, `drop` — and knows them the way Bitwarden
knows its four: as a discriminated union in
`apps/pages/src/lib/vault/model.ts`, a `KIND_LABEL` table beside it, a
`KIND_EXT` table in `paths.ts`, and a `switch (item.kind)` in each of
`ItemEditor.tsx` (884 lines) and `ItemDetail.tsx` (1047 lines). Adding a
bank account means editing five files in one app and shipping a build.

Competing managers ship far more: Keeper has seventeen standard record
types and lets customers author their own as JSON dropped in a directory;
the FIDO Credential Exchange Format standardises nineteen credential types
including driver's licences (ISO 18013-1), passports (ICAO 9303), Wi-Fi
credentials and identity documents. Bitwarden's request for "additional
item types" has been open since 2018 and is nineteen pages long. The
requests are always the same: bank accounts, SSH keys, software licences,
Wi-Fi logins, health insurance — plus the long tail nobody can enumerate,
which is the actual point: tax documents, a country's resident ID card, a
professional licence, a broker account.

The research (linked above) surveyed six managers and two form-schema
libraries. The short version: the systems that opened this up did it by
making a type a *template over a closed catalogue of field types*
(Keeper's `$ref`), served or shipped as data (Passbolt's
`/resource-types.json`, Keeper's `record_type` directory); the systems that
did not are still hardcoding integers on the wire. Nobody in the survey
declares what a type projects onto, and nobody declares which fields are
safe to show without a reveal gesture — the two things this vault needs
most, because our items are also `pass` entries (ADR 0052) and our item
list, search, and VFS filenames all render before any reveal.

ADR 0065 already decided how community extension works here: enter at the
lowest tier that can express it, manifests are inert strictly-parsed data,
and a fixed list of things are never pluggable. This ADR applies that to
the shape of a stored item.

## Decision

### 1. An item type is a manifest, and every type is one

`kind: VaultItemType`, `apiVersion: opensesame.dev/v1alpha1`, the same
envelope as `ConnectorDefinition` (ADR 0065 §4):

```json
{
  "apiVersion": "opensesame.dev/v1alpha1",
  "kind": "VaultItemType",
  "metadata": {
    "id": "bank-account",
    "version": "1.0.0",
    "publisher": "https://opensesame.dev"
  },
  "spec": {
    "title": "Bank account",
    "plural": "Bank accounts",
    "extension": ".bank",
    "categories": ["finance"],
    "summary": "Account and routing numbers, and the PIN that goes with them.",
    "sections": [
      {
        "id": "account",
        "title": "Account",
        "fields": [
          { "id": "bank", "type": "string", "label": "Bank", "required": true },
          { "id": "accountNumber", "type": "concealed", "label": "Account number" },
          { "id": "routingNumber", "type": "concealed", "label": "Routing number" },
          { "id": "accountType", "type": "select", "label": "Type",
            "options": ["checking", "savings"] },
          { "id": "pin", "type": "pin", "label": "PIN" }
        ]
      }
    ],
    "native": { "secret": "accountNumber",
                "trailer": [{ "key": "bank", "field": "bank" }] },
    "cxf": { "credential": "custom-fields" },
    "subtitle": ["bank", "accountType"],
    "search": ["bank", "accountType"]
  }
}
```

This is not a format for *community* types with the seven builtins carved
out beside it. **The seven builtins are manifests in this format**, in
`packages/vault-item-types/definitions/`, loaded through the same registry
as an installed one. A builtin's only privilege is §6's handler binding and
a reserved id. If the generic path is not good enough to render `card` or
`note`, it is not good enough to offer anyone, and we will find that out
first.

### 2. Fields name a closed catalogue; a definition invents nothing

A field's `type` is one of a fixed set, and the set is a platform concern:

*Plain* — `string`, `multiline`, `email`, `url`, `number`, `boolean`,
`date`, `month-year`, `country`, `select`, `phone`.
*Concealed* — `concealed`, `password`, `pin`, `key-material`, `totp`.
*Structured* — `address`, `person-name`, `host-port`, `security-question`,
`payment-card`, `key-pair`.

Per use, a definition may set `label`, `help`, `required`, `placeholder`,
`options` (`select` only), and `multiple`. It may not set a renderer, a
validator, a regular expression, a URL, or a default on a concealed field
(§5). Adding a field type is a change to this repository, reviewed like any
other platform change; adding an *item type* is not. This is Keeper's
`$ref` indirection, and it is what makes a definition inert: a manifest
that can only name behaviours cannot introduce one.

The catalogue is deliberately not JSON Schema. A community-authored JSON
Schema brings `$ref` resolution, unbounded `pattern` regexes evaluated on
what a user types, and a validator we would have to make bit-identical
between TypeScript and Rust. A closed catalogue is a `match` in both.

### 3. Every type projects onto the base native secret

`sealed_store::Entry` — line one is the secret, the rest is a `key: value`
trailer — is the **base ref type**. Every definition declares `native`:
one field promoted to line one, and an ordered list of trailer keys drawn
from other fields. The projection is total (a type with no secret field
projects an empty line one), and its inverse recovers a well-formed item
from any entry, unknown trailer keys included.

That single declaration is what makes a community type a first-class
citizen of the host plane with no host-plane code:

- `opensesame pass show`, `pass ls`, and the `pm-bridges` binaries read a
  community bank-account item the day it is authored;
- `crates/kdbx-bridge` round-trips it;
- ConnectionRef materialisation stays uniform — the broker resolves an item
  to a native entry and never learns its type, so ADR 0005's value-blind
  boundary is untouched by every type anyone ever writes.

`secret` remains the type whose projection is the identity: its one field
*is* line one. Everything else is a decoration of that.

### 4. Interchange has a floor: `custom-fields`

Every definition declares a `cxf` mapping. A type that matches a FIDO CXF
credential names it (`basic-auth`, `credit-card`, `ssh-key`, `wifi`,
`passport`, `drivers-license`, `identity-document`, …); every other type
maps to `custom-fields`, which CXF defines precisely so that what a
standard did not anticipate still round-trips. There is therefore no such
thing as an unexportable community type, and `export/cxf.ts` stops needing
a `switch` over our kinds.

### 5. What a definition may never do

Enforced at parse time, in both implementations, each with a test:

- **Carry a value.** `default` is refused on every concealed field type,
  and no field in the schema can hold item data. A definition is shared and
  synced; a secret in one would be a secret in the shared artefact.
- **Leak a concealed field into a preview.** `subtitle`, `search`, and the
  VFS filename render with no reveal gesture (ADR 0064/0073). A definition
  naming a concealed field in `subtitle` or `search` is refused, not
  silently filtered — a filtered definition would leave the author thinking
  it worked.
- **Name a handler.** `spec.handler` is accepted only on a definition whose
  publisher is the platform's own and whose id is reserved (§6).
- **Shadow a builtin.** A builtin id may not be redefined by an install;
  identity is `publisher + id`, never a bare name that a later install can
  redefine underneath existing items (the MCP/VS Code rug-pull).
- **Reach anything.** No URL field exists in the schema, so no loader can
  be induced to fetch. `deny_unknown_fields` everywhere, a 64 KiB cap, and
  caps on section, field, and option counts.

### 6. Handlers are named by builtins, never by community definitions

Four of our seven builtins do something no data description can: a
certificate is *issued* against the Host API, a drop *creates a claim
session* (ADR 0062), a passkey holds custody-classified key material, and a
secret carries grant ceilings that bound a later delegation. Those keep
their bespoke ceremonies — but as a `handler` named in the definition and
resolved against a platform registry of exactly those names, not as a
`switch (item.kind)`.

A definition whose handler name is unknown to the running client falls back
to the generic ceremony rather than failing, and a community definition may
not carry the field at all. This is ADR 0065's Tier X line drawn for item
types: the pluggable part is *shape*, never *authority*.

### 7. Install and uninstall are data writes

Three sources, resolved in this order, first match wins:

1. **Builtin** — definitions embedded in `@opensesame/vault-item-types` and
   in `crates/vault-item-types` from one shared JSON corpus. Same format,
   no privilege beyond §6.
2. **Vault-installed** — `VaultBody.itemTypes`, inside the sealed body. It
   syncs E2EE to the user's other devices through the existing
   `mergeVaultBodies` path, works offline, and needs no server. This is the
   community path: paste or import a definition, and the type exists.
3. **Host directory** — `OPENSESAME_VAULT_ITEM_TYPE_DIR` for the CLI and
   the bridges, so an operator can provision types for a machine.

No build, no restart, no recompilation, on any of the three. Uninstalling
removes the definition and **never touches items**: existing items of that
type keep their data and render through the generic fallback, which is also
what happens on a device that has not received the definition yet. An
unknown type is a presentation gap, never data loss — `mergeVaultBodies` is
last-writer-wins per item, so a client that "migrated" unknown items to
notes would destroy them on every other device.

### 8. One corpus, two implementations, conformance-tested

`packages/vault-item-types/definitions/*.json` is the single source. The
TypeScript package embeds it for the PWA, the extension, and the client
CLI; `crates/vault-item-types` embeds the same files via `include_str!` for
the gateway, the host CLI, and the bridges. Both parse with the same
rejection table, and each language runs the same fixture corpus — a
definition valid in one is valid in the other, or the build fails.

### 9. What ships as a definition

The seven existing kinds, plus the types the survey and the request named:
`bank-account`, `ssh-key`, `software-license`, `wifi`, `health-insurance`,
`passport`, `drivers-license`, `identity-document`, `database`, `server`,
`api-credential`, `membership`, `contact`, `address`, `document`. Every one
of them is data in `definitions/`, which is the dogfooding claim made
concrete: there is no first-party path that community authors cannot take,
because we did not keep one.

## Consequences

- Adding an item type stops being a code change. `definitions/` plus a
  fixture is the whole diff, and a user can do the same thing at runtime
  without us.
- The seven-arm union in `model.ts` becomes a registry lookup, and the two
  `switch (item.kind)` blocks shrink to the four handler-bound ceremonies.
  Generic rendering carries the rest.
- Community types are `pass`-readable and CXF-exportable on day one,
  because §3 and §4 are declarations rather than integrations.
- The vault body grows a synced `itemTypes` map. It is sealed like
  everything else in the body, and it is the only part of this design that
  crosses devices.
- Two implementations of one parser is real duplication, and §8's shared
  corpus plus conformance fixtures is the price of the host plane and the
  client plane agreeing about what a bank account is.
- The catalogue in §2 is a bottleneck by construction: a community type
  that needs a field type we do not have must ask for one. That is the
  trade the research recommends — an open *type* vocabulary over an open
  *field* vocabulary — because it keeps the rendering surface, the
  validation surface, and the Rust/TypeScript agreement finite.
- `vault.item_types` is registered in `packages/capability-registry` with
  the agent surfaces it may have: listing types is a read, and installing
  one is a human ceremony, never an agent write. An agent that could
  install an item type could define the shape a human is then asked to fill
  in — which is a phishing surface, not a capability.
