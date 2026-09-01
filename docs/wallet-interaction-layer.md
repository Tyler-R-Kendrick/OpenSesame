# The wallet-native interaction layer

How OpenSesame hands a question to a second screen — and why a Google Wallet
pass, a QR code, a phone notification and a CLI link are all the same thing
wearing different clothes.

Design decision: [ADR 0086](adr/0086-wallet-native-interaction-layer.md).
Threat surface: [threat model](security/threat-model.md#cross-device-interaction-layer-adr-0083).

## The one-sentence version

An **interaction** is a question waiting on another device. A **reference** is
its public name. Holding a reference authorizes nothing; answering the question
costs an authenticated approver and a cryptographic proof bound to the exact
operation.

Everything else here is a consequence of that.

## The shape

```
                    ┌──────────────────────────────┐
                    │   Ceremony (already exists)  │
                    │  device auth · claim ·       │
                    │  authorization request       │
                    └──────────────┬───────────────┘
                                   │  fronted by, never replaced by
                                   ▼
                    ┌──────────────────────────────┐
                    │        Interaction           │
                    │  one state machine           │
                    │  one expiry rule             │
                    │  one request digest          │
                    └──────────────┬───────────────┘
                                   │  addressed by
                                   ▼
                     i_<random-id>.<mac>   ──►   https://host/i/<ref>
                                   │
            ┌──────────────┬───────┴────────┬───────────────┐
            ▼              ▼                ▼               ▼
      Google Wallet    PWA / mobile     Browser / QR      CLI link
            └──────────────┴───────┬────────┴───────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │  authenticate the approver   │
                    │  show the exact operation    │
                    │  WebAuthn  or  OpenID4VP     │
                    └──────────────┬───────────────┘
                                   ▼
                       proof.boundDigest == requestDigest
                                   ▼
                          ApprovalProof → receipt
                                   ▼
                    existing policy / grant enforcement
```

The wallet is at the top of one branch, not at the centre. Removing that
branch removes a convenience.

## Vocabulary

| Term | What it is | Where |
|------|-----------|-------|
| `Interaction` | The envelope. Six kinds, eight statuses, one machine. | `packages/os-domain/src/interaction.ts` |
| `InteractionSubject` | Which underlying ceremony it fronts. | same |
| reference | `i_<base64url-id>.<mac>` — public, unguessable, MAC-bound. | `crypto/interaction-ref.ts` |
| `requestDigest` | Canonical hash of exactly what is being consented to. | `crypto/request-digest.ts` |
| `ApprovalProof` | A verified approval reduced to what is safe to keep. | `interaction.ts` |
| `WalletPassProvider` | The vendor-neutral pass boundary. | `packages/wallet` |

Note the naming hazard: `/interaction` (singular, unversioned) is the
oidc-provider login/consent surface and is unrelated. This layer is
`/v1/interactions` and `/i/<ref>`.

## Statuses

```
pending ──► presented ──► awaiting_approval ──► approved ──► consumed
   │            │                │                  │
   └────────────┴────────────────┴──────────────────┴──► expired
   └────────────┴────────────────┴──────────────────┴──► revoked
   └────────────┴────────────────┴─────────────────────► denied
```

`presented` is a display fact — a QR was scanned, a pass was opened — and is
idempotent. It exists so the requesting side can show "opened on another
device" without that ever being wired to consent.

`denied`, `consumed`, `expired` and `revoked` are terminal and never reopen.
This is what makes a photographed QR useless after the fact: the reference
still resolves, and it resolves to a receipt.

`approved → revoked` is legal. Between approving and executing there is a
window, and a user who changes their mind inside it must be able to close it.
Revocation only removes authority, so admitting the edge cannot widen anything.

## The digest

    displayed operation == approved operation == executed operation

`canonicalRequestDigest` covers the kind, approver, requester,
`authorization_details`, binding message, resource, **and the expiry window** —
each field length-prefixed so text cannot be moved across a boundary to forge a
collision. `approve()` refuses any proof whose `boundDigest` is not this value.

An assertion proves a key was touched. A presentation proves a credential was
held. Only the digest proves *what was agreed to*. This is PSD2 dynamic linking
(EU 2018/389 RTS Art. 5) generalized past payments.

The window is inside the digest because an approval is for an operation *and*
for how long it stays good.

## Transaction authorization

```json
{
  "type": "payment_initiation",
  "amount": { "currency": "USD", "value": "143.72" },
  "payee":  { "display_name": "Example Vendor" }
}
```

The amount is a decimal **string**. A JSON number cannot round-trip `143.72`,
and a digest computed over a float would disagree with the screen for reasons
no reviewer would find.

This expresses *permission to initiate a payment-like operation*. It is not a
card. `assertNoPaymentCredentials` refuses card data by field name and by
Luhn-checking string values, so a PAN under an innocuous key is refused too;
the error names the path and never echoes the value.

**Not implemented, and not planned:** card issuance, DPAN provisioning, network
tokenization, merchant acquiring, Google Pay or Apple Pay rails, PAN/CVV
storage, card-network TSP integration. PCI DSS scope is avoided by
construction.

## Running without a wallet

This is the default. With no Google credentials configured:

```bash
pnpm --filter @opensesame/control-plane start   # :8788
```

The provider reports `available: false`, `issuePass` refuses with a typed
`WalletNotConfiguredError`, and the QR / PWA / browser / CLI paths are
untouched. No test in this repository requires a Google issuer account.

Google Wallet is never on the authorization path, so its availability is not
part of authorization correctness:

- Google is down → authorization still works.
- A pass update is delayed → authorization still works.
- The user deletes the pass → their OpenSesame identity is unaffected.

Revoking a pass and revoking an identity are separate operations, in that order
of blast radius.

## Configuring Google Wallet

All values are explicit; partial configuration is rejected at startup rather
than half-working. No issuer id or environment URL is hard-coded, and the
service-account key never reaches a frontend bundle.

| Setting | Meaning |
|---------|---------|
| enabled | Off by default. |
| issuerId | Your Google Wallet issuer id. |
| classId | The Generic Pass class. |
| serviceAccountEmail | Signs the Save-to-Wallet JWT. |
| serviceAccountKeyPem | Private key. Never committed; supplied via the existing secret/config path. |
| publicBaseUrl | The origin interaction URLs are built against. |

The pass carries a barcode whose value is the canonical interaction URL and
display rows chosen for being non-secret. `assertPassPayloadSafe` runs on every
issue **in production**, not only in tests, and refuses tokens, claim tokens,
JOSE, PEM headers, PANs and forbidden parameter names anywhere in the
serialized object.

## Adding another wallet provider

Implement `WalletPassProvider`. Three methods, no vendor types in the
signature:

```ts
capabilities(): WalletCapabilities;
issuePass(input: WalletPassIssueInput): Promise<WalletPassArtifact>;
updatePass?(input): Promise<WalletPassArtifact | void>;
revokePass?(input): Promise<void>;
```

Rules that are not negotiable:

1. Vendor DTOs stay at the adapter boundary. They must not appear in
   authorization domain objects, interaction state, ceremony-kit, grant logic,
   or approval receipts.
2. The pass carries a reference. Never a token, a grant, a credential, a raw
   authorization payload, or card data.
3. `capabilities()` reports honestly. A clearly typed *unsupported* is worth
   more than pretend support — which is why Apple Wallet is absent here rather
   than stubbed.
4. The provider is optional. Nothing in the approval path may call it.

## Maturity

Read this as written; nothing below is aspirational.

| Capability | State |
|-----------|-------|
| Interaction domain, state machine, references | Implemented, tested |
| Request digest and binding invariants | Implemented, tested |
| Payment-authorization model and card-data refusal | Implemented, tested |
| Threat model | Written |
| Apple Wallet | **Unsupported.** No adapter, deliberately not stubbed. |
| Card issuance / DPAN / network tokenization / acquiring | **Out of scope**, permanently. |
| OpenID Foundation conformance certification | **Not claimed.** Repository tests establish invariants; they are not certification, and no certification claim may be made from them (ADR 0058). |

For the OpenID4VP / OpenID4VCI support matrices, the exact specification
versions validated against, and what is deliberately unsupported, see
[protocol conformance](protocol-conformance.md) and the `SUPPORT_MATRIX`
constants those packages export — those are the source of truth, and this page
does not restate them so the two cannot drift.
