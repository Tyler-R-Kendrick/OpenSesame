# Trusted contacts: a quorum approves, or holds a share of, what you cannot do yourself

Capability `sharing.trusted-contacts` ([ADR 0186](../adr/0186-trusted-circle-quorum-sharing.md)).
Optional, default off, no network. **It has no screens yet**: Settings draws no
switch for it, and today the behaviour is reached from code
(`packages/app-core/src/lib/quorum/`). This page says what it does, how to
configure a circle, and what it does not promise.

## What it is for

If you cannot act — a lost device, an illness — you want someone to be able to
help. One trusted person holding the whole authority is one point of failure:
if they turn malicious, are phished or are coerced, you lose everything the
authority covered. A **circle** spreads that authority across several people
and asks several of them to agree.

It does two different things, and a circle can do either or both:

| | What the contacts do | What you get |
|---|---|---|
| **Recover a key** | each holds one share of a recovery key for an emergency collection | the collection can be decrypted by a quorum, and by no smaller group |
| **Approve an action** | each approves one specific request with their own security key | the action (today, a time-limited share of one item to a person) goes ahead without you |

They are separate on purpose. Approving an action releases no key; recovering a
key needs release, which needs approval and a delay first.

## The parts

- **A guardian** is a person you invited and who agreed (their security key
  signed the enrollment). They may register a **backup key**. It unwraps the
  same share and never adds a vote.
- **A circle** is your list of guardians in one or more groups, a threshold in
  each group, and a threshold over the groups. "3 of 5"; or "2 of 3 family **and**
  2 of 4 friends".
- **A request** is one thing a guardian is asked to approve: the operation, the
  scope, who receives, and three times — approvals close, shares may be
  released, the request lapses. The sentence a guardian reads is built from the
  request's fields; it cannot say something the request does not.
- **Two clocks.** The *approval window* (minutes) is how long contacts have to
  gather. The *release delay* (hours or days) is how long you have to notice and
  cancel before any share leaves a contact's device. They are separate settings.
- **A cancellation** is signed with your owner key and stops a request in every
  ledger and guardian device that hears of it.

## Choosing a configuration

| You want | Use | Tolerates | Note |
|---|---|---|---|
| a small, reliable circle | **2 of 3** | one unavailable | the default to start from |
| more people, still survivable | **3 of 5** | two unavailable | needs five genuinely independent people |
| trust that is not equal | two groups, e.g. 2-of-3 family and 2-of-4 friends | per group | no single group can act alone |
| every one must agree | **n of n** | nobody | any refusal or lost key blocks recovery; the policy warns |
| one contact | 1 of 1 | — | allowed, warned about: it is emergency access with a delay |

Independence is yours to judge. Two guardians in one household, or whose
backup keys sit in one shared account, are one point of failure; give them the
same *custody domain* and the policy warns when a quorum fits inside one.
Avoid circles whose recovery depends on the vault being recovered.

Leave **user verification** on (a PIN or biometric as well as a touch) and a
**delay** of at least a day or two unless you have a reason not to; the policy
warns about both.

## What a guardian needs

A WebAuthn authenticator that supports the **PRF extension** if the circle
holds shares (a share is wrapped under a key only that authenticator
reproduces). An authenticator without PRF can still approve actions in an
action-only circle. Enrollment records whether the extension answered; the
real test is the round trip at hand-over: the guardian's device wraps the
share, **reopens it with a fresh touch**, and checks it against your commitment
before reporting success. A key whose PRF is unstable fails there, not in the
emergency.

Keys belong to an origin. A guardian registers under the circle's RP ID and
origins and must approve from one of them.

## The sequence (code)

```ts
import * as q from "@opensesame/app-core/lib/quorum/index.js";

// Owner: keys, an invitation, and guardians who answer it.
const owner = q.generateOwnerKeys();
const circleId = q.newCircleId();
const invite = q.createInvite({ circleId, label: "Family", rpId, origins, ownerKey: owner.publicKey, requireUserVerification: true, now });
// Each guardian's device:  q.enrollGuardian({ invite, currentOrigin, name, keyLabels, ceremony })
// Back at the owner:       q.acceptEnrollment({ invite, enrollment, custodyDomain, contactRef, now })

// Owner: one call makes the signed policy, the bundle and a sealed share per guardian.
const { signedPolicy, bundle, deliveries } = await q.createCircle({ draft, owner, payload, now });
// Each guardian:  q.acceptDelivery({ delivery, signedPolicy, pinnedOwnerKey, guardianId, hpkeSecretKey, ceremony })
//   -> { holding, receipt }; the owner checks  q.verifyCustodyReceipt(signedPolicy, receipt)

// Recovery, owner absent. The recipient raises a request with a fresh key:
const { request, recipient } = q.startRecovery({ signedPolicy, recipientLabel, now });
const ledger = q.QuorumLedger.open(signedPolicy, request);
// Guardians:  q.buildApproval({ seat, request, ceremony, now })  -> ledger.submitApproval(...)
// After the delay:  q.buildRelease({ holding, approvals: ledger.approvalList(), request, ceremony, now })
//   (the guardian's device verifies the approvals itself, then releases)  -> ledger.submitRelease(...)
const payloadBack = await q.completeRecovery({ ledger, recipientSecretKey: recipient.secretKey, bundle });

// Action only: a quorum-approved standing share, through the existing share ledger.
//   q.createRequest({ operation: "grant-access", grant, ... }); then q.grantFromQuorum({ tomb, ledger })
```

Every packet (`invite`, `enrollment`, `share-delivery`, `custody-receipt`,
request, `approval`, `release`, `cancellation`) is plain JSON with no
plaintext secret in it, so it can travel over any road — a message, a QR, a
Drop, a live session.

## If OpenSesame is not there

Shares are SLIP-0039 mnemonics written with an **empty passphrase**. Any
conforming tool recombines the threshold of them (one per guardian in a plain
circle, one group's worth per group otherwise) into the recovery secret, and
the bundle opens with a key derived from it (`openBundle`). Keep the bundle
somewhere that outlives your device, and the wordlist and format are fixed by
the standard.

## Item types

Two optional item types hold the records
(`marketplace/item-types/optional/`, installable from the default marketplace):

- **Trusted circle** — your record: rule, state, contacts, the signed policy,
  and your owner signing key (concealed; line one of the `pass` entry).
- **Guardian share** — what a guardian holds for someone else: the signed
  policy and their **wrapped** share (concealed). Never a mnemonic.

## Operator controls

The capability is off unless a person turns it on; an instance policy can
**prohibit** it (`prohibited: [sharing.trusted-contacts]`) or leave it out of a
distribution. It reaches no service, so it declares no egress. Because it has no
screens, Settings shows no switch for it until a plan already approves it.

## What it does not do

- A quorum is delegated authority; fewer than the threshold learn nothing, the
  threshold has everything you gave it.
- A guardian's browser sees their one share while it is released.
- The key a request names as its recipient is shown to every guardian as a
  fingerprint. Confirm by another road that it is your new device's.
- The delay is kept by honest devices and the ledger's clock; a static
  recovery page cannot enforce one. A cancellation reaches only those who hear
  of it.
- Changing guardians is a new circle with new shares. Old shares still open the
  old bundle.
- A quorum approval is not a downstream session; a service's own bearer session
  outlives it. Revealed secrets still need rotating at their provider.
- Not yet tested on physical security keys. Tests use a virtual authenticator
  that produces real WebAuthn artifacts.

## Verifying it

```bash
pnpm --filter @opensesame/app-core exec vitest run src/lib/quorum
```

runs the 45 SLIP-0039 vectors (`spec/conformance/slip39/`), the RFC 9180
Appendix A.1 and A.2 vectors (`spec/conformance/hpke-rfc9180-vectors.json`),
the protocol end to end, and the attacks listed in the ADR. Neither vector file
is ever edited or regenerated to make a reader pass.
