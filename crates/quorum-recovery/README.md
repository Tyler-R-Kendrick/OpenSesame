# opensesame-quorum-recovery

The native reader of a trusted-contacts recovery
([ADR 0186](../../docs/adr/0186-trusted-circle-quorum-sharing.md)). A circle's
owner seals a payload in a recovery bundle and gives each guardian one
SLIP-0039 share of the key that opens it, written with an empty passphrase; this
crate recombines the shares and opens the bundle with no browser, no network and
no I/O. `opensesame vault circle recover|inspect` is its command line.

## Where it fits

- **Used by:** [`opensesame-cli`](../../apps/cli) (`src/vault_circle.rs`).
- **Builds on:** no workspace crates. `aes-gcm`, `chacha20poly1305`,
  `ed25519-dalek`, `hkdf`, `hmac`, `pbkdf2`, `sha2`, `x25519-dalek`, `zeroize`.
- **Counterpart:** `packages/app-core/src/lib/quorum/` (TypeScript). The two
  read the same definitions under `spec/` (ADR 0139) and open each other's
  output.

## Surface

| Module | What it is |
|---|---|
| `slip39` | Share decoding (RS1024 checksum, header, padding), `combine` (group and member thresholds, the digest at f(254), passphrase, iteration exponent, extendable flag) and `generate`; GF(256) and PBKDF2 inside. Exactly the threshold of shares is accepted |
| `hpke` | RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256) with HKDF-SHA256 and AES-128-GCM or ChaCha20-Poly1305: key schedule, sequence nonces, exporter, `seal_base` and `open_base`. The key schedule is written out over `hkdf` |
| `canonical` | Canonical JSON (keys sorted by UTF-16 code unit, safe integers only) and the framed `sha256:` digest |
| `policy` | The owner's signed policy: field rules, soundness rules, digest, Ed25519 signature, optional pinned owner key |
| `bundle` | The recovery bundle: HKDF-derived collection key, XChaCha20-Poly1305, associated data naming the digest, circle and epoch |
| `recover` | `match_shares` (each share to the guardian the owner committed it to) and `recover`, with the ceiling `MAX_RECOVERY_EXPONENT` (6) |

Secrets are `Secret` (wiped on drop, `Debug` prints `[REDACTED]`). Errors never
quote a share.

## Verification

```bash
export CARGO_TARGET_DIR=$HOME/.cache/packages/cargo-target
cargo +1.88.0 test -p opensesame-quorum-recovery
scripts/test/quorum-recovery-interop.sh    # TypeScript and this crate, each against the other
```

- `tests/slip39_vectors.rs` runs all 45 official vectors from
  `spec/conformance/slip39/` and checks each invalid one fails for the rule it
  is named for; the wordlist is that file, embedded.
- `tests/hpke_vectors.rs` runs every value of
  `spec/conformance/hpke-rfc9180-vectors.json` (Appendix A.1 and A.2).
- `tests/fixture.rs` opens the committed `spec/conformance/quorum-recovery-fixture.json`
  (test-only keys) made by the TypeScript suite.
- `tests/interop.rs` is the live half of the script above and is `#[ignore]`d
  without `OPENSESAME_QUORUM_INTEROP_DIR`.
- `tests/policy.rs` builds and signs policies natively to pin each rule.
