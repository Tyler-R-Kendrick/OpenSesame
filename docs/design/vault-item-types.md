# Writing a vault item type

A vault item type is a JSON file. It is not code, it is not compiled, and
installing one does not rebuild anything — paste it into **Settings → Vault
data → Item types** and the type exists, on this device and on every other
device this vault syncs to.

The decision behind this is [ADR 0087](../adr/0087-vault-item-type-plugins.md);
the prior art it is drawn from is in
[docs/research/vault-item-types.md](../research/vault-item-types.md). This page
is the authoring guide.

## The shortest useful definition

```json
{
  "apiVersion": "opensesame.dev/v1alpha1",
  "kind": "VaultItemType",
  "metadata": {
    "id": "resident-id",
    "version": "1.0.0",
    "publisher": "https://your-domain.example"
  },
  "spec": {
    "title": "Resident ID",
    "plural": "Resident IDs",
    "extension": ".rid",
    "summary": "A national residence permit.",
    "categories": ["identity"],
    "sections": [
      {
        "id": "card",
        "title": "Card",
        "fields": [
          { "id": "country", "type": "country", "label": "Country", "required": true },
          { "id": "permitNumber", "type": "concealed", "label": "Permit number" },
          { "id": "expiresAt", "type": "date", "label": "Expires" }
        ]
      }
    ],
    "native": {
      "secret": "permitNumber",
      "trailer": [
        { "key": "country", "field": "country" },
        { "key": "expires_at", "field": "expiresAt" }
      ]
    },
    "cxf": { "credential": "identity-document" },
    "subtitle": ["country", "expiresAt"],
    "search": ["country"]
  }
}
```

That is the whole thing. It draws its own editor, its own detail view, its own
list subtitle, its own filename in the VFS tree, and it reads back through
`opensesame pass` as:

```
Z1234567
country: NL
expires_at: 2030-01-01
```

## The parts

### `metadata`

| Field | Rule |
|-------|------|
| `id` | Lowercase slug, 2–48 characters. Must not be a built-in id. |
| `version` | `MAJOR.MINOR.PATCH`. An install of a lower version than the one already there is refused. |
| `publisher` | An `https://` URL you control. Identity is `publisher + id`: nobody else can take over your id later. |

### `spec.sections[].fields[]`

A field names a type from the catalogue; it never describes one.

| Key | Meaning |
|-----|---------|
| `id` | Stable identifier, `[A-Za-z][A-Za-z0-9_]*`. Values are keyed by it, so renaming one is a data change. |
| `type` | A catalogue entry (below). |
| `label` | What the person reads. Change it freely — it is presentation. |
| `help` | One line under the input. |
| `required` | Marks the field with `*`; a blank one is reported on save. |
| `placeholder` | Ghost text. |
| `options` | `select` only, 1–32 unique values. Required on `select`, refused anywhere else. |
| `multiple` | Scalar shapes only — the field becomes a list with add/remove. |
| `default` | Prefilled on a new item. **Refused on any concealed type.** |

### The field-type catalogue

*Plain* — `string`, `multiline`, `email`, `url`, `number`, `boolean`, `date`,
`month-year`, `country`, `select`, `phone`.

*Concealed* — `concealed`, `password`, `pin`, `key-material`, `totp`. These
never render without a reveal gesture, anywhere.

*Structured* (a fixed set of named parts) —

| Type | Parts |
|------|-------|
| `address` | street1, street2, city, state, postalCode, country |
| `person-name` | first, middle, last |
| `host-port` | host, port |
| `security-question` | question, **answer** |
| `payment-card` | **number**, expiry, **code** |
| `key-pair` | publicKey, **privateKey** |

Bold parts are concealed, which makes the whole field concealed.

The catalogue is closed on purpose. A type that could describe its own
rendering or its own validation would be code, and the whole point of a
definition being inert is that installing one cannot introduce behaviour.
If you need a field type that is not here, that is a change to OpenSesame —
open an issue; it is a small one.

### `spec.native` — the base secret projection

Every type declares how it lands on `sealed_store::Entry`, which is line one
plus a `key: value` trailer. That is what makes a community type readable by
`opensesame pass`, the KeePassXC and browserpass bridges, and ConnectionRef
materialisation, with no host-side plugin.

- `secret` — the one field that becomes line one, or `null` for a type with
  no single secret (a contact, an address). It must be a scalar and must not
  repeat: line one holds one value.
- `trailer` — ordered `{ key, field }` pairs. Keys are lowercase slugs and
  must be unique; the secret field cannot appear again here.

A repeating field emits one line per value under the same key. A structured
field emits `key.part: value` per non-empty part. A `totp` field holding an
`otpauth://` URI is written bare, because that is where `pass-otp` looks for
it. Values containing newlines are escaped (`\n`), so a field can hold a
paragraph without breaking the file.

Round-tripping is total in both directions, and trailer keys your definition
does not claim survive a read.

### `spec.cxf` — interchange

Name the FIDO Credential Exchange Format credential your type is closest to:
`basic-auth`, `passkey`, `totp`, `credit-card`, `note`, `ssh-key`, `api-key`,
`wifi`, `address`, `person-name`, `identity-document`, `drivers-license`,
`passport`, `file`, or `custom-fields`.

`custom-fields` is the floor and always available — CXF defines it precisely
for what the standard did not anticipate — so there is no such thing as a
community type that cannot be exported.

### `spec.subtitle` and `spec.search`

Field ids that appear in the item list and the search index. **A concealed
field named here is refused**, not filtered: the item list and the VFS
filename render with no reveal gesture, and a definition that quietly failed
to show what its author asked for would be worse than one that said so.

## What a definition may never do

Each of these is a parse-time refusal with a message naming the path:

- carry a value (`default` on a concealed field);
- put a concealed field in `subtitle` or `search`;
- name a ceremony `handler` — those belong to the platform, for the four
  built-ins that call the Host API (certificate issuance, drop claims, passkey
  custody, grant ceilings);
- redefine a built-in id, or take over an id another publisher installed;
- carry any key the schema does not define — unknown fields are refused
  rather than ignored, at every level;
- exceed 64 KiB, 16 sections, 64 fields, or 32 options.

There is no field in the schema that can hold a URL, so nothing here can be
made to fetch anything.

## Removing a type

Uninstalling never touches items. Items of that type keep every value they
hold and render with all values concealed — this device cannot tell which of
them the definition meant to hide — until the definition comes back. That is
also exactly what a device sees when a definition has not synced to it yet.

## Testing a definition

```bash
# The client-plane parser and the host-plane parser share one corpus and one
# rejection table, so either of these tells you the same thing.
pnpm --filter @opensesame/vault-item-types test
cargo +1.88.0 test -p opensesame-vault-item-types
```

To ship a type as a first-party one, drop the file in
`packages/vault-item-types/definitions/`, run
`pnpm --filter @opensesame/vault-item-types generate`, and the corpus tests
pick it up in both languages. That is the same file you would have pasted into
Settings — there is no first-party path a community author cannot take.
