# opensesame-redaction

Value-blind redaction of secrets in log lines, error strings and JSON on the
Host / authority plane. It has two functions: one rewrites text so a secret's
label survives and its value does not, and one replaces the value of every
secret-named key in a JSON document. Callers run backend errors and payloads
through it before they reach a log, a receipt or an HTTP response.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (intents, delegations,
  receipts, tasks, health, the KV facade, shared sessions),
  [`opensesame-audit`](../audit), [`opensesame-authn`](../authn),
  [`opensesame-broker`](../broker), and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`redaction`).
- **Builds on:** no workspace crates (`regex`, `serde_json`).

## Surface

| Function | What it removes |
|---|---|
| `redact_text(&str) -> String` | Userinfo in any `scheme://user:pass@host`; `Bearer` and `Basic` credentials; the value of any `key=value` or `key: value` pair whose label looks secret (`password`, `client_secret`, `api_key`, `access_token`, `refresh_token`, `id_token`, `device_code`, `user_code`, `claim_token`, `code_verifier`, `private_key`, `token`, `authorization`, `cookie`, …) |
| `redact_json(&Value) -> Value` | The value of any object key that matches a sensitive name exactly (case-insensitive), at any depth; `token` is sensitive, `token_type` is not |

Both replace with the literal `[REDACTED]`.

## Develop

```bash
cargo +1.88.0 test -p opensesame-redaction
pnpm audit:miri             # runs this crate's tests under Miri
pnpm test:mutation:rust     # src/lib.rs is in the mutation scope
```

`redact_json` matches whole keys only; it does not run `redact_text` over string
values. A new secret-bearing label belongs in both pattern lists, with a test in
[`src/privacy.rs`](src/privacy.rs) or the `tests` module.

## Related

- [ADR 0015](../../docs/adr/0015-audit-vs-diagnostic-logging.md) — audit vs diagnostic logging
- [`docs/security/audits/2026-08-08-error-string-disclosure.md`](../../docs/security/audits/2026-08-08-error-string-disclosure.md)
