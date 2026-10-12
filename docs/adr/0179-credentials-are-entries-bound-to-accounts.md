# ADR 0179 — Credentials are entries of their own, bound to an account by reference

- **Status:** Accepted — implemented
- **Date:** 2026-10-06
- **Deciders:** OpenSesame maintainers
- **Supplements:** ADR 0172 ([accounts and login methods](0172-accounts-and-login-methods.md)),
  ADR 0165 ([item types as packs](0165-item-type-packs-on-demand.md)),
  ADR 0174 ([passwords through one facade](0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)),
  ADR 0158 ([Settings rows act or are absent](0158-settings-rows-act-or-are-absent.md))

## Context

ADR 0172 kept an account's login methods inside the account. A person could not
generate a password and keep it for nothing in particular, could not see an API
key as an entry of its own, and the editor offered every method type whether or
not the vault had that type switched on. Each credential type already had its
own meaning in the vault's vocabulary (an API key, a token), but none had its
own row, its own detail page or its own switch in Settings › Vaults › Item
types.

## Decision

### 1. A credential is an item

`password`, `api-key`, `token`, `oauth-client` and `authenticator` are item
types, each a manifest in `marketplace/item-types/builtin/` and a pack (ADR
0165). An item of one is a **credential**: kind `credential`, `method` (the same
login method record ADR 0172 defined), `accountId` (the account it opens, or
`null`), and `order`. `method.id` is the item's id, so a method keeps the id it
always had.

### 2. Binding is by reference

A credential bound to an account is that account's login method. `accountId`
is the only binding. A credential with `accountId: null` is a password, key or
token kept on its own: generated, stored, copied and health-checked like any
other, never mapped to an account. Binding and releasing are writes to the
credential (Account on its editor), never a move: its values, name and folder
are untouched.

**Amended 2026-10-07: a password's form names no account.** One password may
open many accounts, so the Password editor (new or edit) draws no Account row
and never writes `accountId`; a password already bound keeps its binding when
it is saved. The Account row stays on the other credential types, which are
still one-to-one. `accountId` itself is single-valued, so a password still cannot
be bound to a second account from the account side; lifting that is a change to
the binding model (a reference held by the account, not an owner held by the
credential) and is not made here.

### 3. The account is a view

`AccountItem.methods` stays as the shape every reader knows, but a sealed body
never holds one inside an account. `resolveAccounts` fills `methods` from the
credentials bound to the account when the store hands items to a surface;
`splitAccount` turns an account written with methods back into credentials.
`state.items` is resolved. `rawItems()` is the body as sealed. A body that still
carries methods inside an account (written before this ADR, or by another
device) is normalized on open, on merge and on every write
(`extractEmbeddedMethods`): idempotent, the credential taking the method's id,
the account's times and folder.

### 4. Gating

A method type may be added to an account, and a credential created, only while
its type is switched on (`isPackOn`). The `+` beside *Login methods* offers
exactly those, and is absent when there are none. A type an open vault holds
items of is on by being held (ADR 0165 §watch), so an account never loses the
form of what it already has. **Accounts needs Password**: switching the account
type on switches Password on with it, and Password cannot be switched off while
Accounts is on (`PACK_REQUIRES`, shown as a held row, ADR 0158).

### 5. Lifecycle

- Removing a method from an account in the editor **trashes** the credential.
  It keeps its `accountId`, so restoring it puts it back in the account at its
  place.
- Trashing an account trashes its credentials at the same instant; restoring the
  account restores those that went with it and not one removed earlier.
- Purging an account purges its credentials (each gets a tombstone). A merge
  drops a credential whose account was purged elsewhere unless it was changed
  after the purge; a credential whose account is gone, trashed or purged, reads
  as unbound and nothing is rewritten to say so.
- Renaming an account renames the credentials named after it ("Billing · API
  key"); a name a person gave a credential is theirs (`named`).
- A credential id a file chose is only unique within its account. A method whose
  id another item holds, a note or another account's credential, is kept under an
  id scoped to its account and never overwrites that item (`homed`).
- A password an earlier pepper sealed (ADR 0172 §4) was sealed to the account it
  is on and may not change accounts until it is converted.

### 6. Where an account's credentials are *not* listed

A credential bound to an account is part of that account's file. A vault file's
listing (`opensesame-id vault ls`, `opensesame vault ls`), the sealed-store
manifest (an account's entry carries `values.methods`), the CXF export (the
account's credentials) and a SOPS export (the account's methods) do not list it
a second time. A credential kept on its own, or whose account is not in the
body, is listed under its type's extension; its sealed-store entry has
`kind: "credential"` and `values.method`, and `produce_entry` produces a
password from it as it does from an account's.

### 7. Everywhere else

- **Health** and **security checks** score a password kept on its own beside the
  accounts'; a reused password is reused whichever holds it.
- **Password history** follows the password: a bound credential in its account's
  scope, one kept on its own in its own.
- **Copy** asks the one question an account does of the one method a credential
  holds (`Copy password`, `API key` / `API key as header`).
- **Travel** (ADR 0171) hides an account with the credentials bound to it, from
  the body as sealed. **Duress** (ADR 0168) never copies a credential into a
  decoy; an account copied has its password and no more.
- **WebMCP** projects a credential as metadata only (`typeId`, `bound`).

## Consequences

- Seven readers learned that an account's methods are a view: the store, the
  sealed-store codec, the CXF and SOPS exports, health, password history and
  the travel and decoy paths. Each reads `resolveAccounts` or asks for
  `outsideAccounts`.
- Pack counts: 23 built-in packs beyond the embedded five.
- A vault written by this version cannot be read as accounts-with-methods by an
  older one. The format is alpha, as ADR 0172 accepted.

## Tests

`packages/vault-core/src/credential.test.ts` (split, extract, bind, collisions,
merge), `packages/app-core/src/lib/vault/store-credentials.test.ts` (the store,
end to end), `apps/pages/src/sections/vault/CredentialEditor.test.tsx`,
`CredentialDetail.test.tsx`, `vault-menu.credentials.test.ts`, the
`backup-personal-credentials` golden vector read by TypeScript and Rust, and
`crates/sealed-store` `produce_tests.rs`.
