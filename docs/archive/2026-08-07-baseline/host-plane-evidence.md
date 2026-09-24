# Validation Evidence

**Date:** 2026-08-07  
**Host:** WSL2 aarch64, Rust 1.88.0, no Docker daemon

## Unit tests (executed)

```bash
cargo +1.88.0 test --lib \
  -p opensesame-domain -p opensesame-authn -p opensesame-authz \
  -p opensesame-redaction -p opensesame-human-vault \
  -p opensesame-connector-host -p opensesame-rotation \
  -p opensesame-audit -p opensesame-storage
```

Observed: **33 passed, 0 failed** (human-vault Argon2 tests ~7s).

Coverage includes: ID opacity, grant attenuation, availability matrix, device flow slow_down, auto→device in devcontainer, audience rejection, tenant isolation, export default-deny, quorum fail-closed, SSRF host deny (169.254/localhost), unsigned component reject, E2EE round-trip / wrong-AD / password wrap / PRF domain separation, receipt sign/verify, redaction, rotation verify-before-revoke path, SQLite migrations.

## End-to-end (executed)

Gateway on `127.0.0.1:18787` with SQLite file DB.

| Step | Result |
|------|--------|
| Device authorize + approve + token | `login_ok`; session opaque handle; no refresh_token field |
| Invoke `repository.read` | `outcome=succeeded`; signed receipt |
| Receipt verify | `{"valid": true}` |
| Agent claim + narrow actions | `state=claimed` |
| Claim token replay | `409 already_completed_or_invalid` |
| Authority quorum loss | invoke `403` A3 fail-closed |
| Claim widen attempt (`admin.destroy`) | `400 cannot_widen_grant` |
| CLI `doctor` / `whoami` | OK |
| CLI `login --flow auto --no-browser` with `DEVCONTAINER=1` | selected Device; completed; **no device_code in CLI output or gateway logs** |

## Not executed in this environment

- Three-node HA failure injection (no Docker)
- Live Keycloak / OpenBao / OpenFGA containers (Compose manifests provided)
- Chromium Playwright extension suite (extension scaffold present; needs browser CI)
- Full Wasmtime guest component load (host capability + in-process mock connector validated)

## AuthorityHandle / ConnectionRef (ADR 0005)

Executed with `OPENSESAME_DEBUG_RUN=live-manual` against **live** OpenFGA + OpenBao (user-space binaries in `.tools/bin`, no root required):

| Check | Result |
|-------|--------|
| OpenFGA health + demo connection check | allow `user:demo`, deny `user:attacker` |
| OpenBao health + KV put; bearer materialize | `AuthorityError::Denied` |
| Gateway `/health/providers` | openfga+openbao configured; `secret_ref_agent_facing:false` |
| `GET /api/v1/connections` | `conn://…` only |
| L1 invoke via `connection_ref` | `outcome=succeeded`, `credential_bytes_returned=false` |
| L3 / `credential.resolve` | HTTP 403 `materialize_denied` |
| `./scripts/battle-test.sh` | **ALL BATTLE TESTS PASSED** |
| `./scripts/live-stack-test.sh` | native deps + gateway path |

Prior host bug: L3 returned `InvokeLevelDenied` before `MaterializeDenied`. Fixed by denying materialize/resolve at the host boundary first.

**Note:** Docker Engine install requires elevated privileges (`sudo` askpass was denied in this environment). Equivalent live verification uses downloaded OpenFGA/OpenBao arm64 binaries via `scripts/start-native-deps.sh`.

## Honest availability

Single-process SQLite profile does **not** tolerate host failure for authority operations. Three-voter Compose/k3s profile is documented for one-node failure tolerance when operators run it.
