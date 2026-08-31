# ADR 0074 — Expiry lifecycle hooks, and rotation as their first subscriber

Status: Accepted
Date: 2026-08-30
Supplements: ADR 0005 (ConnectionRef / authority handles),
ADR 0032 §3 (catalog is data),
ADR 0039 (transactional outbox, backup actor, compensating retries),
ADR 0046 §12 (hooks are signed event streams),
ADR 0052-cert ([trust semantics are never assigned by configuration](0052-automatic-certificate-authority-selection.md)),
ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md),
[connector/hook architecture](0065-connector-hook-architecture.md)),
ADR 0066 (Certificate Manager domain model)

## Context

Everything in OpenSesame's authority plane expires. Issued certificates carry
`expires_at`, `auto_renew_enabled`, and `renew_before_seconds`
(`issued_certificates`). Certificate authorities carry a `not_after` in their
public metadata. Signers inherit their bound certificate's deadline. Brokered
credentials advertise `expires_at` on `ConnectionView`. Sealed-store paths and
connections under a rotation policy come due on an interval.

Almost none of that was *detected*. The one loop that existed —
`apps/gateway/src/rotation_scheduler.rs` — asked `policy_due_at` about rotation
policies and nothing else, and told nobody: it executed a rotation and wrote a
changelog row. A certificate 24 hours from expiry produced no signal at all.
`cert_alerts` and `alert_deliveries` (ADR 0066) hold per-application
notification *preferences* with no producer behind them; nothing in the
repository ever writes an alert.

So a user who wants to reissue on their own terms — their own ACME client,
their own PKI, their own pager — has no way to learn that anything is
expiring, and we have no way to learn it either except by rediscovering it
subsystem by subsystem.

The second problem is the one that outlasts the first. A notification surface
nobody internally depends on rots: it silently stops firing, the payload
drifts from the docs, a refactor breaks a filter and no test notices, because
the only people affected are outside the repository. ADR 0065 §7 already draws
the safety line — gating paths in the platform, observer paths async and
unable to influence decisions — but says nothing about who consumes the
observer path.

## Decision

### 1. Expiry is a platform-detected fact with one detector, across every tenant

`crates/lifecycle` is the vocabulary: an `ExpirySubject` (what expires, as
metadata), an `ExpiryStage` ladder, a `LifecycleEvent`, and `evaluate` — a pure
function from (subject, watermarks, clock) to the events it owes. No I/O, so
every firing decision is exhaustively testable without a database.

`apps/gateway/src/lifecycle/` supplies the rest: `subjects` gathers deadlines
from every source, `scanner` runs the pass, `dispatch` fans out, `responders`
acts, `delivery` sends. One detector, five sources, one feed.

The tick sweeps every organization, not just the one the gateway is configured
with, and it discovers them from three places because no single one is
complete: the configured organization (which in a deployment without a demo
bootstrap is the nil UUID with no `organizations` row at all), the tenant
registry, and the organizations named by enabled rotation policies (whose table
carries no foreign key into the registry, per the consequence noted below). A
per-organization failure is logged and skipped — one tenant's unreadable table
must not stop another tenant's certificate from being renewed.

### 2. Two ladders, because one aliases itself

Stages are seconds-remaining thresholds, and a monotonic watermark — the
smallest threshold already fired — makes firing idempotent across passes and
restarts.

They sit on **two independent tracks**, and the split is load-bearing rather
than tidy. `Renewal`'s threshold is the subject's own `renew_before_seconds`,
which can land on any value including exactly the 7-day `Warning` rung — which
is the *default* renewal lead. On a single shared watermark that collision does
not merely reorder the two: the rungs are crossed in the same pass forever
after, so whichever loses the tie never fires at all, and a subscriber
filtering on `lifecycle.expiry.warning` silently receives nothing, forever.

So the informational escalation (`Alert`: notice → warning → urgent → expired,
fixed thresholds, never aliased) and the actionable renewal window (`Renewal`)
advance on separate watermarks. Each track is independently monotonic; a pass
emits at most one event per track. The schema's `track`/`stage` CHECK keeps them
disjoint at rest too, so the invariant survives a hand-written row.

Within a track, a pass that skips rungs — a long outage, a subject discovered
already past several thresholds — fires only the most urgent crossed rung. The
ones it skipped are strictly less informative than it is. Because the tracks
never share a watermark, that superseding can drop an alert in favour of a
louder alert and can never drop the renewal window.

A subject whose deadline *moves* resets both ladders, automatically: the
watermark records the deadline it was taken against, and one recorded against a
different deadline is stale. A responder cannot forget to reset it, because
there is nothing to remember.

### 3. Schedules do not narrate

A rotation policy is not a deadline that wants warning ahead of time; it comes
due and gets rotated. Modelled naively it is also a firehose: its deadline moves
on every rotation, which resets the ladder, so an hourly policy would re-fire
notice/warning/urgent every hour forever.

`ExpirySubject::alerting` distinguishes the two. `false` runs the renewal track
only. Rotation policies set it, with a one-second renewal lead so the first tick
at or after the due time fires — preserving `policy_due_at`'s semantics exactly.

### 4. Frozen event names, value-blind payloads

`lifecycle.expiry.notice|warning|urgent|expired`, `lifecycle.renewal.due`, and
the responder outcomes `lifecycle.renewal.succeeded|failed`. Additive only,
never renamed: they are what a subscriber writes a filter against, pinned by a
unit test.

Payloads are assembled key by key from metadata rather than by serializing a
struct, so a field added upstream cannot reach a subscriber without a
deliberate edit. `ExpirySubject` has no field able to carry a value, and a
structural test asserts that — the same shape as the connector world's
`assert_wit_forbids_secrets_get`. Every payload carries `secrets_returned:
false` explicitly, mirroring the rotation routes: a subscriber never has to
infer that the feed is value-blind.

An empty subscription filter matches **nothing**. A hook naming no events is a
misconfiguration, and reading it as "everything" is the wrong direction to fail.

### 5. Dogfooding is structural, not a policy anyone has to remember

`rotation_scheduler.rs` is deleted. Rotation runs because `lifecycle.renewal.due`
fired, through `responders::rotate`, off the same feed a third-party tool
subscribes to. There is no private due-check left to drift from the public one.
If the feed stops firing, our own rotations stop with it — which is the only
reliable way to keep a published event contract honest. The scheduler's own
behavioural tests moved onto the hook path, asserting the same observable
behaviour they always did.

The responder set is a closed lookup by subject kind, not a registry a manifest
can extend: acting on an expiry means using the broker's authority, which is
ADR 0065 Tier X. Kinds with no unattended platform path — CA re-keying and signer
rotation — do not silently no-op. They report the gap as a
`lifecycle.renewal.failed` outcome naming the missing responder and pointing at
`lifecycle.renewal.due`, so a subscriber knows the renewal is theirs to perform.
Leaf certificates gained a responder in
[ADR 0075](0075-host-certificate-key-custody.md), gated on host key custody; one
whose key went to its requester still reports `not_in_custody`. A CA is
deliberately never in that set: re-keying one changes trust for everything it
signed (ADR 0052-cert), so authorities are alert-only.

An outcome event keeps the stage that produced it — that is how a subscriber
knows which rung was acted on — so `should_respond` requires a *ladder* event.
Without that check a `lifecycle.renewal.succeeded` would look exactly as
actionable as the `lifecycle.renewal.due` that caused it, and every rotation
would rotate again.

### 6. Platform responders and community hooks are different things

Per ADR 0065 §7, and the difference is not the subscriber's to choose:

- **Platform responders** run in-process and synchronously, because rotation
  needs the broker's authority. They are named by a closed lookup in platform
  code.
- **Community hooks** are observers: delivered asynchronously from a ledger,
  unable to influence any decision, unable to gate anything, unable to widen
  anything. A hook that hangs or fails changes nothing about what the platform
  did.

Fan-out order is deliberate: bus, then subscriber enqueue, then the responder.
A tool watching `lifecycle.renewal.due` learns about the renewal whether or not
our own rotation then succeeds.

### 7. Delivery reuses the ADR 0039 saga, on its own ledger

`lifecycle_deliveries` is the source of truth; the TaskBus only accelerates and
observes. Work is claimed under a lease, failures back off exponentially, and a
delivery that will not settle dead-letters *visibly* rather than disappearing.

Deliveries deliberately do **not** ride `outbox_events`: that outbox is drained
by the backup actor, which treats every unpublished row as a reason to snapshot.
A separate ledger reuses the shape without provoking backups.

The wire convention is Standard Webhooks, byte for byte what
`@opensesame/webhooks` implements (ADR 0046 §12): `webhook-id`,
`webhook-timestamp`, `webhook-signature: v1,<base64>` over `id.timestamp.payload`
under a `whsec_` key. A subscriber verifies with any off-the-shelf library, and
`webhook-id` is their idempotency key — which matters, because the ledger is
at-least-once by design. Watermarks are recorded *after* an event is queued, so
a crash in between re-emits rather than drops: for an expiry notice a duplicate
is noise and a miss is an outage.

Endpoints must be absolute HTTPS, are refused if they resolve to a loopback,
private, link-local, or metadata address, and are re-checked at send time rather
than only at registration — a hook registered before an operator tightened the
fence, or one whose host now resolves somewhere private, must not be delivered
to. Redirects are responses, never chased. A hook's signing secret is sealed at
rest under its own scope and returned exactly once, at registration.

### 8. Agent surfaces

Reads (`lifecycle_expiring_read`, `lifecycle_hooks_read`,
`lifecycle_deliveries_read`) and the on-demand scan (`lifecycle_scan`) are
agent-reachable: they are metadata, and an agent that can see what is expiring
can do something useful about it.

Registration and removal are **not**. Registering mints and returns a `whsec_`
signing secret once, and an agent surface must never be the thing that receives
it. Removal silently blinds whoever depended on the subscription. Both stay CLI
and Host API, gated as integration configuration (owner/admin or operator), like
sync targets and rotation policies.

### 9. What this does not do

Recorded so each is a decision rather than an oversight.

- **`cert_alerts` is not bridged yet.** It remains ADR 0066's per-application
  notification preference, still without a producer. The lifecycle feed is the
  detector it was missing, but wiring it needs a channel dispatcher (email,
  Slack) that is a separate concern from an event feed. The seam is
  `dispatch::publish`.
- **Leaf certificate renewal has no platform responder.** `auto_renew_enabled`
  certificates fire `lifecycle.renewal.due` and report the missing responder,
  rather than pretending to renew. Registering one when leaf reissuance lands is
  a one-line change to `responders::responder_for`.
- **Authorities without a recorded `not_after` are untracked.** Those minted
  before the Certificate Manager's `CaFacts` document carry no parsed validity,
  and the collector does not crack open sealed material to find one. An
  untracked authority is reported as absent rather than guessed at.
- **Certificate renewal landed in [ADR 0075](0075-host-certificate-key-custody.md).**
  It was blocked here on something structural rather than on effort: every
  issuance path returned the new private key to its caller in a sealed
  delivery, so an unattended renewal would have minted a key with no recipient.
  ADR 0075 adds opt-in host key custody, which is the precondition, and
  registers the `certificate` responder. Certificates whose key went to their
  requester still report `not_in_custody` — the platform genuinely cannot renew
  those.
- **SSF/CAEP and Security Event Tokens** (ADR 0046 §12's richer tier) remain
  future work; the simple Standard Webhooks tier ships here.

## Consequences

- Every expiry in the authority plane is detected in one place, on one ladder,
  with one vocabulary — instead of each subsystem inventing its own notion of
  "due" or, more often, having none.
- The published contract cannot rot unnoticed, because we are on it. A break in
  the feed is a break in our own rotations, which the test suite fails on.
- Adding a source is a collector in `subjects.rs`; adding a responder is an arm
  in a closed match. Neither touches the scanner, the dispatcher, or any
  subscriber.
- `SubjectKind` is a hard fence, like `IssuerKind` and `ExternalIdentityKind`
  before it: a subscription selects kinds, it never adds one, because each kind
  implies a platform responder with real authority. Loosening it requires an
  ADR, not a manifest.
- The lifecycle tables carry no `organizations` foreign key. The gateway's
  `connection_organization` falls back to the nil UUID when no demo bootstrap
  exists, and `rotation_policies` — whose scheduling these tables absorbed — has
  no such key for the same reason. Adding one would make the scanner refuse to
  record watermarks in exactly the deployments where rotation works today. The
  cost is that tenant deletion must sweep these tables explicitly rather than
  relying on `ON DELETE CASCADE`, and that is written on the migration.
- Two more process-lifetime actors in the gateway (scanner, delivery worker),
  replacing one (rotation scheduler).
