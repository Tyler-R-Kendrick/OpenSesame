# Audit 2026-08-08 — the audit chain restarted at genesis every boot

Date: 2026-08-08
Scanners: cve-lite, osv-scanner, cargo-audit, gitleaks, semgrep, ast-grep, clippy —
all clean. This is a fresh-eyes review of the chain added in
`audit-2026-08-08-audit-chain.md`, three ticks ago.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `createChainedAuditSink` was constructed with no `tip`, so every process start began a new chain at `genesis`. The trail became one disconnected run per process lifetime — and a run beginning at genesis is exactly what deleting a contiguous tail looks like. The tamper evidence the previous tick claimed was, across any restart, absent. | The tip is read from the store before the first append. |
| High | Nothing could re-walk the trail. `list` ordered by `occurred_at`, which is a clock value with frequent ties, and a tie sorts arbitrarily — so the stored order was not the append order and a deletion could not be told from a reordering. | New `seq` column (`bigserial`); both repositories now return append order. |
| Medium | `GET /v1/audit/events/verify` walked the *caller's own* events. One principal's events are not adjacent in the chain, so consecutive members of that slice never link to each other. The route worked around this by checking each event against its own digest, which detects `altered` and can never detect `broken` — the deletion case the chain exists for. | The route walks the contiguous run instead. |

## What changed

- `ChainedAuditSinkOptions.tip` accepts a function, resolved once before the first
  append and inside the queue that already serializes appends, so concurrent first
  writes cannot each read a tip. A store that cannot be read leaves the tip at
  genesis and the event is still written: losing the event would be worse than a
  chain with a visible seam.
- `audit_events.seq` is a `bigserial` with its own index (migration
  `0005_audit_seq.sql`). The Postgres repository orders by it; the in-memory one
  uses insertion order, which is the same thing. Neither exposes `seq` in the
  domain type — it is the store's order, not an event's field.
- The verify route lists unfiltered, measures the first event against the digest it
  already claims rather than against genesis (the window starts mid-chain), and
  returns no event contents. `eventId` is withheld unless the failing event is the
  caller's own: that somebody's trail was tampered with is worth telling any
  principal, whose it was is not.

## Not fixed here

- A digest is still not a signature. A writer that can recompute every later digest
  can still rewrite the trail; that threat needs a signer, as the original note said.
- The verify walk covers the newest 200 events. A tamper older than that window is
  not reached, and nothing yet stores a checkpoint the window can be anchored to.
- There is no repository method that deletes an audit event, which is why the
  removal case is covered by unit tests in `packages/audit` rather than through the
  API.
- Existing rows get `seq` values in whatever order Postgres assigns during the
  `ALTER TABLE`. For a trail written before this migration that order is the
  physical one, which is usually insertion order but is not guaranteed to be.

## Verification

- `packages/audit` — 14 passed (3 new: the tip is read rather than reset, it is read
  exactly once under concurrent appends, and an unreadable tip still writes the event)
- `apps/control-plane` — 34 passed (the verify test now proves the walk covers the
  whole run, using an event belonging to another principal)
- `packages/database` — 9 passed; `pnpm -r typecheck` and the full workspace suite green
- cve-lite, osv-scanner, cargo-audit, gitleaks, semgrep, ast-grep, clippy — clean
