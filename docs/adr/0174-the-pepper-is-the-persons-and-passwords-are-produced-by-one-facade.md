# ADR 0174 — The pepper is the person's; one facade produces every password

- **Status:** Accepted — implemented
- **Date:** 2026-10-05
- **Deciders:** OpenSesame maintainers
- **Amends:** ADR 0172 ([accounts and login methods](0172-accounts-and-login-methods.md)) §4 and §5
- **Supplements:** [ADR 0173](0173-algorithmic-passwords-by-default.md),
  ADR 0139 ([one definition, every target](0139-one-definition-every-target.md))

## Context

ADR 0172 made *Include pepper* a prompt: the product asked the person for a
pepper, sealed the password under it, and asked again at every use. That is the
reverse of what a pepper is for. A pepper is a secret **the product does not
hold**; the moment the product asks for it, it has seen it, and the moment it
keeps anything sealed under it, it has a verifier for it. Separately, each place
that put a password out (the clipboard, a fill, the terminal, the daemon, the
agent surfaces, health, export) learned its own way to make one, so every new
technique meant edits in each.

## Decision

### 1. A pepper is never asked for and never stored

*Include pepper* says that the password this method produces is **incomplete on
purpose**: the person adds a secret of their own where they use it. The product
keeps one more fact, **where**, as `pepperAt`, and nothing else: no pepper, no
envelope sealed under one, no verifier. There is no prompt, no confirmation field
and no "wrong pepper": nothing here can tell.

### 2. Where the pepper goes is a Python-style index expression

Empty or `end` is after the last character, the default; a new account's
password has *Include pepper* on, at the end, so the person is not asked to choose
either (both sit inside the form's *Options*, ADR 0173 §3). A password typed over,
or one an import brings in, keeps whatever it had: an import has none. `3` puts it before the
character at index 3 (`password[:3] + pepper + password[3:]`); a negative index
counts from the end (`-2` is before the last two). A slice stands in for what it
covers: `2:5`, `:4`, `-3:` (the pepper replaces `password[2:5]`, the first four
characters, the last three), with `[…]` and spaces allowed. Bounds clamp as
Python's do and there is no step. Text that is not a position is not saved, and
one that arrives anyway cuts at the end. The rules are in
`vault-core/src/pepper-position.ts` and `crates/sealed-store/src/produce.rs`, and
the same vectors check both.

### 3. One facade produces every password

`producePassword(method)` in `@opensesame/vault-core` (and `produce_entry` in
`crates/sealed-store`) is the only code that opens a technique. It answers with

- `ok` — the whole password (a stored one, or what an algorithm computes);
- `slotted` — `head` and `tail`, with the person's pepper between them;
- `absent` — nothing is kept;
- `legacy` — made by an older version from a pepper it asked for (§5).

Every runtime asks it and none knows how a password is made:

| Surface | How it uses the answer |
| --- | --- |
| Copy in the app, the command bar, the list | puts out `head`; a second key (`copy rest for …`) puts out `tail` |
| Terminal (`vault copy`, `--field rest`, `pass show`) | the same; `pass show` produces line one of an algorithmic entry |
| Daemon fill and the browser extension | fills `head`, reports `pepper_next`; a `legacy` entry is refused with `legacy_password` |
| Live sessions, duress copies, history | the whole password only; a partial is not shared |
| Health | scores the whole password; a slotted one is *unchecked* |
| Export (CXF, SOPS) | CXF withholds a password it cannot give whole; SOPS keeps the method as it is |

`produce-facade.test.ts` fails if any other production module calls
`deriveCharacters`, `splitAtPepper`, `openWithPepper`, `sphinxPassword` or the
removed `plainPassword`. Creation has one door too: `newSecretFor(generator)`.

### 4. A file holds parameters, never a generated password

A store entry, a SOPS document or a backup that holds an account whose password an
algorithm computes carries **the generator, its rules and counter, and the root**,
and its line one (what `pass show` prints) is **empty**. The file is produced from
and read back into the same method, so it round-trips and a re-import is a no-op.
CXF has no field for the parameters, so an algorithmic password is withheld and
counted rather than written as a generated one. A stored password with a pepper
slot keeps the password on line one and the position in the trailer.

### 5. What an older version sealed is converted once

A method with a seal (v1 or v2 PBKDF2 under a typed pepper) or a Sphinx key cannot
be produced without that input, and a pepper is not asked for now. It is `legacy`:
the editor and the detail page show it as such, with one key, *Convert password*.
That asks once for the earlier pepper (or master input), opens the old value, and
writes it as an ordinary stored password with no seal, no master input and no
pepper. The input is used for that one call and kept by nobody. This is the only
place an earlier pepper is typed, it is human-only (`vault.account.pepper` in the
capability registry), and nothing writes a seal again. A Sphinx input cannot be
checked, so the converted password is shown before it is kept.

## Consequences

- `@serenity-kit/opaque` (an earlier design in this stack sealed the pepper with
  OPAQUE) is not a dependency and no seal is written; the bundle carries none of
  it. A seal under a pepper protects nothing once the product never has the
  pepper.
- `PasswordMethod` gains `pepperAt`; `sealed` is only on a method that has not
  been converted. The golden vectors gain `backup-personal-derived` (a root and
  its parameters, and the same with a pepper slot) and `produce-vectors.json`.
- The extension's `needs_pepper` outcome is gone; `pepper_next` and
  `legacy_password` replace it.

## Tests

`pepper-position.test.ts`, `pepper-position.vectors.test.ts` (which also fails when
the vectors are not what the Python reference writes), `produce.test.ts` and
`produce-vectors.test.ts` (vault-core); `legacy.test.ts` (app-core, the one-time
conversion); `produce.rs` and the daemon's `sealed_tests.rs` (native);
`derived-accounts.test.ts`, `store-sync-account.test.ts` and `produce-facade.test.ts`
(app-core); the CLI's `account-secret.test.ts`; the extension's service, daemon,
guard and popup tests; the editor's and the detail page's tests, including the
conversion.
