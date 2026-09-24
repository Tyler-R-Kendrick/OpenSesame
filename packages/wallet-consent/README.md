# @opensesame/wallet-consent

Consent for wallet payments: the canonical payment-approval intent, the
digest over its executable terms, verification that an approval signature
is bound to that digest by an enrolled key, sealing of wallet material under
a wrapping key, and redaction of wallet exports. It records *what a person
approved*. Enforcement and observation belong elsewhere
([ADR 0123](../../docs/adr/0123-wallet-spending-authority.md) §2).

## Where it fits

- **Used by:** [`packages/app-core`](../app-core) — `spending-consent.ts` (through the `/intent` and `/verify` subpaths) and `wallet-agent-broker.ts` (`/redact`); the Pages capability classifier lists it; [`scripts/wallet`](../../scripts/wallet) runs its tests in the protocols and security suites.
- **Builds on:** [`@opensesame/os-domain`](../os-domain).
- Amount and max fee are decimal strings, never floats. Allocation, asset and network, validity window, policy version and effective enforcement are all inside the digest, so none can be swapped after consent. The fields are length-prefixed, the same discipline as the os-domain request digests.
- A signature counts only against a key the verifier was given as enrolled (`trustedKeys`). A proof naming any other key is refused before the signature is checked; caller-written mechanism or assurance strings are never evidence.
- Browser code imports the subpaths. `/verify`, `/wrap`, `/intent` and `/redact` use WebCrypto or nothing; `digest.ts` and `keys.ts` use `node:crypto`, and the root entry re-exports them.

## Surface

| Entry | Exports |
|---|---|
| `@opensesame/wallet-consent/intent` | `PaymentApprovalIntent`, `PAYMENT_APPROVAL_DIGEST_FIELD_ORDER`, `PAYMENT_APPROVAL_DIGEST_VERSION`, `PAYMENT_APPROVAL_DIGEST_PURPOSE`, `paymentApprovalDigestValues` |
| `@opensesame/wallet-consent/digest` | `buildPaymentApprovalDigest` (SHA-256, Node) |
| `@opensesame/wallet-consent/verify` | `verifyDigestBoundApproval` — ES256 over P-256; refusals `digest_mismatch`, `missing_verified_bytes`, `unverified_assurance`, `key_not_enrolled`, `signature_invalid` |
| `@opensesame/wallet-consent/wrap` | `generateWalletWrappingKey`, `sealWalletMaterial`, `openWalletMaterial` — AES-GCM; a parent key cannot open child-sealed material |
| `@opensesame/wallet-consent/redact` | `redactWalletExport`, `walletExportLeaksCanary` |
| `@opensesame/wallet-consent` | All of the above, plus `generatePaymentApprovalKeyPair`, `signPaymentApprovalDigest`, `verifyPaymentApprovalSignature` (fixture and local keys only, Node) |

Bump `PAYMENT_APPROVAL_DIGEST_VERSION` whenever the covered fields change.

## Develop

```bash
pnpm --filter @opensesame/wallet-consent test
pnpm --filter @opensesame/wallet-consent typecheck
pnpm wallet:test:protocols
```

## Related

- [ADR 0123](../../docs/adr/0123-wallet-spending-authority.md) — wallet spending authority
- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — digest-bound approvals
- [Wallet consent baseline](../../docs/implementation/wallet-consent-baseline.md)
- [`scripts/wallet/README.md`](../../scripts/wallet/README.md) — the `pnpm wallet:*` gates
