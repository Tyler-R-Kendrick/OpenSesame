# ADR 0079 — Shared sessions: a coordination transport, and grants that never travel on it

Status: Proposed
Date: 2026-08-31
References: ADR 0005 ([ConnectionRef over SecretRef](0005-authority-handle-connectionref.md)),
ADR 0038 ([projects, memberships and sharing](0038-project-hierarchy-sharing.md)),
ADR 0044 ([claimable delegation](0044-claimable-connection-delegation.md)),
ADR 0045 ([hosted ceremony pages](0045-hosted-ceremony-pages.md)),
ADR 0046 ([relayed execution](0046-relayed-execution-and-authorization-inbox.md)),
ADR 0062 ([secret drop: E2EE one-time sharing](0062-secret-drop.md)),
ADR 0074 ([expiry lifecycle hooks](0074-expiry-lifecycle-hooks.md)),
ADR 0078 ([setup is the sign-in allowlist](0078-external-idp-is-the-identity-service.md)),
[key hierarchy](../security/key-hierarchy.md)

## Context

A session on a device is single-player. The ask is to make one **shareable** —
a live session several people are in at once, over a realtime transport
(WebRTC, SignalR, WebTransport/HTTP-3, or another p2p protocol) — with the
operator managing participants, inviting people, and, for a public session,
fielding requests to join the way a Slack or Discord channel does. Access is to
be **RBAC plus row-level**: added to a vault, you get the vault; granted three
rows, you get three rows and nothing else. Every grant carries a TTL, publishes
webhooks on expiry, and is policy-enforced.

What already exists, and what does not:

| Piece | State |
|-------|-------|
| Projects, memberships (owner/admin/member), optional sharing | ADR 0038, shipped |
| Claim sessions — bearer link + out-of-band user code + TTL + single-use | `packages/claims`, shipped |
| E2EE one-time sharing, payload sealed client-side | ADR 0062, shipped |
| Relationship authorization, `vault_collection` reader/writer off `project` | `policy/openfga/model.fga`, shipped |
| Deadline detection and a public `lifecycle.*` hook feed | ADR 0074, `crates/lifecycle`, shipped |
| Durable webhook delivery with per-endpoint secret and retry | `webhook_endpoints` / `webhook_deliveries`, shipped |
| **Session participants, invitations, join requests** | **do not exist** |
| **Any realtime transport between clients** | **does not exist** — the only "relay" is ADR 0046's HTTP inbox polling |
| **Per-item (row) authorization** | **does not exist** — `vault_collection` is the finest grain |

So this is new surface, not an extension of something already load-bearing.
That is the reason to review it before building it.

## The finding that shapes everything: a shared session cannot be serverless

Every transport in the ask needs a server.

- **WebRTC** is peer-to-peer only after a server has introduced the peers. It
  needs a signalling channel to exchange SDP and ICE candidates, and in
  practice a TURN relay for the ~15–20% of pairs that cannot connect directly.
- **SignalR** and **WebTransport/HTTP-3** are client-server protocols outright.

`apps/pages` is a static bundle on GitHub Pages. ADR 0078 just established that
it needs **no OpenSesame service at all** to sign somebody in — the browser
runs the whole OIDC code flow itself. Session sharing is the first feature that
genuinely reintroduces that dependency.

**Decision: say so, in the ceremony, at the moment of sharing.** "Share this
session" is the action that requires a Host, and the screen states it and
offers the road to configure one rather than failing at a dead control. This is
the same rule ADR 0078 applied to sign-in: a road nobody configured is not
offered.

## Decision

### 1. Server-mediated channel, not a peer mesh

The transport is a **Host-served WebTransport (HTTP/3) channel with a WebSocket
fallback**, not a WebRTC mesh. The argument, since the ask named WebRTC first:

- **A mesh is O(n²) connections** and every participant maintains a peer
  connection to every other. Fine for four people, bad for twenty.
- **WebRTC leaks network addresses.** ICE candidates in the SDP carry host,
  server-reflexive and relay addresses. Every peer learns every other peer's
  IP. For a *public* session that means a stranger who has merely asked to join
  could learn the operator's home IP address before being admitted. This is the
  single worst exposure in the naive design.
- **We need the server anyway** — for signalling and for TURN. Once a Host is
  in the path, a peer data channel buys latency on a workload that is presence
  and small events, and costs an entire address-exposure surface.
- **The Host already terminates authenticated callers** (`resolve_caller_subject`)
  and holds the audit trail. A session channel there rides existing authn and
  existing receipts instead of inventing a second identity path.

If a peer data path is ever wanted (large attachment transfer, media), it is
added **after** admission and with `iceTransportPolicy: "relay"` so candidates
never carry a participant's own address. It is never the admission path.

### 2. What may cross the transport, and what may never

The line is already drawn in `docs/security/key-hierarchy.md`:
**a valid OIDC session is not possession of the VaultRootKey.** The transport
is a session-plane thing; it stays on the session-plane side of that line.

**May cross:**

- the session id, and the participant roster the viewer is entitled to see;
- roles and grant *metadata* — subject id, scope, role, expiry;
- presence and activity events that name **references** (an item id, a
  collection id), never labels or values;
- ciphertext **already sealed for a named recipient's key**, exactly as ADR
  0062's drop does — the transport is a courier, not a party;
- transport signalling for the channel itself.

**Must never cross, under any framing:**

- the VaultRootKey or any of its wrappers — WebAuthn PRF output, the Argon2id
  KEK, the recovery key, the device secure-storage KEK;
- a ProjectCollectionKey or an ItemDataKey in the clear;
- any `accessToken`, `osc_clm_` claim token, or session bearer;
- a raw secret value, or a decrypted attachment;
- any authority-plane material — receipt-signing keys, sealed CA or signer
  keys, HSM PINs (these are not in the client's reach at all, and must not
  become reachable by way of a session channel);
- **item labels and titles.** Subtle, and the one most likely to be got wrong:
  a presence event reading `Tyler opened "AWS root credentials"` leaks the
  label to every participant, including one granted a different row entirely.
  Events carry ids; each client renders the labels it can already decrypt.

### 3. Row-level grants fall out of the key hierarchy — and so does their cost

The existing hierarchy is `VaultRootKey → ProjectCollectionKey → ItemDataKey
per item version`. Granularity is therefore not something to invent:

| Grant | Cryptographic act |
|-------|-------------------|
| The vault (collection) | wrap the **PCK** for the grantee's key |
| Specific rows | wrap **each item's IDK** for the grantee's key |

Nothing is sent as a key over the channel: the wrap happens client-side in the
granting operator's session, exactly as ADR 0062 wraps a drop, and the ciphertext
travels as an envelope addressed to one recipient.

**Every grant expires, and there is no standing one.** The design note below
called a non-expiring grant "a deliberate, named exception"; building it, that
exception is not implemented at all. A grant carries a mandatory lifetime
between `MIN_GRANT_LIFETIME` (one minute) and `MAX_GRANT_LIFETIME` (seven
days), and an over-long request is **refused rather than clamped** — silently
shortening it would leave the operator believing something the system did not
do. Seven days is a handover, not an arrangement; a longer reach is a project
membership (ADR 0038), which is a different and more visible thing to hold.

**Expiry is enforced at the check, not only announced.** `SessionGrant::assert_active`
compares against the caller's own clock reading on every authorization, so the
`lifecycle.*` feed below announces a deadline it never performs: a scanner that
misses a tick cannot extend anybody's reach.

**The honest consequence, which the UI must state rather than bury: revocation
is re-keying, not a switch.** A participant who held a wrapped IDK and copied
the ciphertext keeps the ability to read that version. Withdrawing a grant
means: stop authorizing new reads (policy, immediate), and re-key so future
versions are unreadable (new IDK on next write for a row; new PCK plus re-wrap
of every item for a whole collection — expensive, and worth saying out loud).
This is why every session grant is TTL-bound by default rather than standing.

### 4. TTL rides the lifecycle feed — never a private timer

ADR 0074 is explicit: anything with a deadline is detected by the lifecycle
scanner and published on the `lifecycle.*` feed, never by a subsystem's own
due-check, and OpenSesame's own rotation subscribes to that same feed so a break
in it breaks us too. A session grant is a thing with a deadline. It therefore
adds **`SubjectKind::SessionGrant`** and gets the whole ladder — notice,
warning, urgent, expired — for free, with the same watermarks and the same
`evaluate` that certificates use.

**A session grant is the one subject kind that never renews itself.**
Renewability moves onto `SubjectKind` rather than resting on a subject's
`auto_respond` flag, and `should_respond` consults the kind first. A
certificate renewing itself overnight is the platform doing its job; one
human's reach into another's vault renewing itself overnight is the platform
giving away what it was trusted to hold. Putting the rule on the kind means a
subject built with the wrong flag — by mistake, or by copying a row from a
certificate — still cannot cause it. Refusing to *act* is not refusing to
*tell*: every rung still fires, because somebody whose access lapses in an hour
is exactly who the ladder exists for.

This is also a security win rather than merely tidy. `crates/lifecycle` is
value-blind *by construction*: `ExpirySubject` has no field able to carry a
value, and `LifecycleEvent::payload` builds its JSON key by key rather than
serializing what a caller handed it. An expiry notification for a grant
therefore **structurally cannot** carry the granted material, however carelessly
a future subscriber is written.

### 5. Expiry webhooks are wiring, not new infrastructure

`webhook_endpoints` (per-principal URL + secret) and `webhook_deliveries`
(durable, attempt-counted, backed off) already exist. A grant's expiry rungs are
lifecycle events delivered through them. Nothing new is needed except the
subject kind above and the event filter.

### 6. Policy enforcement: one new OpenFGA type, additive only

`vault_collection` already has `reader`/`writer` inherited from `project`. Row
level needs one type, and it must be able to **add** to a collection grant and
never to widen one:

```
type vault_item
  relations
    define collection: [vault_collection]
    define reader: [user, team#member, workload, agent] or reader from collection
    define writer: [user, team#member, workload, agent] or writer from collection
```

A direct `reader` on `vault_item` is the row grant. Inheritance from the
collection means a collection reader still reads the row; there is no shape here
in which an item tuple grants more than the collection does. Dropping either
`from collection` clause would quietly turn an additive grant into a
replacement one — a collection reader would *lose* rows — so a test pins both
clauses rather than merely that the type exists.

**No `session` type joins the policy model.** Session membership and grants
live in the Host's own store, where `SessionGrant::permits` is the single
check. Modelling them in OpenFGA as well would create two authorities on one
question, free to disagree; the policy model answers "who may read this item",
and that is the whole of its part. Enforcement stays
where enforcement already is — the check is at the Host's authorization fence,
and the transport is not an authorization surface. **A message arriving on the
session channel is a request like any other, not evidence that its sender is
allowed.**

### 7. Invites reuse claim sessions; join requests are the new thing

An **invitation** is a claim session (ADR 0044/0062 machinery) whose manifest
carries a *grant offer*: this session, this scope, this role, this expiry. It
already has what an invite needs — a bearer link, an out-of-band user code so
the link alone is not enough, a TTL, and single-use presentation. The recipient
accepts in the hosted ceremony (ADR 0045), which is reachable by a guest.

A **join request** is the inverse and has no precedent here: an unknown person
asks, and the operator admits or refuses. Two rules it must be built under:

- **Admission precedes connection.** A pending requester gets no channel, no
  roster, and no peer. They see only that the request is pending. This is what
  keeps a public session from handing strangers the participant list — or, in
  a WebRTC design, the operator's IP address.
- **A public session advertises a name, never its contents.** The discovery
  record is a session id and a display name. Nothing about the vault, the
  items, or who is in it.

### 8. Sharing is the action that names the server dependency

Per the finding above: the share ceremony states that sharing needs a Host,
names which one it will use, and offers the road to configure one. It does not
render a disabled control, and it does not fail after the fact.

## Consequences

- A new authenticated realtime surface on the Host, which becomes part of the
  threat model: it must be rate-limited per principal, bounded in message size,
  and its inbound messages treated as untrusted requests rather than as
  authorization.
- Row-level authorization is a real extension to the policy model, not a UI
  filter. Filtering rows in the client while the server returns the collection
  would be theatre.
- Revocation is re-keying, with a cost that scales with what was shared. The UI
  must say what withdrawing a grant does and does not undo.
- A shared session is not available on a deployment with no Host. That is a
  narrowing of where the product works, and it is the price of the feature.
- `SubjectKind` gains a variant, which is a frozen wire name (ADR 0074) — worth
  getting right once.

## What this ADR does not decide

Implementation. No transport is built, no schema is migrated, and no OpenFGA
tuple is written by this document. The companion design canvas
(`docs/design/shared-sessions/`) draws the ceremonies and pages this argues
for, so the shape and its security story can be reviewed before code exists.

## Rejected

- **WebRTC mesh as the admission path.** IP exposure to unadmitted requesters,
  O(n²) fan-out, and a second identity path beside the Host's. Kept only as a
  possible post-admission data path with relay-only ICE.
- **A server-side "share this item" endpoint.** It would require the server to
  hold plaintext, which ADR 0062 already rejected for the same reason: the
  product is passthrough, and the reveal stays human-gated (ADR 0005).
- **Standing (non-expiring) grants, at all.** Given that revocation is
  re-keying, a grant that never lapses is a key handed out permanently. The
  type carries no way to express one, so the question cannot be reopened by a
  caller passing `None`.
- **Clamping an over-long lifetime down to the cap.** Refusing is louder and
  cannot be misread as agreement.
- **Filtering rows client-side over a collection-scoped read.** Not a
  permission model.
