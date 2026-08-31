# ADR 0075 — Host certificate key custody, and unattended renewal

Status: Accepted
Date: 2026-08-31
Supplements: ADR 0005 (authority handles),
ADR 0052-cert ([trust semantics and key custody](0052-automatic-certificate-authority-selection.md)),
ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md)),
ADR 0066 (Certificate Manager domain model),
ADR 0074 ([expiry lifecycle hooks](0074-expiry-lifecycle-hooks.md))

## Context

ADR 0074 gave every deadline in the authority plane a detector and a published
hook, and put `OpenSesame`'s own rotation on that feed. It could not do the same
for certificates, and the reason was structural rather than a matter of effort.

Every issuance path in `apps/gateway/src/routes/certs.rs` ends by returning the
new private key **to the caller**, in a sealed, time-boxed delivery they
acknowledge at `/certs/deliveries/{request_id}/ack`. The custody model is "the
host holds this for ten minutes until the requester collects it". A background
responder is nobody: it has no delivery to acknowledge and nowhere to put a key.
An unattended renewal on that model would mint a private key with **no
recipient** — worse than not renewing, because the certificate would look
renewed while the material went nowhere.

Meanwhile `managed_certificate_keys` — the table for exactly this — had existed
since ADR 0066 with no reader and no writer anywhere in the gateway, and nothing
in production ever set `auto_renew_enabled`. Three links were missing, not one:
a way to *ask* for custody, a place to *keep* the key, and a responder to *use*
it.

## Decision

### 1. Custody is opt-in at issuance, and it is a different custody model

`POST /api/v1/certs/issue` accepts `managed: true` (with an optional
`renew_before_hours`). A managed issuance seals the leaf private key under
`seal_scopes::MANAGED_LEAF_KEY`, scoped to the certificate id and organization,
and keeps it in `managed_certificate_keys`.

The key is still returned once, in the same response as before: the requester
has to deploy it. What custody buys is that the host can reissue **later**
without anyone listening.

### 2. Custody is a fact, not a label

There is no `source = 'managed'` marker. `issued_certificates.source` is a
closed CHECK over how a certificate was *obtained* (`issued` / `imported` /
`discovered`), which is a different question from who holds its key — and a
label can drift from the truth in a way the truth cannot. "Does the host hold
this key?" is answered by whether `managed_certificate_keys` has a row, which is
the same condition renewal actually depends on: the host can only reissue what
it can still open.

A certificate whose key was delivered to its requester therefore reports
`not_in_custody` from both the renewal responder and the reveal route. The same
refusal, from the same predicate, to an operator and to a subscriber.

### 3. A certificate and its key are created together or not at all

`Db::complete_managed_certificate_issuance` settles the issuance request,
inserts the certificate, and inserts the sealed key in **one transaction**. A
certificate row without its key is both unrenewable and undeployable — the host
could neither reissue it nor hand it to anyone — so a half-written pair is worse
than no pair.

The existing `complete_certificate_issuance` cannot serve: it writes the
0013-era column set and *requires* a delivery blob, which is the opposite
custody model. `transition_certificate_issuance` refuses `completed` outright.
Completion had to be its own transaction either way.

Every certificate row needs its own `certificate_issuance_requests` row —
`request_id` is `NOT NULL` behind a unique foreign key — so a renewal is
auditable as a request exactly like a first issuance. The request digest
includes the request id, because a renewal asks for the *same* subject and SANs
as the certificate it replaces and a content-only digest collides with its own
predecessor against `UNIQUE(organization_id, request_digest)`.

### 4. The renewal lead must fit inside the lifetime, or renewal never terminates

This is the sharp edge, and it is not obvious until it bites. The renewal rung
fires when `remaining <= renew_before`. If `renew_before >= lifetime`, then a
*newly issued* certificate is already inside its own renewal window — so its
replacement is due the instant it is signed, and the responder reissues on
every tick, forever.

`converging_renew_before` closes it: the lead is clamped to at most **half** the
lifetime, so a successor spends at least half its life outside the window, and a
lifetime with no room for a window at all (under two hours) is refused at
issuance with `lifetime_too_short` rather than accepted into a loop. The lower
bound keeps the lead longer than the scanner's tick, so the rung is not crossed
and acted on in the same pass that first sees it.

### 5. Renewal inherits, it does not re-decide

A renewal keeps the predecessor's subject, SANs, validity **span**, and renewal
lead, and signs under the predecessor's own authority where that authority is
still active. Renewing to a fixed default would silently change a certificate's
lifetime the first time it rolled over; falling back to a different signer would
quietly re-root somebody's trust. An authority whose sealed material will not
open is a refusal, never a fall-through.

Afterwards the two are linked in both directions and the predecessor is marked
`renewed` — which also drops it out of `list_certificates_expiring_before`, so
the scanner stops warning about a deadline that no longer matters, and its
ladder watermarks are cleared. Only an `active` certificate can be retired this
way: revocation and supersession are different facts and a reviewer needs them
to stay different.

### 6. Reveal is human-plane, permanently

`GET /api/v1/certs/{id}/key` returns a managed private key to an owner/admin
session or the operator. It is the one route in the certificate plane that
hands out key material on demand, and it exists so an operator can redeploy
after an unattended renewal.

It is excluded from **every** agent surface, and that exclusion is the same one
ADR 0005 makes everywhere else: agent-facing APIs carry references, never
material. `managed: true` on the issue route is likewise not agent-reachable —
it decides where a private key lives.

### 7. Certificates written by `dev_pki` now carry RFC 3339 timestamps

Not a design choice so much as a defect this work surfaced.
`time::OffsetDateTime`'s `Display` is not RFC 3339 — it renders
`2026-08-31 0:00:00.0 +00:00:00`, with a space for the `T` and a seconds-bearing
offset — and that shape was being written straight into
`issued_certificates.not_before` / `expires_at`. Two consequences, both far from
the cause: `SQLite`'s `julianday()` returns NULL for it, so
`list_certificates_expiring_before` silently matched nothing, and the lifecycle
scanner's RFC 3339 parse dropped the subject. Between them, **an expiring
certificate produced no signal at all** — the certificate half of ADR 0074 was
inert on arrival. `dev_pki` now formats with `Rfc3339` and propagates the error
rather than falling back to a shape nothing can read.

## Consequences

- Unattended certificate renewal works end to end, on the ADR 0074 feed: an
  aged managed certificate crosses `lifecycle.renewal.due`, the responder
  reissues it, subscribers see `lifecycle.renewal.succeeded`, and an operator
  collects the new key from the reveal route. The gateway test suite drives
  exactly that path.
- The host now holds long-lived private keys for certificates that opt in. That
  is a real increase in what a gateway compromise yields, and it is why custody
  is opt-in, sealed under its own purpose-scoped AAD, never agent-reachable, and
  refused outright when no sealing key is configured or when the authority is
  the process-ephemeral development CA (a certificate signed by one could not
  be renewed after a restart, so promising custody over it would be a promise
  the host cannot keep).
- Certificates issued the existing way are unchanged: their key still goes to
  the requester, they never set `auto_renew_enabled`, and the responder reports
  `not_in_custody` rather than pretending.
- Certificate authorities remain alert-only. Re-keying one changes trust for
  everything it signed (ADR 0052-cert), so it is not something a background
  actor does.
- Signer rotation still has no unattended path and still reports the gap as an
  outcome event.
