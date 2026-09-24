# opensesame-lifecycle

The vocabulary for how authority ends on the Host / authority plane. A deadline
approaching on a certificate, a brokered credential, a signing key or a
sealed-store entry is a fact the platform detects and publishes as a
`lifecycle.*` hook event; a revocation is a durable invalidation that every
descendant grant checks before anything else. This crate holds both decisions
as pure functions. It does no I/O.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (the scanner, dispatch and
  responders in [`src/lifecycle`](../../crates/gateway/src/lifecycle)) and
  [`opensesame-storage`](../storage) (watermarks and the authority fence tables).
- **Builds on:** [`opensesame-security-events`](../security-events):
  `LifecycleEvent::notice` projects an event onto the shared `SecurityNotice`,
  and event filters use its wildcard matching.
- The gateway's own rotation and certificate responders subscribe to the same
  events an external tool does; there is no private trigger path.
- It cannot leak credential material: `ExpirySubject` has no field able to carry
  a value, and `LifecycleEvent::payload` builds its JSON key by key.
- Fencing fails closed: uncertainty about an ancestor denies (`FenceVerdict`).

## Surface

| Area | Items |
|---|---|
| Subjects | `ExpirySubject`, `SubjectKind` — what is expiring, as metadata only |
| Ladder | `ExpiryStage`, `Track`, `ladder`, `newly_crossed`, `NOTICE_SECONDS`, `WARNING_SECONDS`, `URGENT_SECONDS`, `DEFAULT_RENEW_BEFORE_SECONDS` |
| Decision | `evaluate`, `should_respond`, `Watermark`, `Watermarks` — the events a subject owes at a clock reading |
| Events | `LifecycleEvent`, the frozen `EVENT_*` names, `LIFECYCLE_EVENT_TYPES`, `filter_matches`, `filter_is_valid` |
| Fence | `evaluate_fence`, `Lineage`, `Invalidation`, `FenceReading`, `FenceVerdict`, `Freshness`, `Uncertainty`, `MAX_FENCE_DEPTH` |
| Notices | `LifecycleEvent::notice`, `severity_for_stage`, `humanize_seconds` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-lifecycle
```

The event names are frozen: subscribers match on them. Add a stage or event by
extending the ladder and `LIFECYCLE_EVENT_TYPES` together, and check the
storage watermark tests (`crates/storage/tests/lifecycle_watermarks.rs`), which
test the schema against this crate's enum.

## Related

- [ADR 0074](../../docs/adr/0074-expiry-lifecycle-hooks.md) — expiry lifecycle hooks
- [ADR 0121](../../docs/adr/0121-durable-authority-invalidation-fencing.md) — durable authority invalidation fencing
- [ADR 0080](../../docs/adr/0080-security-event-hooks.md) — security-event hooks
- [`docs/architecture/general-authority.md`](../../docs/architecture/general-authority.md)
