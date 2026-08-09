# Audit 2026-08-08 — tamper evidence for the control-plane trail

Tick 64 recorded that control-plane audit events carried no integrity chain: no
previous-event digest, no signature, unlike `InvocationReceipt` on the Rust side.
An event could be edited in place or removed and the trail would still read as a
trail. This closes that.

## What was added

`packages/audit/src/chain.ts` computes a digest per event over its own fields plus
the digest of the event before it, and `createChainedAuditSink` wraps the audit
repository so every append is linked. `verifyAuditChain` re-walks a run of events
and distinguishes three failures:

- `unlinked` — the event carries no digest at all (a row written before this, or by
  something that bypassed the sink),
- `altered` — the event's contents no longer produce the digest stored beside it,
- `broken` — the event does not follow the one before it, which is the shape a
  deletion or a reordering takes.

Appends are serialized through the sink. Two events sharing a predecessor would
each claim to follow it and one would be unverifiable, so a second append waits
for the first to land — and the tip only advances once the store accepted the
event, so a failed write leaves no gap for the next event to point at.

Metadata is digested with sorted keys, because object key order is not evidence
and must not change a digest.

## Where it is wired

`createControlPlane` wraps `repos.auditEvents` before anything can use it, so all
existing call sites are chained without changes. `GET /v1/audit/events` now returns
`digest` and `previousDigest`, and `GET /v1/audit/events/verify` re-walks the
caller's own trail, answering 200 or 409 with the reason and the offending event.
A caller sees a subsequence of the whole chain, so that endpoint checks each event
against its own digest rather than against its neighbour.

Postgres gains two nullable columns (`0003_audit_chain.sql`); rows written before
this migration simply verify as `unlinked` rather than being mistaken for intact.

## What a digest does not do

This is not a signature. It stops a trail being quietly rewritten by something
that cannot recompute every later digest — a hand-edited row, a partial
compromise, a buggy migration. A writer that can rewrite the whole chain can still
produce a consistent forgery; that threat needs a signer, and the tip published
somewhere the writer does not control.
