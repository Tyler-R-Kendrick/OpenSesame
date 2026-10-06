# ADR 0172 — Accounts own login methods; a password is one of them

- **Status:** Accepted — implementing; §3–§6 amended by [ADR 0173](0173-algorithmic-passwords-by-default.md) and [ADR 0174](0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md); §2 amended by [ADR 0178](0178-credentials-are-entries-bound-to-accounts.md)
- **Date:** 2026-10-05
- **Deciders:** OpenSesame maintainers
- **Supplements:** ADR 0087 ([vault item types are plugins](0087-vault-item-type-plugins.md)),
  ADR 0100 ([generated vault drafts](0100-vault-draft-generation.md)),
  ADR 0133 ([shared app core and vault kernel](0133-shared-app-core.md)),
  ADR 0158 ([Settings rows act or are absent](0158-settings-rows-act-or-are-absent.md))

## Context

The vault's `login` item was a username, a password and an authenticator seed.
That is one login method (basic auth) with a TOTP beside it, drawn as if it were
the only way into a site. People hold accounts that open with an API key, a
bearer token, an OAuth client, a password they want to keep out of the vault's
reach, or a password that is never stored at all. The generator was a popover on
the password field offering random characters and a passphrase, and nothing
could ask the person for anything when a password was used.

## Decision

### 1. `login` becomes `account`

An **account** is a username or id (`username`), the sites it lives at (`uris`),
and an ordered list of **login methods** (`methods`). Item kind `account`,
extension `.account`, type id `account`, label "Account". A vault written
before this ADR still holds `login` items; they are read and **normalized to
accounts on open** (`normalizeLegacyItems` in `vault-core`), never written back
as `login`. Normalization is idempotent and derives method ids from the item id
(`<id>:password`, `<id>:authenticator`), so two devices that migrate the same
login converge and a merge sees no difference. Older clients do not understand
`account`; the format is alpha and this is accepted.

`/vault/new/login` and `.login` keep resolving to the account type so links and
paths already handed out still work.

### 2. Login methods

`password`, `api-key`, `token`, `oauth`, `authenticator`. Each is a closed
record in `packages/vault-core/src/account.ts`; an account may hold several of
a type. The editor adds a method from a picker and removes it with an icon key.
The old top-level `totp` is the first `authenticator` method.

### 3. Password generators

A password method names its **generator**:

| id           | What it does                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `rules`      | Random characters under rules: length, classes, avoid ambiguous, Bitwarden-style minimum digits and symbols. |
| `passphrase` | Random words from the bundled list, with separator, capitalisation and an optional number.      |
| `sphinx`     | Recomputed at every use from a master input and a key; never stored. See §5.                    |
| `manual`     | Typed by the person.                                                                           |

Generators are a registry (`packages/app-core/src/lib/vault/generators/`), one
module per id behind one interface, so a later generator adds a module and a
row, not a branch. Randomness is `crypto.getRandomValues` with rejection
sampling, as in `password.ts`.

### 4. Include pepper

A password method has a boolean **include pepper**. When it is set the person
is **asked for the pepper each time the password is used** (revealed, copied,
filled, exported), and the pepper is never stored.

For `rules`, `passphrase` and `manual` the generated or typed password is
**sealed under the pepper** (`vault-core/src/pepper-seal.ts`): PBKDF2-SHA256 at
the vault's iteration floor stretches the pepper into an AES-GCM key, bound to
`pepperBinding(accountId, methodId)`. The method keeps `secret: ""` and the
`sealed` envelope. A wrong pepper fails closed with `WrongPepperError`; a seal
moved to another method fails the same way. So a body that is unlocked, read by
malware, or exported without the pepper still holds no password.

Any consumer that cannot prompt (health, bulk export, a list, SOPS) reads
`accountPlainPassword`, which is `""` for a peppered password, and treats it as
absent. It never guesses and never falls back to the sealed form.

### 5. Sphinx, on RFC 9497

SPHINX (Shirvanian, Jarecki, Krawczyk, Saxena, 2017) derives a site password
from a master password and a device-held key through an oblivious PRF, so the
device never sees the master password and a stolen device alone yields nothing.
The standard that replaces its bespoke construction is **RFC 9497 (OPRF)**; we
use the `ristretto255-SHA512` suite of `@noble/curves` (`ristretto255_oprf`),
the audited, constant-time implementation already in the workspace, and write
no protocol code of our own (the AGENTS.md "mature libraries over NIH" rule).

- The `sphinx` generator stores `oprfKeyB64` (the server scalar `k`), a frozen
  `realm`, a `counter` and the output `rules`. It stores no password.
- Use: the person types the **master input** (it is the pepper; `pepper` is
  always true for `sphinx`, so the control is absent rather than disabled). The
  client blinds `canonical(master, realm, username, counter)`, an
  `OprfEvaluator` returns the blinded evaluation, the client unblinds and
  finalizes to 64 bytes, and those are encoded into the password by HKDF-expand
  and rejection sampling into the rule's character pools with one of each
  selected class.
- The evaluator is a port. The first implementation holds `k` in the sealed
  vault body. That is stated plainly: it protects against an attacker who has
  the vault but not the master input, and against a site breach, but an
  attacker who unlocks the vault and also learns the master input derives the
  password. A Host- or device-held evaluator is the follow-up that makes the
  second share separate; the port exists so it changes nothing else.
- A wrong master input yields a different, valid-looking password. SPHINX has no
  verifier by design, and we add none: a verifier would be an offline guessing
  oracle against the master input.
- `counter` rotates the password without changing the master input.

### 6. What a person sees

The account editor is the existing item editor: a **Username / ID** field,
**Websites**, and one block per method. A **+** (the existing add key) opens the
method picker. A password method has a generator select (native, ADR 0158 and
`docs/design/controls.md`), the generator's own options inline, the regenerate
and reveal icon keys, and an **Include pepper** check that is drawn for every
generator but `sphinx`. A control whose precondition is unmet is absent. There
is no explainer prose and no in-page error box; a wrong pepper is a
`StatusMark` on the method row and a tray notice.

Asking for a pepper is one component, `PepperPrompt`, a modal that takes focus,
returns it, and is reached by keyboard alone. It is the only place the pepper
is typed and it is cleared on close.

## Consequences

- `vault-core` gains `account.ts` and `pepper-seal.ts`; `LoginItem` is gone from
  `VaultItem`. Every reader of `kind === "login"` moves to `account`, and every
  reader of `.password` / `.totp` moves to the helpers (`accountPlainPassword`,
  `accountTotp`) or to a prompt.
- The Rust reader (`crates/human-vault` `pages_vault`) lists `account` as
  `.account` and still lists `login` for vaults not yet opened by Pages. The
  golden vectors keep their legacy `login` vectors untouched and gain new
  `account` vectors.
- A peppered or sphinx password cannot be exported to CXF, KDBX or Bitwarden JSON
  without the person supplying the pepper; the exporter omits it and counts it.
- `@noble/curves` becomes a direct dependency of `@opensesame/app-core`.
- Importers produce accounts with a manual password method.

## Tests

Migration is idempotent and merge-stable; the pepper seal opens only with its
pepper and binding; the OPRF generator matches RFC 9497 test vectors for the
suite and is deterministic for a fixed master, key and counter and different
for any change of either; every generator is statistically unbiased and obeys
its rules; the editor draws a block per method, hides *Include pepper* for
`sphinx`, and a pepper prompt opens, is typed into by keyboard, and clears;
the legacy `login` golden vectors still open.
