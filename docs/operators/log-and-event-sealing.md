# Logs and events at rest

Logs and event rows carry no secrets and rest sealed
([ADR 0155](../adr/0155-logs-and-events-carry-no-secrets.md)). This page is what an
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
| `OPENSESAME_LOG_FILE` is set and the file or key cannot be opened, created or read | the process exits; it never logs to stdout or a plaintext file instead |
| A networked or production Host has no `OPENSESAME_CONNECTION_KEY` | `host run` refuses; a development Host stores events unsealed and logs a warning |
| A persistent Identity database has neither `OPENSESAME_EVENT_KEY` nor `OPENSESAME_CLAIM_PEPPER` | the control plane and the worker refuse |
| `OPENSESAME_EVENT_KEY` is under 32 characters | the control plane refuses |
| A sealed event does not open (wrong key, altered row) | an error naming the column; never an empty event or ciphertext |

## Keys

- **Log key.** Created on first use, owner-only, beside the log unless
  `OPENSESAME_LOG_KEY_FILE` points elsewhere. Point it at a secret mount, not at a
  file on the same volume as the log, if the log volume is what gets copied.
- **Event keys** come from secrets the deployment already holds, by HKDF, so
  there is nothing new to provision. Set `OPENSESAME_EVENT_KEY` to rotate events
  independently of claim digests.
- **Every replica must share the same secret.** A replica with another pepper or
  key cannot open the events another wrote.
- **A key is backed up like any other secret.** Losing it makes the sealed logs
  and events it sealed unreadable. That is the design.

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

Nothing to do. When a log file is opened, lines an older build wrote in the clear
are scrubbed and sealed in place (and a file left world-readable is narrowed to
0600); when the Host or the Identity plane starts with a key, event rows an older
build wrote in the clear are sealed in place, once. Both are idempotent.
Rolling back to a build before this change reads a sealed log or event as
corrupt data.
