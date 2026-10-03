# @opensesame/log-scrub

The secret scrubber every log line, event, audit row, telemetry property and
error string passes through (ADR 0156). It is compiled from
[`spec/log-scrub/log-scrub.json`](../../spec/log-scrub/log-scrub.json), which
[`crates/redaction`](../../crates/redaction) reads too: the rule set and its
test vectors are written once, and each plane runs every vector.

## Where it fits

- **Used by:** `@opensesame/observability` (the pino logger), `@opensesame/audit`,
  `@opensesame/telemetry`, `@opensesame/wallet-consent`, `@opensesame/support-agent`,
  `@opensesame/sdk-cli`, `@opensesame/app-core` (the activity log, duress alert
  outbox) and the Identity API's error handling.
- **Builds on:** [`@opensesame/os-domain`](../os-domain) for boundary guards. No
  Node built-ins, so it runs in a browser and in a bare V8 isolate.

## Surface

| Export | What it does |
|---|---|
| `scrubText(text)` | Rewrites every secret the text carries: PEM blocks, DSN passwords, `#token=` and `?code=` parameters, `label: value` pairs, cookie headers, bearer and DPoP credentials, JWTs, `osc_*` tokens, vendor keys. Idempotent. |
| `scrubValue(value)` | A deep copy with sensitive keys censored (`accessToken`, `x-api-key`, `db_password`), every string scrubbed, errors flattened, binary replaced, cycles and depth cut. |
| `isSensitiveKey(key)` | Whether a key is named like a secret. `tokenType` is not; `accessToken` is. |
| `REDACTED` | The marker, `[REDACTED]`. |

Scrubbing needs no knowledge of the secret, only its shape, so it cannot itself
become a place a secret is kept. It is best effort against arbitrary prose: an
unlabelled, unprefixed random string is not recognisable. The rule for that
case is upstream: never put a secret in a message. Log an id.

## Develop

```bash
pnpm --filter @opensesame/log-scrub test
```

Add a shape by adding a rule and a vector to the spec; the Rust side picks it up
on the next build and its test fails until it agrees.
