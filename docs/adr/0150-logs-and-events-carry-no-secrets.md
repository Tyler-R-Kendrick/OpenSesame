# ADR 0150 — Logs and events carry no secrets

- Status: Accepted
- Date: 2026-09-28
- Builds on: [ADR 0080](0080-security-event-hooks.md) (every security fact is
  a `SecurityNotice`), [ADR 0139](0139-one-definition-every-target.md) (one
  definition, every target), [ADR 0149](0149-nothing-stored-in-the-clear.md)
  (nothing the client stores rests in the clear)
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

## What this does not do

- It recognises secrets by shape. An unlabelled, unprefixed random string in
  a message is not recognisable. The rule upstream stays: never put a secret
  in a message; log an id.
- The device-flow CLI prints a `user_code` on purpose, for a person to type.
  Its own key policy stands; only the value layer applies to it.
- Free text a *person* types (an approval comment, a signing command line) is
  scrubbed by shape only.

## Consequences

- Marker unification: the TypeScript logger's `[Redacted]` is now
  `[REDACTED]`, the marker the Host and the agent guard already used.
- `SENSITIVE_KEY_PATTERN` is replaced by `isSensitiveKey` (suffix-based, so
  compound and camelCase names are caught; exact `code` and `state` are not
  sensitive keys, because error codes are diagnostic).
- A URL parameter named `code`, `state`, `key` or `sig` is scrubbed wherever
  it appears in text. That over-scrubs a harmless `?key=sort` and is chosen
  over the alternative.
