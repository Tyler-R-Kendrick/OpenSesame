# Audit 2026-09-28 — Secrets in logs, events and error text

Scope: every place either plane writes a log line, an event, an audit row, an
activity entry, a telemetry property or a persisted failure. Decision:
[ADR 0157](../../adr/0157-logs-and-events-carry-no-secrets.md).

## Method

A read-only inventory of both planes' sinks (what each scrubs, by key or by
value, and whether it rests sealed), then each gap reproduced with a secret
placed where a caller could plausibly put one: in a message, in an error, in a
URL, under an unlisted key.

## Findings

1. **High — the Host's log pipeline had no redaction.** Every sink (the Host's
   JSON stdout, the daemon's log file, the worker, the NATS auth bridge — which
   honours `RUST_LOG`, so an operator can raise it to `debug`) depended on each
   call site remembering. A library error that echoed a URL with a token went
   straight to the collector.

2. **High — secrets with no key to name them passed every redactor.** Both
   planes matched key names (`access_token`, `password`). A bearer in a message,
   a claim link whose fragment is the bearer, a JWT in a stack trace, a
   `postgres://user:pw@host` DSN and a PEM block were not recognised.
   `crates/redaction` matched `label: value` on a fixed label list only; it
   missed `session_token`, `x-api-key` and every unlabelled shape.

3. **High — persisted failures carried the endpoint URL.** A security hook's
   endpoint may hold a token in its query; the transport error names it, and
   that text was stored on `security_deliveries` and `security_hooks` and
   logged, unscrubbed.

4. **Medium — TypeScript sinks scrubbed keys only.** The pino logger did not
   scrub message strings or `err.message`/`stack`; audit metadata's
   allowlisted free-text keys (`note`, `reason`, `path`, `issuer`) were
   truncated, not scrubbed, and `actorId`/`targetId` skipped redaction; the
   client activity log's `summary` and `targetId`, the duress alert outbox's
   persisted `lastError`, the wallet export, the CLI's stderr and four
   entry-point `console.error(err)` calls (which bypass the logger and can echo
   a database DSN) had none.

5. **Medium — security notices, receipts and Debug.** `SecurityNotice`'s payload
   fence was top-level only and its free text unscrubbed; receipts were checked
   for eight key substrings but not for secrets in values; six structs
   derived `Debug` over a plaintext secret (`OpenBaoHttpAuthority.token`,
   `InstallationToken` twice, `CallbackConfig.secret`, `TokenResponse`,
   `IssuedCert.private_key`, `BitwardenKeyRotation`). None was logged at the
   time; nothing stopped a `{:?}`.

6. **High — event rows and log files rested in the clear.** The Host's SQLite
   file held its outbox, security deliveries, connection events, signing events
   (command line, host, OS user, address), approval comments, runner steps and
   receipts as plaintext JSON and text; the Identity plane's Postgres held audit
   metadata and the outbox and delivery payloads the same way; `daemon.log`
   was an append-only plaintext file, world-readable if it pre-dated the mode
   fix, with no rotation, and `daemon logs` printed it raw. A copy of any of
   them read the history.

## Fix

- One rule set, `spec/log-scrub/log-scrub.json`, compiled by
  `@opensesame/log-scrub` and `crates/redaction`; both run every vector.
- `ScrubWriter` on every Rust log sink; the pino logger scrubs every argument.
- `SecurityNotice::scrubbed()` at `dispatch`, receipts scrubbed before signing,
  `appendAuditEvent`, the activity log, the duress outbox, telemetry, the
  wallet export and the CLI's errors scrubbed.
- Delivery failures drop the URL and are scrubbed before they are stored.
- The six structs print `[REDACTED]`.
- `pnpm quality:log-hygiene` counts the ways round the logger; the ledger only
  falls.
- Logs and events rest sealed (ADR 0157 items 7–9): an encrypted, rotating,
  owner-only log file for the Host and the TypeScript services
  (`OPENSESAME_LOG_FILE`; the daemon's by default); sealed event rows in Postgres
  and SQLite under keys derived from secrets the deployment already holds;
  existing rows and files sealed in place; a networked or production Host and a
  persistent database refuse to start with no key.

## Verification

- 70 TypeScript and 16 + 2 Rust vector and pipeline tests, including a real
  `tracing` subscriber through the scrubbing writer in text and JSON
  (`crates/redaction/tests/tracing_sink.rs`), and linear-time tests on
  adversarial input for every rule.
- A regression test for each sink changed: pino (message, error, unlisted key,
  interpolation), audit, activity log, outbox, telemetry, receipts,
  `SecurityNotice`, delivery failure text, the six `Debug` impls.
- `scripts/lib/log-hygiene.test.mjs` proves the gate fails on a new bypass.

- Sealed-log format vectors: `crates/sealed-log` and `packages/observability`
  open the same lines. A real `opensesame daemon start` was run: the file is
  mode 0600 with no plaintext in it, the key file and pidfile are 0600, a
  plaintext log from an older build was sealed and scrubbed, and
  `daemon logs` reads it back.
- Event rows are read from the table itself, not the API: PGlite (real
  Postgres) for the audit trail, the outbox on both paths and the delivery
  queues, with the hash chain verifying; the real SQLite schema for the
  outbox, security deliveries and runner steps; a legacy sweep test; and a
  sealed value with no sealer or the wrong key is refused.

## Residual risk

- Recognition is by shape. An unlabelled, unprefixed random string in a message
  is not recognisable; the rule stays "log an id".
- Free text a person types (an approval comment, a signing command line) is
  scrubbed by shape only where it is logged, and sealed where it is stored.
- Sealing protects a copied file, a backup, a snapshot and a read-only
  account. Whoever holds the process, or a sealed file and its key together,
  reads it.
- **Not events, and not covered here:** credentials Postgres keeps in columns
  of their own: `oidc_payloads.payload` (sessions, codes, refresh tokens),
  `better_auth_accounts` tokens and password hash, `better_auth_sessions.token`,
  `webhook_endpoints.secret`, `byo_upstreams.client_secret`,
  `organizations.sso_client_secret`, `org_ldap_config.service_bind_secret` and
  `push_subscriptions.auth_secret`. They are plaintext at rest today and are the
  next thing to seal.
