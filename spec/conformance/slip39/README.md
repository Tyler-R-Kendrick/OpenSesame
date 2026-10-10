# SLIP-0039 conformance data

Vendored, unmodified, for the Shamir's Secret Sharing for Mnemonic Codes
implementation in `packages/app-core/src/lib/quorum/slip39/`
([ADR 0187](../../../docs/adr/0187-trusted-circle-quorum-sharing.md)).

| File | Source | SHA-256 |
|------|--------|---------|
| `vectors.json` | `trezor/python-shamir-mnemonic` `vectors.json` (MIT, © 2019 SatoshiLabs) | `13ebecebdd869dd2bc2cdf69e7ce3a158cf106cac76c39d17682b1c6cdabbdc4` |
| `wordlist.txt` | `trezor/python-shamir-mnemonic` `shamir_mnemonic/wordlist.txt` (MIT, © 2019 SatoshiLabs); byte-identical to `satoshilabs/slips` `slip-0039/wordlist.txt` | `bcc4555340332d169718aed8bf31dd9d5248cb7da6e5d355140ef4f1e601eec3` |

The wordlist was taken from the MIT-licensed repository rather than from the
SLIPs repository, whose text is CC BY-SA 4.0. The standard is
[SLIP-0039](https://github.com/satoshilabs/slips/blob/master/slip-0039.md)
(Final).

`vectors.json` is a list of `[description, mnemonics, master secret hex,
BIP-32 xprv]` quadruples. The passphrase for every valid set is `TREZOR`. An
empty master secret means combining the mnemonics must fail. Never edit either
file, and never regenerate one to make a reader pass.

## Readers and the fixture built on them

Two readers consume these files, each from this one copy (ADR 0139): the
TypeScript module above, which embeds a copy of the wordlist and fails a test
if it differs from `wordlist.txt`, and the native crate `crates/quorum-recovery`
(`src/slip39/`), which reads `wordlist.txt` itself with `include_str!` and runs
`vectors.json` in `tests/slip39_vectors.rs`.

`../quorum-recovery-fixture.json` is not vendored: it is a small circle made
for this repository by `packages/app-core/src/lib/quorum/recovery-fixture.test.ts`
(a signed policy, the recovery bundle, every guardian's share and the payload).
Every key and share in it is generated for the fixture and protects nothing
(test-only keys). The TypeScript suite and `crates/quorum-recovery/tests/fixture.rs`
both open it; `UPDATE_QUORUM_RECOVERY_FIXTURE=1` rewrites it (then
`pnpm exec biome format --write` on the file), and only a deliberate change to
the bundle format should.
