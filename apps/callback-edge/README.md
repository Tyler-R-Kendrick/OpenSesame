# opensesame-callback-edge

A narrow ingress on the Host/authority plane for signed provider callbacks.
It verifies a per-connection HMAC over each webhook delivery, checks the
destination against an explicit route list, and records the delivery in a
durable replay ledger. No callback can read a vault or start work: an accepted
delivery is acknowledged with `"forwarded": false` and goes nowhere else.

## Where it fits

- **Used by:** operators who expose a public callback URL. No workspace crate
  depends on it.
- **Builds on:** [`opensesame-host-core`](../../crates/host-core) (listen-address
  policy, deployment-mode classification, security headers) and
  [`opensesame-storage`](../../crates/storage) (`claim_callback_delivery`, the
  replay ledger).
- Forwarding does not exist. Setting `OPENSESAME_CALLBACK_FORWARDING` makes the
  binary refuse to start.
- The OAuth callback route always answers `503`; the real OAuth callback lives
  in the gateway ([ADR 0032](../../docs/adr/0032-connection-broker-service-integrations.md)).

## Surface

Binary `opensesame-callback-edge`, flag `--listen` (default `127.0.0.1:8791`).

| Route | Behaviour |
|---|---|
| `GET /health/live` | `{"status":"ok"}` |
| `POST /webhooks/{connection}/{route}` | Verify, check route, claim delivery; `{"accepted":true,"forwarded":false}` for new or duplicate deliveries, `401` on a signature, route or binding mismatch |
| `POST /oauth/callback/{profile}` | Always `503 callback_refused` |
| anything else | `401 callback_refused` |

A delivery carries `x-opensesame-timestamp` (within 300 s),
`x-opensesame-delivery-id` and `x-opensesame-signature: v1=<base64url>`. The
signature is HMAC-SHA256 over method, path, timestamp, delivery id and body
digest, keyed by HKDF of the master key and the connection id. Bodies are
capped at 256 KiB; query strings are refused.

Required environment (see [`.env.schema`](../../.env.schema)):

| Variable | Meaning |
|---|---|
| `OPENSESAME_CALLBACK_MASTER_KEY` | 64 hex characters (32 bytes) |
| `OPENSESAME_CALLBACK_ROUTES` | Comma-separated `connection/route` pairs, at most 128 |
| `OPENSESAME_CALLBACK_DATABASE_URL` | A durable `sqlite:` URL (no in-memory, no query) |
| `OPENSESAME_CALLBACK_PUBLIC_URL` | Optional; takes part in exposure classification |

## Develop

```bash
cargo +1.88.0 test -p opensesame-callback-edge
cargo +1.88.0 run -p opensesame-callback-edge -- --help
```

Tests in `src/tests.rs` sign real requests and check that every destination
component is bound and that duplicates and route mismatches are handled.

## Related

- [ADR 0032](../../docs/adr/0032-connection-broker-service-integrations.md) — connection broker; OAuth callback moved to the gateway
- [Audit: callback destination binding](../../docs/security/audits/2026-09-08-callback-destination-binding.md)
