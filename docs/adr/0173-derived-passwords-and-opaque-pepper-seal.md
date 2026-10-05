# ADR 0173 — Derived passwords by default; the pepper is held by OPAQUE

- **Status:** Accepted — implemented
- **Date:** 2026-10-05
- **Deciders:** OpenSesame maintainers
- **Amends:** ADR 0172 ([accounts and login methods](0172-accounts-and-login-methods.md)) §3–§6
- **Supplements:** ADR 0090 ([the static front end is complete without a
  backend](0090-static-frontend-complete-without-backend.md)), ADR 0149
  ([nothing stored in the clear](0149-nothing-stored-in-the-clear.md))

## Context

ADR 0172 offered a Sphinx-style generator and made the random-characters
generator the default. Three things were wrong with that.

1. **Sphinx is the 2017 construction.** SPHINX (Shirvanian, Jarecki, Krawczyk,
   Saxena) is the paper the field has since standardised around. Its
   lineage runs through the CFRG's OPRF (RFC 9497) to **OPAQUE, RFC 9807**
   (an augmented PAKE built on that OPRF, with a memory-hard key-stretching
   function and an export key), and through threshold OPRFs for the case where
   the key is not held by one party. We shipped the paper, not the standard.
2. **The Sphinx we shipped did not earn its place.** Its security rests on the
   OPRF key living somewhere the attacker does not. In a static, serverless
   vault (ADR 0090) the key lives in the same sealed body as everything else, so
   the generator offered nothing a hash of a stored secret would not, and a
   wrong master input produced a plausible-looking wrong password.
3. **The pepper flag was missing from the generation form.** The person asked
   for *Include pepper* on the password generation form. ADR 0172 drew it
   for stored generators and not for Sphinx, so the one generator the person
   named had no flag.

The default was also `rules`, a random string the vault stores. The person's
first example was an algorithmic generator.

## Research

- **RFC 9497** (OPRF, ristretto255-SHA512) is what ADR 0172 §5 used. It is the
  primitive; it is not a way to hold a secret by itself.
- **RFC 9807** (OPAQUE) is the standard that replaces SPHINX-style password
  hardening for new work. The client's password never reaches the server; a
  wrong password fails the login before anything is decrypted; the client
  recovers an **export key** only it can recompute. The password-hardening
  step is a configurable key-stretching function (Argon2id here).
- **`@serenity-kit/opaque`** (the `opaque-ke` Rust crate compiled to
  WebAssembly, with the WebAssembly inlined so it needs no extra request) is the
  implementation. We write no protocol code.
- **Threshold and Host-held OPRF** (the "server" half held by someone else) is
  the configuration in which OPAQUE or SPHINX protects against a stolen vault.
  It needs a second holder, which a static page by ADR 0090 does not have.

## Decision

### 1. The default generator is `derived`

A new generator, **derived**, is the default for every new password method.
Nothing about the password is stored. A method keeps a 32-byte random **root
secret**, a **counter** and the character **rules**; the password is

    HKDF-SHA256(root, "opensesame/derived/v1", counter)   →  a byte stream
    rejection-sample the stream into the rules' pools     →  the password

Rejection sampling over the stream reads four bytes a draw and discards the
tail that would bias a modulo, so every character is uniform. The rules are the
same record `rules` uses (length, classes, avoid ambiguous, minimum digits and
symbols). Rotating the password is bumping the counter: the root, and
everything sealed under the pepper, stays put.

`derived` is a pure function in `vault-core` (`derive.ts`, `character-rules.ts`)
shared by both planes' readers and covered by golden vectors
(`spec/conformance/vault-vectors.json`, `backup-personal-derived`).

### 2. *Include pepper* is on the generation form for every offered generator

The offered generators are `derived`, `rules`, `passphrase` and `manual`. Each
shows **Include pepper**. For `derived` the thing sealed under the pepper is the
**root**, so a person who turns the pepper on keeps the same password: the
root is sealed, the clear copy is dropped, and the counter and rules stay in
the body. Turning it off asks for the pepper once and writes the root back in
the clear. A pepper is typed at each use of the password and never stored.

### 3. The pepper seal is OPAQUE (`PepperSealV2`)

A secret held under a pepper is registered with OPAQUE (RFC 9807, ristretto255,
**Argon2id** as the key-stretching function at 64 MiB, three passes, one lane;
RFC 9807's own 2 GiB recommendation does not fit a browser tab). The pepper is
the OPAQUE password; the **export key** becomes an AES-256-GCM key (HKDF, with
`pepperBinding(accountId, methodId)` as its context and as the cipher's
additional data)
that holds the secret. Opening runs the OPAQUE login, so:

- a wrong pepper is **detected before any decryption** (`WrongPepperError`),
  not by a failed tag;
- the pepper is stretched with a memory-hard function instead of PBKDF2
  (v1), which makes an offline guess against a copied vault cost memory as well
  as time;
- a seal moved to another account or method does not open.

Version 1 seals (ADR 0172) still open and are read as before; **every write is
version 2**. A v1 seal is replaced the next time that method is stored.

**What this does and does not give.** The OPAQUE "server" half
(`serverSetup`, `registrationRecord`) sits beside the ciphertext in the vault
body, because a static page has no other holder (ADR 0090). So the pepper
protects a body that is exposed **without** the pepper, and the guess cost is
Argon2id's; it does not make the vault safe against an attacker who holds the
body and can run guesses against it for as long as they like at that cost. It
is not a second holder, and nothing in the product calls it one. A deployment
that wants one holds the OPAQUE server half on a Host, which is a Host feature
and not part of this ADR; the seal format already separates the two halves, so
that move changes where `serverSetup` is read from and nothing else.

### 4. Sphinx is retired, not removed

`sphinx` is no longer offered. A method already holding it **still reads**: it
asks for the master input and computes the same password as before, a method
moved to another generator keeps its place and loses nothing else, and the
registry's `offeredGenerators` is the one list the editor draws from. Its
OPRF key stays in the sealed body, and the support agent's egress terms refuse
`oprf`, `serverSetup` and `registrationRecord` as they refuse a password.

## Consequences

- `vault-core` gains `derive.ts`, `character-rules.ts` and `PepperSealV2` in
  `account.ts`; `app-core` gains `generators/opaque-seal.ts`, which loads the
  WebAssembly library with a dynamic `import()` on first use.
- The bootstrap does not load OPAQUE. The age-encryption adapters moved to a
  single lazy door in the same stack (`lib/age-lib.ts`), which more than pays for
  the new chunk: the hardened `largestAsset` budget fell from 798 to 673 KB there,
  and the budgets for the default build were raised deliberately here by the size
  of the OPAQUE chunk, which is only fetched when a pepper is set or opened.
- Exporters (CXF, KDBX, Bitwarden JSON) write the **computed** password of a
  derived method with no pepper and withhold one that needs a pepper; they never
  write the root. `mergeAccounts` compares the computed password, so the same
  root and counter is a duplicate and a different counter is a conflict. A
  first-format entry laid over an account leaves a derived root alone. A live
  session refuses to write a password a derived method computes
  (`reason: "computed"`); a password typed in the terminal replaces the method
  with a typed one, as it replaces any other generator.
- Tests that exercise the pepper write seals at a cheap cost
  (`writeSealsWith("fast")` in the shared test setup); the app never does, and a
  test asserts that a cheap seal does not open as a standard one.
- The Rust reader lists `derived` vault bodies unchanged; its vectors check the
  clear root, the counter and rules, and the v2 seal's shape, and print none
  of it.

## Tests

`derive.test.ts` (determinism, counter and root dependence, rule obedience,
uniformity, range errors); `opaque-seal.test.ts` (round trip, wrong pepper,
binding, tamper, key stretching applied); `pepper.test.ts` and
`registry.test.ts` (v1 and v2 open, toggling the pepper keeps a derived
password, Sphinx still reads); `derived-accounts.test.ts` (health, export,
merge, field write, graft, the prompted reader); the editor's component tests
(Include pepper under every offered generator, rotate by counter); the golden
`backup-personal-derived` vector in TypeScript and Rust.
