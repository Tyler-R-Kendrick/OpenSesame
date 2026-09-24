# @opensesame/wallet-mandates

AP2/UCP mandate codecs, deliberately conservative: sign and verify cart and
payment mandates as ES256 JWTs (`typ: ap2-mandate+jwt`) against a fixture
trust set, plus a local ledger that spends a mandate's amount at most once.
A verified mandate always reports `productionEnabled: false` and
`trust: "fixture-local"`. A signed mandate is authorization evidence, not a
budget engine ([ADR 0123](../../docs/adr/0123-wallet-spending-authority.md)).

## Where it fits

- **Used by:** no workspace package imports it. [`scripts/wallet/blocked-adapters.mjs`](../../scripts/wallet/blocked-adapters.mjs) cites it as the evidence for the fixture-local AP2/UCP entry, and [`docs/reference/wallet-protocol-compatibility.md`](../../docs/reference/wallet-protocol-compatibility.md) records it as `fixture_verified`.
- **Builds on:** [`@opensesame/os-domain`](../os-domain), `jose`. Header decoding uses Node's `Buffer`.
- ES256 only: the header algorithm is checked before the signature. Constraints and `protection: "required"` are critical claims; stripping either is a refusal, not a downgrade.
- No public merchant acceptance and no recursive AP2 subdelegation.

## Surface

| Export | What it does |
|---|---|
| `signMandate(claims, privateKey, kid)` | Compact JWS over `MandateClaims` |
| `verifyMandate({ compact, trust, nowSeconds, expectedAmount, spentJtis })` | `MandateVerifyResult`; refusals `alg_not_es256`, `issuer_untrusted`, `audience_mismatch`, `expired`, `constraint_stripped`, `protection_downgrade`, `amount_mismatch`, `duplicate_jti`, `signature_invalid`, `critical_missing` |
| `LocalMandateLedger(ceiling)` | `fulfill(claims)` refuses a reused `jti` or an amount over the remaining allowance; `getRemaining()` |
| `AP2_LOCAL_PROFILE`, `UCP_AP2_LOCAL_EXTENSION`, `MANDATE_ALG` | Profile identifiers: `ap2-v0.2-es256-local`, `ucp-ap2-mandates-es256-local`, `ES256` |

## Develop

```bash
pnpm --filter @opensesame/wallet-mandates test
pnpm --filter @opensesame/wallet-mandates typecheck
pnpm wallet:evidence:blocked-adapters
```

`src/verify.test.ts` holds the positive and negative fixtures.

## Related

- [ADR 0123](../../docs/adr/0123-wallet-spending-authority.md) — wallet spending authority
- [Wallet protocol compatibility](../../docs/reference/wallet-protocol-compatibility.md) — the support row and its limits
- [`scripts/wallet/README.md`](../../scripts/wallet/README.md) — the `pnpm wallet:*` gates
