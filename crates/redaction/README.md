# opensesame-redaction

Value-blind redaction of secrets in log lines, error strings and JSON on the
Host / authority plane. It has two functions: one rewrites text so a secret's
label survives and its value does not, and one replaces the value of every
secret-named key in a JSON document. Callers run backend errors and payloads
through it before they reach a log, a receipt or an HTTP response.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (intents, delegations,
  receipts, tasks, health, the KV facade, shared sessions),
  [`opensesame-audit`](../audit), [`opensesame-broker`](../broker),
  [`opensesame-security-events`](../security-events),
  [`opensesame-storage`](../storage), [`opensesame-sealed-log`](../sealed-log),
  [`opensesame-nats-callout`](../nats-callout) (the bridge binary),
  [`apps/cli`](../../apps/cli) (`src/serve.rs`), and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`redaction`).
- **Builds on:** no workspace crates (`regex`, `serde_json`; `tracing-subscriber` only behind the `tracing` feature).

## Surface

The rules are [`spec/log-scrub/log-scrub.json`](../../spec/log-scrub/log-scrub.json)
([ADR 0157](../../docs/adr/0157-logs-and-events-carry-no-secrets.md)), embedded
at build time and read by `@opensesame/log-scrub` too: one rule set, one vector
table, run by both planes.

| Item | What it does |
|---|---|
| `redact_text(&str) -> String` | Rewrites every secret the text carries: PEM blocks, `scheme://user:pass@host` userinfo, secret URL parameters (`#token=…`, `?code=…`), Cookie lines, `label: value` pairs (compound labels such as `session_token` and `x-api-key` included, quoted values and `Authorization: Basic …`), bearer and DPoP credentials, JWTs, `osc_*` and `whsec_` tokens, vendor key shapes. Idempotent. |
| `redact_json(&Value) -> Value` | The value of every sensitive key censored at any depth (`accessToken`, `db_password`; not `tokenType`; booleans and null kept), and every string scrubbed. |
| `is_sensitive_key(&str)` | Whether a key is named like a secret. |
| `ScrubWriter<W>` / `Format` | An `io::Write` that scrubs whole lines on their way to a sink; a JSON line is decoded and scrubbed field by field. |
| `ScrubMakeWriter` (feature `tracing`) | The scrubbing sink for a `tracing_subscriber` fmt layer. The Host, worker, daemon, CLI and NATS auth bridge install it. |
| `MARKER` | `[REDACTED]`. |

## Develop

```bash
cargo +1.88.0 test -p opensesame-redaction
pnpm audit:miri             # runs this crate's tests under Miri
pnpm test:mutation:rust     # src/lib.rs is in the mutation scope
```

`redact_json` censors by whole key and also runs `redact_text` over every string
it keeps. A new secret-bearing label or shape belongs in
[`spec/log-scrub/log-scrub.json`](../../spec/log-scrub/log-scrub.json) (a rule or
a key, with a vector), never in this crate alone; this crate's tests run every
vector, and [`src/privacy.rs`](src/privacy.rs) holds the AT-PRIVACY cases.

## Related

- [ADR 0015](../../docs/adr/0015-audit-vs-diagnostic-logging.md) — audit vs diagnostic logging
- [`docs/security/audits/2026-08-08-error-string-disclosure.md`](../../docs/security/audits/2026-08-08-error-string-disclosure.md)
