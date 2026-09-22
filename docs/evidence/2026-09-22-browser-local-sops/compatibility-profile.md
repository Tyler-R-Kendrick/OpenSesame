# Compatibility profile

The exact, bounded claim this work makes about SOPS interoperability.

`docs/security/sops-wire-compatibility.md` is the reference — the byte-level
rules, the Go behaviours reproduced, and the refusals. This file states the
*claim*, its limits, and what was actually executed to support it.

## The claim

> With SOPS **v3.13.3** (source commit `26e2f4784ca61353082c32dbd987c25eda086dc9`)
> and local **age X25519** identities, YAML and JSON documents encrypted by
> the browser open in upstream `sops`, documents encrypted by upstream
> `sops` open in the browser, an upstream document edited in the browser
> still opens upstream with the edit and its policy intact, and a browser
> document edited upstream with `--set` still opens in the browser.

That sentence is the whole claim. Everything below narrows it.

## What was executed

Against the pinned binary, whose SHA-256 is verified before it is run:

| Direction | Cases | Result |
| --- | --- | --- |
| browser → upstream | 17 fixtures × both formats | pass |
| upstream → browser | 17 fixtures, tree-compared | pass |
| upstream file, browser edit, upstream read | SB-004 | pass |
| browser file, upstream `--set`, browser read | SB-005 | pass |
| 2-of-3 threshold, both directions, and refusal with one group | SB-037/039 | pass |
| timestamps, `mac_only_encrypted`, every selector | SB-012/026/045 | pass |
| a deliberately broken MAC, rejected by upstream | SB-080 | pass |

Plus 74 YAML documents parsed and compared against dumps from upstream's
**own loader**, which is how the scalar-resolution rules (base-0 integers,
timestamp layouts, uint64 refusal) are held to Go's behaviour rather than
to JavaScript's.

39 conformance tests in total. Reproduce with `pnpm verify:sops-conformance`.

## In profile

- **Formats:** YAML, JSON.
- **Key sources:** local age X25519 identities, typed for the operation or
  sealed in the unlocked vault.
- **Key groups:** one group (OR of its master keys), several groups (Shamir
  threshold over distinct groups, upstream's default being all groups).
- **Selectors:** `encrypted_suffix`, `unencrypted_suffix`,
  `encrypted_regex`, `unencrypted_regex`, `encrypted_comment_regex`,
  `unencrypted_comment_regex`, `mac_only_encrypted`.
- **`.sops.yaml`:** creation rules, read as configuration only.

## Out of profile — refused, not guessed

`dotenv`, `ini` and `binary` formats. GPG/PGP, HashiCorp Vault and PKCS#11
master keys. age plugins and passphrase recipients. Key services,
`exec-env`/`exec-file`, publish, and `--set` path syntax. YAML aliases,
anchors and merge keys. Non-string mapping keys. Duplicate keys. Unknown
tags. Sequence or scalar document roots. RE2 features outside the
implemented subset.

Each is an error that names the unsupported feature. The engine does not
reinterpret, approximate, or drop.

## Cloud KMS: a wire contract, not a compatibility claim

AWS KMS, Azure Key Vault and GCP KMS adapters implement upstream's request
and response encodings, and are unit-tested against them. They are **not**
claimed to work against any particular account, tenancy, region, network or
CORS configuration. `pnpm verify:sops-cloud-live` exists for that and is
optional; with no disposable resource supplied it reports
**blocked-external** for SB-053, SB-054, SB-055 and SB-058 — four cases
that are unproven here and are reported as unproven.

## What this profile does not say

- It does **not** say "full SOPS parity". A large part of SOPS is out of
  profile above.
- It does **not** cover a SOPS release other than v3.13.3. Upstream can
  change its format; the pin makes that a visible failure rather than a
  silent incompatibility, but a newer release is untested here until the
  pin moves.
- It does **not** cover every browser. The gates run headless Chromium. The
  engine uses WebCrypto, module workers, and standard JavaScript, so other
  modern engines are expected to work — expected, not demonstrated.
- It does **not** say the implementation is secure or audited. See
  `security-review.md` for what was and was not examined.
