# Threat model — external authorization notifications and approval ceremonies

Companion to [ADR 0081](../adr/0081-external-authorization-notifications.md).
Scope: the path from an authorization request being created, through whatever
channel tells a person about it, to a decision being settled and recorded.

## Trust boundaries

```
                     ┌──────────────────────────────────────────┐
   requester ───────▶│  authorization request  (durable inbox)  │◀── the authority
                     └───────────────┬──────────────────────────┘
                                     │ outbox (at-least-once)
                                     ▼
                        ┌────────────────────────┐
                        │  notification router   │   preference ∩ policy
                        │  (no authority at all) │   ∩ bindings ∩ adapters
                        └───────────┬────────────┘
        ═══════════════════ trust boundary ═══════════════════
                                    ▼
       Slack │ Teams │ Telegram │ WeChat │ SMS │ Web Push │ webhook
                                    │
                       (a doorbell, and an opaque link)
                                    │
        ═══════════════════ trust boundary ═══════════════════
                                    ▼
                     ┌──────────────────────────────────────────┐
                     │  in-app ceremony: comparison + WebAuthn  │
                     │  activation bound to THIS transaction    │
                     └───────────────┬──────────────────────────┘
                                     ▼
                        settlement (CAS) ──▶ receipt
```

Everything below the first boundary is **untrusted for authorization** and
trusted only for delivery. A provider callback re-crosses the boundary upward,
and does so carrying provenance — never authority.

## Threats and defences

| Threat | Required defence |
|---|---|
| MFA / push fatigue | durable dedupe by canonical digest, durable per-requester and per-approver rate limits, comparison ceremony, explicit non-one-tap intent |
| Stolen chat session | external channels have a bounded assurance ceiling; policy requiring phishing resistance forces in-app step-up |
| Mutable email / display-name takeover | bindings keyed on stable `(providerId, tenantId, subjectId)`; display metadata is never used to resolve a binding |
| Cross-tenant provider identity | all three identity components must match; subject ids are unique within a tenant, not across them |
| Callback replay | provider timestamp window + provenance check + durable replay ledger where the insert *is* the claim + atomic settlement |
| Request swapping | request digest and transaction digest bound into the signed transcript; settlement compares against the stored digest |
| Cross-request activation | activation carries `authReqId`, and the caller supplies the expected id from the loaded row, never from the activation |
| Decision swapping ("deny" replayed as "approve") | the decision verb is inside the transaction digest |
| Policy TOCTOU | the policy digest is inside the transaction digest; policy is re-resolved at decision time, and a tightened policy invalidates an activation minted under the old one |
| Preference downgrade | preference intersects policy and can only narrow; an exhaustive test sweeps every channel against every risk class |
| Assurance forgery | authentication facts for an external path are derived from the channel's capability ceiling, never from anything a callback asserted |
| Confused deputy (provenance read as authorization) | `evaluateDirectSettlement` and `evaluateAssurance` are separate gates and both must pass |
| Lock-screen / archive disclosure | confidentiality classes; external bodies default to `minimal`; the comparison code has no field in the render input |
| Malicious requester text | bidi/C0/C1/zero-width stripping, length caps, provider-specific markup escaping |
| Callback body parsed before verification | raw bytes captured first; parse happens only after the signature check, and a test proves the refusal ordering |
| Compromised integration token | binding revocation and rotation; a token can never exceed its channel's declared capability |
| Binding hijack | explicit authenticated binding ceremony, attempt-bounded, expiring, completable once; knowing a destination identifier is not enough |
| Phone reassignment / SIM swap | SMS declared low assurance, `canRenderDecisionActions: false`, never phishing-resistant |
| Comparison brute force | six digits behind a durable attempt budget that re-issuing does not refill; budget checked before comparison |
| Multi-instance limit bypass | every load-bearing limit is a persisted row with CAS, never a module-global map |
| Worker crash mid-send | durable outbox and delivery rows; attempts counted on claim, so a crash still burned a try |
| Dead-letter confusion | delivery state and authorization state are separate machines; neither writes the other |
| Link theft | rendezvous references are opaque and grant nothing; the link alone opens a page that still requires authentication and the full ceremony |
| Bearer token in a notification URL | structurally absent; push payloads and message links carry only an opaque reference |
| Passkey replay | one-time activation spent by CAS; challenge bound to the transaction digest |
| Notification endpoint SSRF | reuses the existing webhook egress defences (https-only, no redirects followed into internal space) |
| Agent impersonating a human | `decidedByKind` recorded rather than inferred; human ceremonies excluded from every agent surface in the capability registry |
| Alert amplification | the "I don't recognize this" path raises one security event and does not itself send notifications |

## Residual risks, stated plainly

1. **A compromised provider workspace can generate notification noise.** If an
   attacker controls a Slack workspace where a person has a live binding, they
   can cause messages to appear. They cannot approve anything the policy did not
   explicitly open, and the anti-fatigue limits bound the volume. Revoking the
   binding is immediate and takes effect before the next callback.

2. **An operator can opt a channel into direct low-risk approval.** That is a
   deliberate affordance, and it means a stolen Slack session can approve the
   requests that policy classified as low risk on that channel. It cannot reach
   anything requiring an activation, phishing resistance, or comparison. The
   opt-in is per-channel, explicit, and audited.

3. **The in-process WebAuthn challenge store is process-local.** This is
   pre-existing (`createMemoryChallengeStore`). It is not load-bearing here: the
   one-time property that matters is the durable `approvalActivations` CAS. A
   multi-replica deployment can see a challenge issued on one replica fail to
   verify on another — an availability wrinkle, not an authorization one.

4. **Push endpoints are capability URLs held by a third-party push service.**
   Anyone holding one can deliver a notification to that browser. Payloads are
   `minimal` and grant nothing; the worst outcome is an unwanted "Authorization
   requested" banner.

5. **Historical approvals cannot be retroactively characterized.** Rows settled
   before ADR 0081 have no receipt, and none is synthesized for them. A reviewer
   sees the absence rather than a fabricated assurance claim. This is
   deliberate: inventing evidence for an old decision would be worse than
   recording that none was captured.

6. **Fallback plans are held in process memory.** When a preferred channel
   fails permanently, the router falls through to the next step in the plan it
   computed — and that plan lives in a bounded in-process map. A restart, or a
   delivery claimed by a replica that did not compute the plan, loses it. The
   failure is closed rather than open: with no plan the row dead-letters, the
   request stays in the durable inbox, and no channel outside the original plan
   is ever selected. It costs a fallback, never an authorization. Making it
   durable would mean a routing column on the delivery row; re-deriving the
   plan at delivery time is explicitly the wrong repair, because that is how a
   channel policy excluded gets picked.

7. **Self-asserted bindings exist in development.** With no provider
   round-trip available offline, a dev deployment may complete a binding from
   the identity the browser proposed. It is refused in production
   (`assertSecureConfig` throws), and a channel listed for direct settlement
   with no verifiable callback secret is refused there too.

8. **`v1` request digests remain verifiable.** Requests created before the
   canonicalization fix keep their insertion-order-dependent digest. They still
   settle correctly, because settlement compares against the digest stored with
   the row. Executors cannot independently re-derive a v1 digest — which is the
   defect that motivated `v2` — so the pre-existing weakness persists only for
   requests already in flight at upgrade time.
