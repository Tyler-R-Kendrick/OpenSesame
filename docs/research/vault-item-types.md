# Vault item types as an extension point — prior-art research

Research input for [ADR 0087](../adr/0087-vault-item-type-plugins.md). This
document records *how other credential managers model the shape of a stored
item*, what each design made easy and what it made impossible, and derives
the rules ADR 0087 turns into a manifest format. It is research, not a
decision record: where this document and ADR 0087 disagree, the ADR wins.

The question under study: OpenSesame ships seven hardcoded item kinds
(`login`, `passkey`, `card`, `secret`, `note`, `certificate`, `drop`). A
user who wants a bank account, an SSH key, a software licence, a Wi-Fi
login, a health-insurance card, a national resident ID, or a folder of tax
documents has no path but a patch to this repository — the same complaint
ADR 0065 answered for connectors. We want the *shape of an item* and the
*ceremony that captures it* to become community-authorable data, without
turning the vault body into an execution surface.

## 1. What OpenSesame already has

The pieces of an item-type system exist, scattered:

- `apps/pages/src/lib/vault/model.ts` — a seven-arm discriminated union,
  `KIND_LABEL`/`KIND_PLURAL` string tables, a `createItem` overload set, and
  hand-written `itemSubtitle`/`searchMatches` switches. Every one of those
  is a per-kind edit, in one file, in one app.
- `apps/pages/src/sections/vault/ItemEditor.tsx` (884 lines) and
  `ItemDetail.tsx` (1047 lines) — one `switch (item.kind)` each. The bodies
  are overwhelmingly the same three moves: label a field, conceal or reveal
  it, copy it. Only certificate issuance, the drop claim, passkey custody,
  and secret grant-ceilings do anything a data description could not.
- `apps/pages/src/lib/vault/paths.ts` — `KIND_EXT`, the file-extension
  vocabulary the VFS tree renders (ADR 0064/0073).
- `crates/sealed-store/src/entry.rs` — the **base native secret**: line one
  is the secret, the remainder is a freeform `key: value` trailer, `parse`
  and `render` exact inverses. `pass` compatibility lives here, and so does
  everything the host plane can already read.
- `apps/pages/src/lib/vault/export/cxf.ts` and `import/formats/*` — a real
  FIDO CXF writer and eleven importers, all of which already do the work of
  mapping foreign item types onto ours and losing what does not fit.
- ADR 0065's extension tiers, its four safety properties, and
  `crates/connector-host/src/manifest.rs` as the worked example of an inert,
  strictly-parsed, `deny_unknown_fields` manifest.

So the missing piece is not storage, crypto, or sync — it is a *type
descriptor* the whole product reads instead of the seven-arm union, and a
generic ceremony that renders it.

## 2. Ecosystem survey

### 2.1 Keeper — record types with a `$ref` field catalogue

Keeper is the system the request names, and it is the closest prior art to
what we want. A **record type** is a JSON template:

```json
{
  "$id": "bankAccount",
  "categories": ["financial"],
  "description": "Bank account record",
  "fields": [
    { "$ref": "bankAccount", "required": true },
    { "$ref": "name" },
    { "$ref": "login" },
    { "$ref": "password" },
    { "$ref": "url" },
    { "$ref": "cardRef", "label": "Payment Card" },
    { "$ref": "fileRef" }
  ]
}
```

The load-bearing idea is that `$ref` points into a **closed catalogue of
field types**, not into an open schema language. Keeper's catalogue is
roughly thirty entries in three shapes:

- *string-shaped*: `text`, `login`, `password`, `secret`, `note`,
  `multiline`, `email`, `url`, `pinCode`, `accountNumber`,
  `licenseNumber`, `otp`, `oneTimeCode`;
- *record-shaped* (a fixed sub-object): `address` (street1, street2, city,
  state, zip, country), `bankAccount` (accountType, routingNumber,
  accountNumber, otherType), `paymentCard` (cardNumber,
  cardExpirationDate, cardSecurityCode), `keyPair` (publicKey,
  privateKey), `host` (hostName, port), `name` (first, middle, last),
  `phone`, `securityQuestion`;
- *reference-shaped*: `cardRef`, `fileRef`, `addressRef`, `date`,
  `birthDate`, `expirationDate`.

Seventeen standard record types ship on that catalogue (`login`,
`bankAccount`, `bankCard`, `birthCertificate`, `contact`,
`databaseCredentials`, `driverLicense`, `encryptedNotes`, `file`,
`healthInsurance`, `membership`, `passport`, `photo`, `serverCredentials`,
`softwareLicense`, `ssnCard`, `sshKeys`), and *custom record types are the
same JSON*, dropped into a `record_type` directory and picked up by
Commander and the SDKs without a client release.

**What to take.** The `$ref` indirection is the whole trick: a template
that can only *name* field types cannot introduce new rendering, new
validation, or new storage behaviour. Adding a type is inert. Also worth
taking: `categories` (how a picker groups thirty types without becoming a
wall), and per-use `label`/`required` overrides so one catalogue entry
serves many templates.

**What to leave.** Keeper's field values are positional inside the record
and identified by `(type, label)` pairs, which makes two fields of the same
type with the same label ambiguous and makes renaming a label a data
migration. We want a stable per-field `id`. Keeper also has no concept of a
multi-step ceremony, no declared projection onto a base secret, and no
declared interchange mapping — those are client behaviours per SDK.

### 2.2 FIDO CXF — an item is a *composition* of typed credentials

The FIDO Alliance published the Credential Exchange Format as a Proposed
Standard in August 2025, and this repository already writes it. Its model
is materially different from Keeper's and worth understanding, because it
is the one interoperability contract that matters:

An **Item** does not *have* a type. An Item carries a list of
**credentials**, each of which is a tagged union member:
`BasicAuthCredential`, `PasskeyCredential`, `TotpCredential`,
`CreditCardCredential`, `NoteCredential`, `SshKeyCredential`,
`ApiKeyCredential`, `WifiCredential`, `AddressCredential`,
`PersonNameCredential`, `DriversLicenseCredential`,
`IdentityDocumentCredential`, `PassportCredential`, `FileCredential`,
`GeneratedPasswordCredential`, `ItemReferenceCredential`,
`AndroidAppIdCredential`, `Fido2HmacCredentials`, and the escape hatch
`CustomFieldsCredential`. Values are `EditableField`s with a `fieldType`
from a closed list (`string`, `concealed-string`, `email`, `number`,
`boolean`, `date`, `year-month`, `country-code`, `subdivision-code`).

Two details deserve emphasis. First, `DriversLicenseCredential` is defined
against ISO 18013-1 and `PassportCredential` against ICAO Doc 9303, and
`IdentityDocumentCredential` explicitly covers national ID cards, tax
identification numbers, and health-insurance cards. A community author
writing a "country resident ID" type is not inventing a schema; there is a
referent. Second, `CustomFieldsCredential` is how *everything the standard
did not anticipate* survives a round trip — which is exactly the guarantee
a plugin ecosystem needs from its interchange format.

**What to take.** Composition is the right internal model too: a `login`
is "basic auth + TOTP + N URIs", a `bankAccount` is "custom fields + a
concealed account number", and the reason our seven kinds each needed a
bespoke editor is that we modelled them as monoliths. Also take
`concealed-string` as a *field-level* property rather than an item-level
one, and take `CustomFieldsCredential` as the mandatory fallback mapping so
no community type is unexportable.

**What to leave.** CXF is a transport format, not a UI contract. It has no
labels-in-locale, no ordering, no required-ness, no sections, no ceremony,
and no notion of which fields are safe to show in a list. It is the thing a
definition *maps to*, not the thing a definition *is*.

### 2.3 Passbolt — resource types as server-served JSON Schemas

Passbolt models a stored item as a **resource type**: a row with an `id`, a
`slug` (`password-and-description`, `password-description-totp`, …), a
`name`, and a `definition` containing *two* JSON Schemas — one for the
`resource` (metadata that stays queryable) and one for the `secret` (the
part that is encrypted). Clients fetch `/resource-types.json` at runtime,
so the server can introduce a type and every browser extension learns it
without shipping.

**What to take.** Two things, both important.

The first is the **split**: a type declares which of its fields are
metadata and which are secret, and that declaration is what the client uses
to decide what may appear in a list, a search index, or a sync header. Our
vault seals the entire body, so the split is not about encryption for us —
it is about *disclosure surface*: an item's subtitle, its search haystack,
and its VFS filename are seen without a reveal gesture, so a definition
must not be able to route a concealed field into any of them. Making that a
schema-level constraint rather than a code review note is the whole value.

The second is that **types arrive at runtime over the same channel as
data**. Passbolt uses its API; our equivalent is the sealed vault body,
which already syncs E2EE across a user's devices (`store-sync.ts`,
`mergeVaultBodies`). An installed definition that lives in the body is
installed on every device, needs no server, and works offline — which is
the only shape that fits an offline-first PWA.

**What to leave.** Full JSON Schema as the definition language. Passbolt
gets away with it because its schemas are first-party and few. A
community-authored JSON Schema is a parser attack surface: `$ref`
resolution (including remote refs), `pattern` as unbounded regex (ReDoS on
a string the user types), unbounded nesting, and a validator whose
behaviour differs between our TypeScript and Rust implementations. The
lesson from ADR 0065 §4 is that a manifest should be a closed struct with
`deny_unknown_fields`, not a general-purpose language.

### 2.4 Bitwarden — the negative control

Bitwarden has four cipher types (`login`, `secure note`, `card`,
`identity`), hardcoded as integers on the wire, with SSH keys added
recently by extending that closed set rather than opening it. Its
"Additional item types (pre-defined)" feature request has been open since
2018 and is nineteen pages long; the requests in it are the same list the
user gave us — Wi-Fi, licences, bank accounts, insurance. The workaround
Bitwarden points users to is custom fields on a secure note.

**What this proves.** Custom fields are not a substitute for a type. A
custom-field pile has no ordering, no per-field concealment defaults, no
validation, no ceremony, no interchange mapping, and no way for a second
tool to know what it is looking at. Ten years of a closed set is what
happens when the type vocabulary is a compile-time artefact of the vendor —
and it is the failure mode this ADR exists to avoid.

### 2.5 1Password — vendor-closed templates

1Password exposes item categories as JSON templates (`op item template
list` / `op item template get`), with sections, fields, and per-field
`purpose`/`type`. The template format is genuinely good — sections with
stable ids, fields with ids and labels, a `concealed` type — and it is
close to what we want. The catch is that `op item template get` reads from
a fixed vendor list; there is no `op item template add`. Templates are data
the vendor authors, not an extension point.

**What to take.** Sections with stable ids and labels; per-field `id`
distinct from `label`; `purpose` as a hint that binds a field to a
behaviour (`USERNAME`, `PASSWORD`, `NOTES`) without hardcoding the field
name. That last one is how a generic autofill or a generic "copy password"
key can work over an unknown community type.

### 2.6 KeePass — untyped templates, as the floor

KeePass entry templates are an ordinary entry in a `Templates` group whose
string fields are copied into new entries. Fields are untyped strings with
a per-field "protected" bit. There is no catalogue, no validation, no
ordering guarantee, and no semantics — `Card Number` and `card_number` are
different fields forever.

**What this proves.** The protected bit alone (which is all KDBX gives us
in `crates/kdbx-bridge`) is enough for storage and nothing else. Any
importer bridging KeePass into a typed vault is guessing, which is exactly
what `import/formats/kdbx.ts` does today. A type system's job is to stop
the guessing at the *authoring* end.

### 2.7 Schema-driven form libraries — JSON Forms, RJSF

Both generate a form from a data schema plus a separate UI schema
(`uiSchema` in RJSF, a UI-schema document in JSON Forms), which is the
right separation: what the data *is* versus how it is *laid out*. JSON
Forms is the stricter of the two about keeping them apart, and generates a
default UI schema when none is given.

**What to take.** The separation, and the default. A definition should be
able to say only "these fields, these types" and get a sensible ceremony;
`sections` and step grouping are refinements on top, not prerequisites.

**What to leave.** The libraries themselves. Both are React-coupled
(RJSF), or bring a renderer registry and a JSON Schema validator we would
have to mirror in Rust for `opensesame pass` to agree with the PWA. Our
field-type catalogue is closed and small; a hand-written renderer over it
is a few hundred lines and is the same in both languages.

## 3. Failure modes this design has to survive

Collected from §2 and from ADR 0065's incident survey, restated as things a
vault-item-type mechanism specifically can get wrong:

1. **The manifest becomes code.** WordPress-shaped: a descriptor grows an
   expression language, then a callback, then ambient authority. Mitigation:
   a closed struct, `deny_unknown_fields`, no expression beyond `{fieldId}`
   substitution in one place, no URL a loader would fetch, no handler name a
   community definition may bind.
2. **The manifest carries a value.** A definition is shared and synced; a
   `default` on a concealed field would put a secret in the shared artefact.
   Mitigation: `default` is refused outright on any concealed field type,
   and the type is refused if it declares a value anywhere else.
3. **A concealed field leaks through a preview.** The subtitle, the search
   haystack, and the VFS filename are all rendered without a reveal gesture.
   A definition that could name a concealed field in `subtitle` would
   silently publish it into the item list. Mitigation: validation-time
   refusal, in both implementations, with a test per surface.
4. **An unknown type destroys data.** Device A installs a type, creates
   items, syncs; device B does not have the definition. A client that drops
   unknown items, or "migrates" them to `note`, loses the user's data
   permanently because `mergeVaultBodies` is last-writer-wins per item.
   Mitigation: an unrecognised type renders through the generic fallback
   with its raw fields intact and round-trips byte-for-byte; uninstalling a
   definition never touches items.
5. **Two implementations disagree.** The PWA seals the body; `opensesame
   pass` and `kdbx-bridge` read the same items. If the TypeScript and Rust
   validators diverge, a definition valid on one plane corrupts on the
   other. Mitigation: one JSON corpus of definitions, embedded by both, and
   a conformance test in each language over the same fixtures.
6. **Type identity is a mutable name.** The MCP/VS Code rug-pull: consent
   (or in our case, an item's meaning) bound to a name someone else can
   redefine. Mitigation: an installed definition is keyed by
   `publisher + id`, a builtin id may not be shadowed, and an item stores
   the type id it was created with.
7. **The escape hatch becomes the product.** If the generic renderer is
   worse than the bespoke ones, every new type gets a bespoke editor and the
   plugin path rots. Mitigation: dogfooding — the shipped types are
   definitions, and the ceremonies that keep bespoke code keep it only for
   the parts that call the host (certificate issuance, drop claims, passkey
   custody), declared in the definition rather than switched on `kind`.

## 4. The base native secret, and why every type needs a projection

`crates/sealed-store/src/entry.rs` is already a universal representation:
line one is the secret, the trailer is `key: value` lines, `pass` and
`gopass` and `browserpass` all read it, and `crates/kdbx-bridge` maps KDBX
onto it. The host plane's ConnectionRef materialisation, the `pm-bridges`
binaries, and `opensesame pass show` all speak it.

That makes it the natural **base ref type**: every item type, builtin or
community, declares which of its fields is the secret (line one) and which
fields render into the trailer under which keys. The projection buys three
things at once:

- a community type is immediately readable by `opensesame pass`, the
  KeePassXC bridge, and the credential helpers, with no plugin on the host
  side and no host-side code at all;
- ConnectionRef materialisation stays uniform — the broker resolves an item
  to a native entry and never learns the type;
- round-tripping through a foreign password manager degrades predictably
  instead of arbitrarily.

The constraint it imposes is that exactly one field may be the secret line,
which matches `Entry`'s invariant that line one holds no newline. Types
with several concealed fields (a bank account with an account number and a
PIN) nominate one as the projection secret and carry the rest as trailer
keys — which is what `pass` users already do by hand.

## 5. Rules derived for ADR 0087

1. A vault item type is **inert data**: a strictly-parsed manifest with
   `deny_unknown_fields`, a size cap, and no field that can carry a value,
   a URL, or a handler name.
2. Fields reference a **closed catalogue** of field types (Keeper's `$ref`,
   CXF's `fieldType`), with per-use `label`, `required`, and `help`
   overrides. Adding a field type is a platform change; adding a *type* is
   not.
3. Every field has a stable `id`; labels are presentation and may change.
4. Concealment is a property of the field type, and **no concealed field
   may appear** in `subtitle`, `search`, or the VFS filename — enforced at
   validation, in both languages.
5. Every type declares a **projection onto the base native secret**
   (`sealed_store::Entry`), and a **CXF mapping** that falls back to
   `custom-fields` so nothing is unexportable.
6. Types are **loaded at runtime**: builtins are embedded definitions (same
   format, no privilege), installed ones live in the sealed vault body and
   sync E2EE; a host-plane directory serves the CLI. Install and uninstall
   are data writes, never a build.
7. An **unknown type is preserved**, never coerced or dropped, and renders
   through the generic fallback.
8. Behaviour data cannot express (certificate issuance, drop claims,
   passkey custody, grant ceilings) is a **platform-registered handler
   named by a builtin definition**; a community definition may not name one.
   That is ADR 0065's Tier X line, drawn for item types.

## 6. Sources

- Keeper — [Field/Record Types](https://docs.keeper.io/en/keeperpam/secrets-manager/about/field-record-types),
  [Custom Record Types](https://docs.keeper.io/en/keeperpam/secrets-manager/secrets-manager-command-line-interface/custom-record-types),
  [Record Types (enterprise)](https://docs.keeper.io/enterprise-guide/record-types)
- FIDO Alliance — [Credential Exchange Specifications](https://fidoalliance.org/specifications-credential-exchange-specifications/),
  [announcement](https://fidoalliance.org/fido-alliance-publishes-new-specifications-to-promote-user-choice-and-enhanced-ux-for-passkeys/),
  [`credential-exchange-format` crate docs](https://docs.rs/credential-exchange-format)
- Passbolt — [resource types API](https://help.passbolt.com/api/resource-types),
  [creating a resource](https://www.passbolt.com/docs/development/resources/creating/)
- Bitwarden — [Additional item types (pre-defined), 2018–present](https://community.bitwarden.com/t/additional-item-types-pre-defined/228),
  [notes, cards and identities](https://bitwarden.com/blog/notes-cards-identities-released/)
- 1Password — [Item JSON template](https://developer.1password.com/docs/cli/item-template-json/),
  [Item fields](https://developer.1password.com/docs/cli/item-fields/)
- JSON Forms — [React integration](https://jsonforms.io/docs/integrations/react);
  RJSF — [uiSchema reference](https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/uiSchema/)
- OpenSesame — [ADR 0065](../adr/0065-connector-hook-architecture.md),
  [hooks ecosystem research](hooks-ecosystem.md),
  [ADR 0064](../adr/0064-vault-vfs-keyboard-first.md),
  [ADR 0073](../adr/0073-first-party-vfs-tree.md)
