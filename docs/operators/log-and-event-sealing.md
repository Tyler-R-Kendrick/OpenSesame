# Logs and events at rest

Logs and event rows carry no secrets and rest sealed
([ADR 0157](../adr/0157-logs-and-events-carry-no-secrets.md)). This page is what an
operator sets, what refuses to start, and how to read a sealed log.

## What is sealed, and under what

| What | Where | Sealed under |
|---|---|---|
| Host, worker, daemon and TypeScript-service **log lines** | the file `OPENSESAME_LOG_FILE` names (replaces stdout) | a 32-byte log key: `<log>.key`, or `OPENSESAME_LOG_KEY_FILE` |
| The **daemon's** log | `~/.opensesame/daemon.log` (`OPENSESAME_DAEMON_LOGFILE`), set by `opensesame daemon start` | `daemon.log.key` beside it |
| **Host event rows** (SQLite): outbox, security deliveries, connection events, signing events, approval comments, runner steps, intents, invocations, receipts | the Host database | a key derived from `OPENSESAME_CONNECTION_KEY` |
| **Identity-plane event rows** (Postgres): audit metadata, outbox, webhook and notification delivery payloads | the Identity database | a key derived from `OPENSESAME_EVENT_KEY`, else from `OPENSESAME_CLAIM_PEPPER` |

Ids, timestamps, event types, states and counters stay readable: queues and
operator queries need them. Failure text (`lastError`) is scrubbed of secrets
rather than sealed.

## What refuses to start

| Condition | Result |
|---|---|
| `OPENSESAME_LOG_FILE` is set and the file or key cannot be opened, created or read (a key is never re-created beside a log that already holds sealed lines) | the process exits; it never logs to stdout or a plaintext file instead |
| A networked or production Host has no `OPENSESAME_CONNECTION_KEY` | `host run` refuses; a development Host stores events unsealed and logs a warning |
| A persistent Identity database has neither `OPENSESAME_EVENT_KEY` nor `OPENSESAME_CLAIM_PEPPER` | the control plane and the worker refuse |
| `OPENSESAME_EVENT_KEY` is under 32 characters | the control plane refuses |
| A Host with `OPENSESAME_CONNECTION_KEY` finds a Host event value (see "What is sealed, and under what") that is not a current `osev2.` envelope, and `OPENSESAME_ALLOW_LEGACY_SECRET_MIGRATION` is not `true` | `host run` refuses (see "One-time trusted legacy import") |
| A sealed event does not open (wrong key, altered row) | a read is an error naming the column, never an empty event or ciphertext; in a queue claim the one row is quarantined (below) and the rest go on |
| The audit trail's newest row does not open | appends fail until it can be read; the chain is never restarted at genesis |

## Keys

- **Log key.** Created on first use, owner-only, beside the log unless
  `OPENSESAME_LOG_KEY_FILE` points elsewhere. Point it at a secret mount, not at a
  file on the same volume as the log, if the log volume is what gets copied.
- **Event keys** come from secrets the deployment already holds, by HKDF, so
  there is nothing new to provision. `OPENSESAME_EVENT_KEY` keeps the event key
  apart from the claim pepper. **Changing either is not rotation.** Events
  already sealed stay sealed under the old key, there is no re-seal path yet,
  and under the new key they do not open (see "Unreadable rows"). Pick the key
  before the first event and keep it.
- **Every replica must share the same secret.** A replica with another pepper or
  key cannot open the events another wrote.
- **A key is backed up like any other secret.** Losing it makes the sealed logs
  and events it sealed unreadable. That is the design.

## Unreadable rows

A sealed value that does not open (the key changed, or the row was altered) is
quarantined, not retried, so one such row cannot stall a queue:

- **Host outbox and security deliveries.** The row is marked dead (the outbox row
  published, the delivery `dead_lettered`) with `last_error = unreadable: sealed
  value did not open`; the sealed value is left as it was, and a warning names
  only the row id. With no sealing key installed at all nothing is quarantined:
  the claim fails, so a missing key at start-up cannot dead-letter a queue.
- **Identity outbox, webhook and notification deliveries.** The same, through
  the queue's own columns (`published_at` and `last_error`, `dead_at`, or
  `state = dead`).
- **A read** (a listing for an operator or an approval) of a row that does not
  open is an error, never an empty value. That includes the audit trail, whose
  newest row also seeds the hash chain: appends fail while it cannot be read,
  rather than start a new chain at genesis.

Restoring the original key makes quarantined values readable again; the rows stay
dead until an operator clears the failure.

## What sealing does and does not prove

Sealing is **confidentiality of event values at rest**: a copied database, a
backup or a read-only account reads no event. It is not whole-database tamper
evidence. A current (`osev2.`) envelope authenticates the column and, where the
value has them, its owner and its row: the Host binds a tenant-owned value to
its organization and row identity, and the Identity plane binds the record id
under a scope (organization, principal, or the outbox event's aggregate). A
sealed value copied into another row or another customer therefore does not
open. A Host value written without an owner (some outbox payloads, for example)
is bound to its column alone, so the seal would not notice two such values
swapped. Tamper evidence for the rows as a whole comes from elsewhere: the audit
chain's digests cover the Identity plane's audit rows, and signed receipts cover
the Host's receipts. Other event columns have no such cover. ADR 0157 recorded
the earlier column-only binding as a limitation.

## Reading a sealed log

```bash
opensesame daemon logs                      # the daemon's ~/.opensesame/daemon.log, last 40 lines
OPENSESAME_DAEMON_LOGFILE=/var/log/opensesame/host.log \
OPENSESAME_LOG_KEY_FILE=/run/secrets/log-key \
  opensesame daemon logs                    # any sealed log, TypeScript services included
```

A line that does not open under the key reads `[sealed line: not readable with
this key]`. `daemon logs` never creates a key.

## Upgrading

When a log file is opened, lines an older build wrote in the clear are scrubbed
and sealed in place (and a file left world-readable is narrowed to 0600), and
sealed lines of an older format are rewritten as current ones. When the Host
starts, failure text an older build stored unscrubbed (`last_error`,
`status_detail`) is scrubbed in place; this needs no key and is idempotent.

Event rows are different. Normal startup does not seal rows an older build
wrote in the clear or under the earlier `osev1.` format: the Host and the
Identity plane refuse them, and importing them is the one-time step below. On
the Host, a legacy plaintext value that begins with `osev` is taken for a sealed
one and the import refuses it as unreadable.

Rolling back to a build before this change reads a sealed log or event as
corrupt data.

### One-time trusted legacy import

Ordinary Identity control-plane and worker startup validates existing current
secret envelopes. It refuses plaintext or `osev1` event records and legacy
secret/session/OIDC records rather than assigning them to the current row's
customer again. A failed validation does not rewrite the rejected record.

When upgrading a database from a release that stored legacy records, first
verify the database's provenance and ownership metadata from a trusted backup.
Set `OPENSESAME_ALLOW_LEGACY_SECRET_MIGRATION=true` for the upgrade startup to
import those records into customer- and record-bound envelopes. Remove the flag
immediately after the import completes and restart normally. The flag is an
operator assertion of trusted legacy ownership, not a way to recover missing
keys or authenticate ownership from legacy ciphertext. Never leave it enabled
for routine restarts: saved legacy ciphertext does not bind a customer and must
not be imported again under changed ownership metadata.
