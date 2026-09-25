# ADR 0141 — Using NATS fully: delivery semantics, services, mixed-mode callout

- Status: Accepted
- Date: 2026-09-24
- Builds on: [ADR 0042](0042-nats-taskbus-auth-callout-and-xkeys.md) (TaskBus,
  auth callout, xkeys), [ADR 0039](0039-event-driven-github-backup.md)
  (event-driven backup), [ADR 0010](0010-postgres-authoritative-store.md)
  (the outbox is authoritative), [ADR 0132](0132-optional-mtls-and-workload-identity.md)
  (optional mTLS, the callout bridge)

## Context

A review on 2026-09-24 checked each NATS feature OpenSesame relies on — or
could — against what the code actually did. The foundations were sound: the
callout bridge verifies server-signed requests and the Host re-verifies them,
end users are authenticated against any allowlisted issuer's JWKS or a mapped
certificate, `xkv1` sealing works end to end, every Host process runs as a
least-privilege nkey role, and webhooks and backups already follow the
*durable outbox → JetStream wake → consumer* pattern. The gaps were in how
fully the features were used:

1. **Delivery was at most once, and a bad message stalled a consumer.**
   `TaskBus::drain` acknowledged each message before the caller saw it. A
   payload that was not a `BusEvent` made `drain` return an error *before* the
   ack, and the durable had the server default of unlimited redeliveries, so
   one malformed message came back forever.
2. **Publishing was not idempotent.** Neither the Rust adapter nor the TS
   outbox worker set `Nats-Msg-Id`, so an outbox drain that published and then
   failed to mark its row published the event twice.
3. **The stream was unbounded.** `OPENSESAME_EVENTS` had no age, size or
   message limit, and provisioning used get-or-create, so a stream an older
   release made could never pick up new settings.
4. **The Services API was unused.** The callout bridge was a bare queue
   subscription with no discovery or statistics, and it decided callouts one
   at a time: a slow Host round trip held every other CONNECT behind it.
5. **The callout reference profile was neither sealed nor mixed.**
   `ops/nats/secure-callout.conf` did not set `auth_callout.xkey`, and it had
   no static users — the Host's own service roles could not connect to it at
   all, since the callout would demand an end-user token they do not have.

## Decision

### JetStream delivery semantics (`crates/task-bus`, `packages/identity-worker`)

- Every publish carries `Nats-Msg-Id` = the event's `CloudEvents` `id` (the
  outbox row id) and `Nats-Expected-Stream: OPENSESAME_EVENTS`. A retried
  publish inside the stream's two-minute duplicate window is stored once; a
  subject captured by some other stream is a publish error, not a misroute.
- The stream is bounded: file storage, limits retention, discard-old, seven
  days, 1 GiB, 1 MiB per message (`StreamLimits`). The outbox stays the source
  of truth; a consumer that falls outside the window is caught up by the
  outbox tick, as before.
- Durables have explicit redelivery bounds: `ack_wait` 30 s, `max_deliver` 8
  (`Redelivery`). Provisioning creates the stream and durables when they are
  missing and otherwise **fills gaps without overriding**: a limit an older
  release left unbounded (no age, byte or size cap; unlimited redelivery)
  gets the default, and everything an operator set — replicas, storage,
  larger limits, `max_ack_pending` — is kept.
- `TaskBus::process(max, handler)` is the at-least-once path: each message's
  `ack_wait` is restarted (`+WPI`) as its turn comes, the handler runs;
  success is acked with server confirmation (`double_ack`), a failure is
  nak'd with a delay that doubles per delivery (5 s up to 5 min, about ten
  minutes across eight deliveries), and an undecodable payload is terminated
  (`+TERM`) rather than retried. A failure on its last delivery is logged as
  an error and counted in `ProcessReport::exhausted`: the server stops
  redelivering it, so bounded redelivery is a retry budget, not a ledger —
  work that must outlive a longer outage is re-published from its outbox. `drain` keeps its at-most-once contract,
  documented, for wakes whose real work re-reads an outbox — and it now
  terminates poison messages instead of failing the batch. Buses without
  per-message acks (memory) implement `process` by publishing a failed event
  back.

### The callout bridge is a NATS micro service (`crates/nats-callout`)

The bridge registers `opensesame-auth-callout` with one endpoint, `authorize`,
on `$SYS.REQ.USER.AUTH`, in the same queue group every instance already
shared. This adds, without changing the protocol:

- **discovery** — every instance answers `$SRV.PING|INFO|STATS`;
- **observability** — request counts, processing time, and an
  allowed / denied / dropped split in the endpoint's `data`; metadata is
  public only (callout account key, target account, sealed, pinned server
  count);
- **load balancing** — the queue group hands each callout to one instance,
  and each instance decides up to 64 concurrently.

`secure-callout.conf` lets the bridge subscribe `$SRV.>` and answer its
requesters with `allow_responses` — to a requester's inbox and nowhere else.
Operators read it as a separate **observer** user in the callout account
(`OPENSESAME_NATS_NKEY_CALLOUT_OBSERVER`), which may only publish `$SRV.>`
and subscribe its own `_INBOX.>`: reading stats never takes the bridge's
key, which can answer callouts (ADR 0132 §8 binds that key narrowly). When
the bridge's endpoint stops, it stops the service too, so discovery never
lists an instance that no longer decides callouts; a reply that fails to
publish is counted as dropped, not as the decision that never arrived.

### The callout profile is sealed and mixed (`ops/nats`)

- `auth_callout.xkey` is set: requests are sealed to the bridge's curve key
  and replies must be sealed back to the server.
- The Host's service roles (provisioner, host, publisher, consumer, backup)
  are defined once in `ops/nats/opensesame-roles.conf`, included by both
  `secure-client.conf` and `secure-callout.conf`, and listed in
  `auth_callout.auth_users`. Service roles bypass the callout; people and
  agents — from any allowlisted IdP, or a mapped certificate — go through it.
  A service role never depends on an IdP being reachable, and an end user
  never holds a static credential.

## Evaluated and not adopted

| Feature | Why not now |
|---|---|
| JetStream as the webhook or backup ledger | ADR 0010/0039 keep the outbox authoritative. Webhooks already go *verify → outbox → JetStream wake*; the backup actor already consumes `opensesame-backup` wakes. Making JetStream the ledger would create a second source of truth. Generic signed callbacks (`callback_ingress`) are deliberately never forwarded. |
| Sealing TaskBus payloads with xkeys | `seal_event_data` exists and is fuzzed, but bus payloads are metadata by contract (ids, key *names*, versions). Sealing a wake protects nothing. Any future payload that carries sensitive material must be sealed to a recipient key, never the deployment seal key (ADR 0042). |
| Key-Value / Object Store | No state needs them: Host state lives in `SQLite`, Identity state in Postgres. An Object Store as a backup *target* is plausible later, alongside the git targets of ADR 0043. |
| Operator (decentralized JWT) mode | Config-mode callout covers mixed admission; operator mode has different issuer/audience rules and is untested here. |
| A Host-side micro service | Would widen every Host role's subject permissions to answer `$SRV` requests. Consumer lag is already visible via `CONSUMER.INFO`. |
| Membership-scoped callout subjects | Still unimplemented: `project_ids` stay empty until Identity mapping returns memberships, and subjects should then use pairwise or opaque ids (ADR 0042), not canonical principal ids. |

## Consequences

- An outbox row is published once even when marking it fails; one malformed
  message costs one delivery, not a stuck consumer.
- Existing deployments pick up the stream limits and redelivery bounds the
  next time provisioning runs; nothing changes until then.
- Operators can list bridges and read callout statistics with the stock
  `nats micro` tooling, as the observer user.
- A deployment of `secure-callout.conf` must now set
  `OPENSESAME_NATS_CALLOUT_XKEY` (and give the bridge
  `OPENSESAME_NATS_CALLOUT_XKEY_SEED_FILE`), the observer nkey and the five
  role nkeys. The server refuses to start while any is unset; a bridge
  without the seed drops every sealed request with `xkey_required`.
- The backup wake consumer runs on `process`. The rotation consumer still
  reads the shared `opensesame-worker` durable with `drain`; moving it onto
  `process` and a filtered durable of its own is a follow-up, because a
  retried rotation must first be proven idempotent. The TS worker still
  speaks only the plaintext loopback profile.
- `Nats-Msg-Id` deduplicates a re-publish of the same event. The TS outbox
  reuses the row id; Rust producers that build a fresh event per attempt
  (backup wakes, security notices) get no deduplication, and their consumers
  tolerate a duplicate.

## Verification

Real-server suites against the pinned nats-server 2.11.17
(`OPENSESAME_MTLS_FIXTURES=1`):

- `crates/task-bus/src/nats_live_delivery.rs` — duplicate publish stored once,
  nak'd work redelivered and then acked, poison message terminated without
  blocking, a legacy stream converged by provisioning.
- `crates/task-bus/src/nats_live_mixed.rs` — on `secure-callout.conf`,
  provisioner/host/backup connect and use JetStream with zero callouts, while
  an end user is admitted by the sealed callout and an unlisted nkey refused.
- `crates/nats-callout/tests/live_callout_service.rs` — two bridge instances
  discovered by `$SRV.PING`, `INFO` naming the subject, queue group and only
  public metadata, and six CONNECTs split across them with each decided once
  (`$SRV.STATS`: 4 allowed, 2 denied).
