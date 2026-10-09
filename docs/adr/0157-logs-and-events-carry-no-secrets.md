# ADR 0157 — Logs and events carry no secrets, and rest sealed

- Status: Accepted
- Date: 2026-09-28
- Implementation: the body names the first formats. New event values are now
  `osev2.` envelopes (a random data key per value, wrapped under a purpose- and
  customer-derived key; `crates/event-seal`,
  `packages/database/src/event-seal.ts`) and log lines are `osl2.`
  wrapped-key envelopes (`crates/sealed-log`); `osev1.` and `osl1.` are the
  legacy formats, kept for migration and compatibility reads.
- Builds on: [ADR 0080](0080-security-event-hooks.md) (every security fact is
  a `SecurityNotice`), [ADR 0139](0139-one-definition-every-target.md) (one
  definition, every target), [ADR 0149](0149-nothing-stored-in-the-clear.md)
  (nothing the client stores rests in the clear), [ADR 0032](0032-connection-broker-service-integrations.md)
  (the Host sealing key)
- Amends: ADR 0080 — the notice envelope scrubs its own text and payload

## Context

Redaction existed, per package, and matched **key names**: `access_token`,
`password`, `client_secret`. A secret with no key to name it went straight
through, and that is most of how secrets leak into logs:

- an error message: `connect postgres://app:hunter2@db/x refused`, or
  `POST https://hook.example/x?token=… failed`;
- a URL in a message: a claim link whose fragment is the bearer
  (`#token=osc_clm_…&key=…`), an OAuth callback (`?code=…&state=…`);
- a compact JWT in a stack trace, a bearer in a copied header, a PEM block;
- a value under a key nobody listed (`upstream`, `detail`, `note`).

A survey of both planes found the same gap in every sink: the pino logger
(message strings and `err.message` were never scrubbed), the audit trail
(allowlisted free-text keys were only truncated), the client activity log
(`summary` and `targetId`), the duress alert outbox (`lastError` kept
`err.message`), telemetry, the CLI's stderr; and, on the Host, **no
redaction layer on the log pipeline at all** — every sink relied on each call
site remembering. Persisted delivery failures carried the endpoint URL, and
with it any token in its query. Six structs derived `Debug` over a plaintext
secret. `crates/redaction` recognised `label: value` only, so `session_token`,
JWTs, `osc_` tokens and PEM blocks were invisible to it.

## Decision

1. **One scrubber, written once.** `spec/log-scrub/log-scrub.json` is the
   definition: nine ordered value rules (PEM, DSN userinfo, secret URL
   parameters, cookie lines, labelled values, bearer/DPoP, JWT, our own token
   shapes, vendor key shapes), the key-name rule, and a vector table with
   negative controls (`token_type=Bearer` and `the bearer of bad news` must
   survive). `@opensesame/log-scrub` (TypeScript) and `crates/redaction`
   (Rust) each compile it and run every vector, so a rule is added once and
   the other plane fails its test until it agrees (ADR 0139).
2. **Two layers.** The *key* layer censors the value under a sensitive key at
   any depth (`accessToken`, `x-api-key`, `db_password`; not `tokenType`).
   Booleans and nulls are kept, so `hasPassword: true` stays legible. The
   *value* layer rewrites text that carries a secret by its shape. Scrubbing
   is idempotent, value-blind (it never needs to know the secret) and linear
   on adversarial input, which a test pins.
3. **Scrub at the sink, not at the call site.**
   - *Rust logs:* every `tracing` subscriber writes through `ScrubWriter`,
     which scrubs whole lines; JSON lines are decoded and scrubbed field by
     field, so escaped quotes and nested documents hide nothing. It is
     installed on the Host, the worker, the daemon, the CLI's stderr and the
     NATS auth bridge, and holds whatever `RUST_LOG` an operator sets.
   - *TypeScript logs:* the pino logger scrubs every argument to a log call,
     the message string and interpolation values included, and flattens
     errors to scrubbed plain objects.
   - *Events:* `SecurityNotice` scrubs its label, summary, detail and subject
     id and walks its payload recursively; `dispatch` publishes the scrubbed
     notice, so the bus, the delivery ledger and every sink see one clean
     copy. `appendAuditEvent` scrubs allowlisted free-text values before it
     truncates them, and the id fields. Receipts are scrubbed before the
     signature is taken, so the signature covers what is stored. The client
     activity log and the duress outbox scrub what they keep.
   - *Persisted failure text:* a delivery failure never carries the endpoint
     URL (`reqwest::Error::without_url`) and is scrubbed before it is cut and
     stored.
4. **Refuse loudly where refusal is the contract.** `forAgent` still throws
   on a credential marker (PEM, `secret://`); it scrubs by shape only what
   passes that check. Telemetry drops a value shaped like a credential whole.
5. **Debug never prints a credential.** The six structs that derived `Debug`
   over a plaintext secret print `[REDACTED]`, each with a test.
6. **The ways round it are counted.** `pnpm quality:log-hygiene` counts
   `console.*`, a hand-built `pino(...)` and a tracing subscriber without the
   scrubbing writer in production code. A file or kind with no entry is
   allowed zero, and a recorded number only falls. The one sanctioned
   last-resort print is `console.error(describeError(err))`.

## Decision: what a log or an event leaves behind rests sealed

Scrubbing removes what a secret looks like. What a log line and an event row
*say* (who unlocked, which certificate, what a webhook carried, what a person
typed in an approval comment) is not a secret and is still nobody's business
who copies the file, so it rests sealed too.

7. **Logs a process writes for itself.** `OPENSESAME_LOG_FILE` names a file every
   log line of the Host, the worker, the daemon and the TypeScript services is
   sealed into, and it replaces stdout. Each line is sealed on its own,
   `osl1.` + base64url(24-byte nonce ‖ XChaCha20-Poly1305 ciphertext and tag),
   so a torn write costs one line and rotation needs no re-encryption. The key
   lives apart from the file: `<log>.key` (mode 0600, published atomically) or
   `OPENSESAME_LOG_KEY_FILE`, which an operator points at a secret mount. Files
   are owner-only and a wider one is narrowed; rotation is 8 MiB × 3 whole
   files. A plaintext log an older build wrote is scrubbed and sealed in place
   when the file is opened. A configured sealed log that cannot be opened or
   keyed **refuses to start** the process; it never falls back to a plaintext
   file or the console. `opensesame daemon start` uses it for the daemon it
   launches (so `~/.opensesame/daemon.log` is sealed, and its pidfile private),
   `opensesame daemon logs` reads it, a panic and a fatal startup error are
   routed through the logger and scrubbed. The format is one definition:
   `crates/sealed-log` and `packages/observability` (`sealed-log.ts`) open the
   vectors in `spec/conformance/sealed-log-vectors.json`.
8. **Event rows on the Identity plane (Postgres).** The audit trail's
   metadata and the outbox, webhook and notification delivery payloads are
   sealed before they reach a row: AES-256-GCM, the column named in the
   associated data, stored as `{"$sealed": "osev1.…"}` in the same jsonb column,
   so the schema and every query that does not read the payload are unchanged.
   A decorator (`withSealedEvents`) covers both ways into the outbox
   (`outbox.append` and `uow.appendOutbox`) and opens what it lists, so the audit
   hash chain, taken over the plaintext before it is appended, verifies as
   before. The key is derived by HKDF from `OPENSESAME_EVENT_KEY`, else from the
   claim pepper the deployment already requires; a persistent database with
   neither **refuses to start**. A sealed payload that does not open throws, and
   is never read as empty, except in a queue claim, where the one row is
   quarantined (item 11). Existing rows are sealed in place at start-up.
9. **Event rows on the Host (SQLite).** The outbox, security deliveries,
   connection events, signing events (command, host, OS user, address),
   approval comments, runner steps, intents, invocations and receipts are sealed
   (XChaCha20-Poly1305, `osev1.` text in the same column) under a key derived by
   HKDF from the Host sealing key, `OPENSESAME_CONNECTION_KEY`. One sealer is
   installed for the process before anything writes an event
   (`opensesame-event-seal`), because free functions inside transactions write
   these rows. A networked or production Host with no sealing key **refuses to
   start**; a development Host stores events unsealed and says so. A sealed value
   with no sealer is an error, never ciphertext handed on as the event; one that
   does not open under the installed key is an error on a read and is
   quarantined in a queue claim (item 11). Existing rows are sealed in place at
   start-up, by the exact, case-sensitive `osev1.` prefix the read path uses, and
   failure text an older build stored unscrubbed (`last_error`, `status_detail`)
   is scrubbed in place then too.
10. **Failure text is scrubbed, not sealed.** `lastError` and delivery errors are
    text an operator reads, and the outbox reuses `lastError` as a claim token
    that SQL compares, so they are scrubbed by shape (item 3).
11. **One unreadable row does not stall a queue.** A claim loop that failed its
    whole batch on a row that will not open (the key changed, the value was
    altered) would fail again on every tick and hold every newer row behind it.
    The outbox and delivery claims (Rust and TypeScript) instead quarantine that
    row on its own: it is marked dead through the table's existing failure
    columns with the value-free reason `unreadable: sealed value did not open`,
    its sealed value is left untouched, and the rest of the batch goes on. With
    no sealer installed on the Host nothing can open, so that stays an error and
    dead-letters nothing. The audit trail is the exception: a listing, and the
    hash chain's read of its newest row, fail with an error rather than skip the
    row, because a chain restarted at genesis would detach every later event.
    Changing the key is therefore not rotation (see below).

Left readable on purpose: ids, timestamps, event types, states and counters,
which every queue and every operator query needs.

## What this does not do

- It recognises secrets by shape. An unlabelled, unprefixed random string in
  a message is not recognisable. The rule upstream stays: never put a secret
  in a message; log an id.
- The device-flow CLI prints a `user_code` on purpose, for a person to type.
  Its own key policy stands; only the value layer applies to it.
- Free text a *person* types (an approval comment, a signing command line) is
  scrubbed by shape only where it is logged; where it is stored it is sealed.
- **Sealing is confidentiality of an event value at rest, not row-level
  integrity.** The associated data names the table and column, not the row, so
  an attacker with database write access and no key cannot read or forge a
  value but can copy a sealed value from one row into another of the same
  column, or swap two rows' values, and neither is detected by the seal. What
  does detect tampering is separate: the audit chain's digests cover the
  Identity plane's audit rows, and signed receipts cover the Host's receipts.
  The other event columns have no such cover. Binding a value to its row (its
  id in the associated data) is a recorded limitation, not part of this
  decision, because it changes the sealed format and needs a re-seal path first.
- Someone who holds the process's memory, or both a sealed file and its key,
  reads it. Sealing protects a copied file, a backup, a snapshot and a
  read-only database account; it is not a defence against the host.
- Losing the key makes sealed logs and events unreadable. That is the design; a
  key is backed up like any other secret. Changing a key is the same thing:
  there is no re-seal path yet, so **key rotation is not supported**. Rows
  sealed under the old key are unreadable under the new one and, in a queue,
  are quarantined (item 11).
- Credentials that Postgres holds in columns of their own (the OIDC provider's
  stored sessions and refresh tokens, Better Auth's account tokens, webhook
  signing secrets, upstream client secrets) are not events and are out of this
  decision. They are recorded in the audit note as residual.

## Consequences

- Marker unification: the TypeScript logger's `[Redacted]` is now
  `[REDACTED]`, the marker the Host and the agent guard already used.
- `SENSITIVE_KEY_PATTERN` is replaced by `isSensitiveKey` (suffix-based, so
  compound and camelCase names are caught; exact `code` and `state` are not
  sensitive keys, because error codes are diagnostic).
- `SecurityNotice` and receipts are scrubbed on the way *in*; the stores then
  seal what they hold. A value scrubbed away is gone from both.
- A Host with no sealing key was, until now, a Host that could start. A
  networked or production one no longer can, which is a deployment change; the
  error names the variable.
- A URL parameter named `code`, `state`, `key` or `sig` is scrubbed wherever
  it appears in text. That over-scrubs a harmless `?key=sort` and is chosen
  over the alternative.
