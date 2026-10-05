# ADR 0173 — Algorithmic passwords by default

- **Status:** Accepted — implemented
- **Date:** 2026-10-05
- **Deciders:** OpenSesame maintainers
- **Amends:** ADR 0172 ([accounts and login methods](0172-accounts-and-login-methods.md)) §3 and §5
- **Supplements:** ADR 0090 ([the static front end is complete without a
  backend](0090-static-frontend-complete-without-backend.md)),
  [ADR 0174](0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)

## Context

ADR 0172 offered a Sphinx-style generator and made random characters the
default. Three things were wrong.

1. **Sphinx is the 2017 construction.** SPHINX (Shirvanian, Jarecki, Krawczyk,
   Saxena) is the paper the field has since standardised around: RFC 9497 (OPRF),
   and OPAQUE (RFC 9807), which builds on it. Its security rests on an OPRF key
   that lives somewhere the attacker does not. In a static, serverless vault
   (ADR 0090) the key lives in the same sealed body as everything else, so what
   we shipped added nothing a hash of a stored secret would not, and a wrong
   master input produced a plausible-looking wrong password.
2. **The default stored a password.** The first example given for a generator
   was an algorithmic one, and the default was a random string the vault keeps.
3. **The form named its techniques.** *A–Z a–z 0–9 Avoid l1IO0 ≈126 bits* is
   not language a person uses, and the list of generators read like a changelog.

## Decision

### 1. The default generator is `derived`, shown as **Algorithmic**

A new password is made by an algorithm and **nothing about the password is
stored**. A method keeps a 32-byte random **root secret**, a **counter** and the
character **rules**; the password is

    HKDF-SHA256(root, "opensesame/derived/v1", counter)   →  a byte stream
    rejection-sample the stream into the rules' pools     →  the password

Rejection sampling reads four bytes a draw and discards the tail that would bias
a modulo, so every character is uniform. The rules are the record `rules` uses
(length, classes, avoid look-alikes, fewest numbers and symbols). Rotating is
bumping the counter: the root stays. The root is the method's salt and key in one
(random per method, so no two accounts share a password); it is the one thing
that makes the password reproducible, and it stays in the sealed body.

`derived` is pure (`vault-core/src/derive.ts`, `character-rules.ts`) and is read
by the native side too (`crates/sealed-store/src/produce.rs`); both run the same
vectors, `spec/conformance/produce-vectors.json`.

### 2. The list names kinds, never techniques

The select reads **Algorithmic**, **Random characters**, **Random words** and
**My own**. The algorithm behind *Algorithmic* may change — a later one is a new
generator id and a new row, not a different word on the screen — so no label
names HKDF, a hash, a curve or a paper (`registry.test.ts` fails on one). A
method made with Sphinx reads **Algorithmic (earlier)**.

### 3. The form is plain and quiet

Plain words: *Capital letters*, *Lowercase letters*, *Numbers*, *Symbols*,
*Avoid look-alike characters* (it says what it means on hover), *Fewest numbers*,
*Fewest symbols*, and a strength word (Excellent, Strong, Fair, Weak) in place of
a bit count. What a person needs is on the form: the generator, one line that says
what it will make, the password, and *Include pepper*. The options open from that
line, a native disclosure.

### 4. Sphinx is retired, not silently broken

`sphinx` is no longer offered. A method that holds one is an older method:
[ADR 0174 §5](0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)
says how it is converted once.

## Consequences

- `vault-core` gains `derive.ts` and `character-rules.ts`; `createItem("account")`
  makes an algorithmic method with no root, and a draft, the method picker and a
  change of generator ask `newSecretFor(generator)` for what a new method keeps.
- The Rust sealed-store reads the same vectors, so the daemon's autofill and
  `opensesame pass show` produce what the app does.

## Tests

`derive.test.ts` (determinism, counter and root dependence, rule obedience,
uniformity, range errors); `produce-vectors.test.ts` and the Rust vector test
(the same outputs on both sides); `registry.test.ts` (labels name kinds, not
techniques); the editor's and the options' component tests (plain words, the
disclosure, the default).
