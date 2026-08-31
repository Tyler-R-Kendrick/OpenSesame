# ADR 0081 — Where you are told, and what it takes to say yes

- Status: Accepted
- Date: 2026-08-31
- Extends: [ADR 0046](0046-relayed-execution-and-authorization-inbox.md) (the
  authorization inbox), [ADR 0051](0051-user-controlled-trust-broker-core.md)
  (assurance and transaction-bound activation).
- Supersedes: nothing.

## Context

ADR 0046 gave OpenSesame a durable authorization inbox: a CIBA-shaped request
with an opaque `authReqId`, a TTL, RFC 9396 `authorization_details`, a binding
message shown identically to requester and approver, and a `requestDigest` an
executor re-derives before acting. It also gave that inbox one doorbell — a
Standard Webhooks endpoint per principal.

One doorbell is not enough, and the reason is not convenience. People are not
sitting in the inbox. A request that waits five minutes for somebody who is in
Slack, or asleep with a phone on the nightstand, expires unapproved — and the
usual repair for that is the dangerous one: make the chat message itself
approvable, because that is where the person already is.

That repair quietly answers a question nobody asked. **Where a person is
interrupted** and **what it takes for them to authorize something** are two
different questions, and a system that lets the first decide the second has
made a preference toggle into a privilege change. Pick Slack for convenience,
and a stolen Slack session is now worth a hardware authenticator. Pick SMS,
and a SIM swap is worth the same. The channel a person finds comfortable has
nothing to do with the assurance an operation demands.

So the requirement was two mechanisms that compose in one direction only:

> User preferences decide **where notifications go**.
> Security policy decides **which ceremony is sufficient to approve**.

Three further pressures shaped the design.

**Out-of-band messaging is not phishing-resistant.** NIST SP 800-63B treats an
out-of-band authenticator as its own thing: useful, necessarily rate-limited,
and explicitly not phishing-resistant, because phishing resistance is a
property of a credential bound to an origin. No amount of TLS on the way to a
chat app produces that property. A design that lets a channel *claim* it will
be believed.

**A provider-signed callback proves provenance, not authorization.** Slack's
v0 request signature proves Slack sent the bytes. It says nothing about
whether the person at the other end is the approver, whether they verified
themselves, or whether they understood what they clicked. Conflating the two
is the confused-deputy shape this ADR exists to refuse.

**A notification is visible in more places than the person expects.** Lock
screens, watches, shared desktops, archived workspaces, compliance exports.
An `authorization_details` object dumped into a Slack channel is a
capabilities disclosure that outlives the request by years.

## Decision

### 1. One vocabulary, in the domain, with capabilities as a closed record

`packages/os-domain/src/notifications.ts` defines the channel kinds and, for
each, a **closed `ChannelCapabilities` record**: can it notify, can it carry a
rendezvous link, can we cryptographically check a callback from it, does a
binding name a stable provider subject and tenant, can it verify its user,
can it bind a transaction, can it *ever* satisfy phishing resistance, what may
a body on it disclose, and how far may it be trusted to carry a decision.

Closed, rather than booleans scattered at call sites, because a single record
every decision reads from cannot develop the hole where one code path forgot
to ask. `canSatisfyPhishingResistance` is `false` for every channel except the
in-app ceremony, and an exhaustive test over the catalogue holds it there.

### 2. Bindings are keyed on a stable provider tuple, never a display string

An `ExternalChannelBinding` associates a canonical OpenSesame principal with
`(providerId, providerTenantId, providerSubjectId)`. Display metadata —
labels, handles, addresses — is carried separately and is never used to
resolve a binding.

The tenant component is not decoration. Provider subject ids are unique
*within* a tenant, so an attacker who controls their own Slack workspace can
mint a user id that collides with somebody else's binding; matching on the
subject alone hands them that person's authority. This is the rule
`docs/identity-linking.md` already draws for identity, applied to delivery.

Adding or replacing a binding changes *where authorization prompts appear*, so
it is itself a security-sensitive ceremony: challenged, attempt-bounded,
expiring, completable exactly once, and audited.

### 3. Routing is an intersection, in a fixed order

```
policy ∩ preference ∩ live bindings ∩ configured adapters
```

`planNotificationRoute` iterates the *preference* — so ordering and fallback
are genuinely the person's choice — while membership stays the operator's. A
preference for a channel policy never allowed simply finds nothing to select.
The plan also reports why each excluded channel was excluded, so a settings
screen can be honest that an adapter is unconfigured rather than implying it
works.

`in_app` is appended unconditionally. Every other step is a way of telling
somebody to go look at the inbox; a person whose channels are all misconfigured
must still find the request waiting.

### 4. Notification delivery and authorization settlement are separate machines

The outbox stays the source of truth. Fan-out is idempotent per
`(outbox event, channel, destination)`, deliveries are claimed with attempts
counted on claim, retried with bounded backoff, and dead-lettered.

Nothing in the delivery path may move an authorization request. A
dead-lettered delivery has denied nothing; a delivered one has approved
nothing. Delivering twice does not authorize twice.

### 5. High assurance means a WebAuthn ceremony bound to *this* transaction

`approvalTransactionDigest` commits to the request id, the request digest, the
approver, **the decision verb**, the effective policy digest, and the channel.
A challenge is minted against that digest, and the resulting `ApprovalActivation`
is spent by a durable compare-and-set at settlement.

Each component refuses a specific attack. Without the decision in the
transcript, an activation obtained for "deny" is spendable as "approve" — the
person proved presence and the server supplies the verb. Without the policy
digest, a ceremony that satisfied yesterday's rules can be presented against
today's tightened ones. Without the request digest, editing
`authorization_details` after the ceremony leaves the signature valid over
something else.

The one-time consumption is a persisted CAS rather than a delete from the
in-process challenge map, because a budget the second replica cannot see is
not a budget.

### 6. Direct external settlement is default-deny, and provenance is not enough

`evaluateDirectSettlement` permits a callback to settle a request only when
policy names that channel for that verb, the channel's capabilities can carry
a decision at all, the binding is live, all three identity components match,
the callback is authentic and fresh and unreplayed, the request is pending and
unchanged, and no activation is required. Every default policy ships with
`directApprovalChannels` empty.

Crucially, the assurance check is **not** in that function. Provenance and
authorization are evaluated separately and both must pass — `evaluateApprovalCeremony`
in `packages/trust-broker` is the single composition point. An external path
derives its authentication facts from the channel's *ceiling*, never from
anything a callback asserted about itself, so a policy requiring phishing
resistance rejects the same byte-identical, perfectly valid Slack callback that
a low-risk policy accepts, and tells the person to come to the app.

### 6a. Freshness names its own mechanism

`callbackFresh` as a bare boolean was a field with nothing behind it on a
channel like Telegram, whose Bot API stamps a button press with no time at
all. A callback now declares *how* freshness was established — a signed
provider timestamp, or a one-time server-minted reference the replay ledger
retires — and `evaluateDirectSettlement` refuses when it is neither, or when a
caller claims a provider timestamp on a channel whose provider does not send
one. Omitting the field is also a refusal: a route that forgets it is a route
that did not check.

### 7. Comparison is a server secret, and the notification must not carry it

`bindingMessage` is requester-supplied text; a requester who chooses what the
approver compares has not been asked to compare anything. The comparison value
is server-generated, six digits, stored only as a digest, spent against a
*durable* attempt budget that re-issuing does not refill, and shown on the
**initiating** surface only. It is structurally absent from every notification
template — the point of the ceremony is that the person carries it from where
the request started to where it is approved.

### 8. Receipts record the bar demanded and the bar met

An `ApprovalReceipt` keeps the path (in-app, external rendezvous, external
direct, agent), the channel, the binding, all three digests, and the required
and achieved assurance as *reason codes* rather than a scalar. A reviewer
asking "could a compromised Slack workspace have caused this?" gets an answer
that does not depend on re-deriving a policy that has since changed. Nothing
in a receipt is a secret.

### 9. Provider capability is declared honestly, or not at all

Slack and Telegram have official, checkable inbound provenance mechanisms and
stable identities, so they may — where policy says so — carry a decision.

Teams, WeChat, SMS, Web Push and generic webhooks may not, and their capability
records say so rather than their adapters pretending. Teams inbound actions
need a Bot Framework channel with a hosted public endpoint and Entra token
validation this repository cannot exercise; WeChat interactive approval needs a
verified service account and a per-user OpenID from a flow we cannot run
offline; a phone number is a carrier lease that SIM swap transfers without the
holder; a push endpoint is a delivery address; a webhook endpoint is a program.
Each ships as a working notify/rendezvous adapter with `canRenderDecisionActions:
false`, and the policy engine enforces the limit.

An adapter that overstated itself would be a lie the policy engine faithfully
acted on, which is worse than a missing feature.

## Consequences

- A person can be reached where they are without anything they choose lowering
  what it takes to approve. The settings screen says so in as many words.
- High-risk operations — root access, credential recovery, authenticator
  binding, secret export, MFA disablement, privilege escalation, and anything
  that changes who may approve in future — default to: external notification,
  in-app review, fresh transaction-bound phishing-resistant approval.
- Deployments that want direct Slack approval for low-risk requests must opt in
  per channel, explicitly, and still clear the assurance bar.
- No paid dependency is introduced. Web Push is RFC 8291/8292 over `node:crypto`
  with no push SaaS; SMS is an operator-supplied self-hostable bridge contract
  rather than a carrier SDK, honestly reported as unavailable until configured.
- The existing `/v1/webhooks` surface keeps working byte-identically; it becomes
  one adapter among several rather than the only doorbell.
- The `requestDigest` encoding moves to `v2:` with canonical (recursively
  key-sorted) `authorization_details`, because the v1 `JSON.stringify` was
  insertion-order dependent and an executor could not reproduce it — the check
  ADR 0046 promises could not actually run. Stored v1 digests keep verifying,
  since settlement compares against the value stored with the row.
- Residual risk we accept and document: a compromised Slack workspace can still
  cause *notification* noise for its bound users, and can settle low-risk
  requests an operator explicitly opted in. Anti-fatigue controls (durable
  dedupe, per-requester and per-approver rate limits, an unrecognized-request
  report that does not itself amplify) bound the first; the explicit per-channel
  opt-in bounds the second.
