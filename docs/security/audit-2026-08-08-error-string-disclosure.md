# Audit tick 38 — backend error strings in responses, redaction gaps

Scanners (cargo-audit, ast-grep, semgrep, cve-lite) were clean on `main`
(95f8f30). The findings come from tracing every `e.to_string()` that reaches an
HTTP body.

## 1. `GET /health/ready` echoed the backend error verbatim (unauthenticated)

`authority_quorum_ok()` failures were serialised straight into
`{"status":"not_ready","reason":…}` on a public, unauthenticated endpoint. A
connection failure carries the DSN — `postgres://user:password@host:5432/db` —
plus internal hostnames and ports. The endpoint now answers a stable
`authority_unavailable` code and logs the detail via `tracing::warn!`.

`/health/providers` (operator-gated since tick 25) now runs its OpenFGA /
OpenBao error strings through `redact_text` as well.

## 2. `redact_text` missed the shapes that actually carry secrets

The helper only rewrote `Bearer …`, `device_code=` and `refresh_token=`. It let
through DSN userinfo, `Basic` credentials, JSON `"client_secret":"…"`, and every
other labelled secret (`api_key=`, `user_code=`, `authorization: …`). Hardened
to:

- `scheme://user:pass@host` → `scheme://[REDACTED]@host` (covers the empty-user
  `redis://:pass@host` form).
- `Basic <b64>` alongside `Bearer <token>`.
- Any `label=value` / `label: value` / `"label":"value"` where the label matches
  the secret vocabulary, quote-aware so JSON fragments are censored too.

Innocuous text is left untouched (`authority quorum degraded: 1 of 3 nodes
reachable` round-trips unchanged).

## 3. Gateway invoke / receipt verify leaked upstream detail

- `POST /v1/intents` returned `openfga_unavailable: {e}`; a reqwest transport
  error can embed the store URL and its bearer. Now a bare code, detail logged.
- Parameter-canonicalisation errors and `receipts/{id}/verify` failures now go
  through `redact_text`.

## 4. Identity plane advertised the Host API address

`POST /v1/device/approve` echoed `forwarded_to: <hostApiUrl>` on every response
and `detail: <fetch error>` on failure, handing any authenticated caller —
including a provisional one — the internal Host API host/port and connection
diagnostics. Both fields are gone; the failure is logged through `ctx.log`.

Tests: five new cases in `crates/redaction` (DSN, labelled values, `Basic`,
JSON, no-op). `cargo test --workspace`, `pnpm run test:all`, `pnpm run
typecheck`, clippy and `cargo fmt --check` are clean.
