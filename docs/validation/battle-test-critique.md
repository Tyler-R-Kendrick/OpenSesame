# Battle-test critique (2026-08-07)

## Coverage before

~33 unit tests. Broker had **zero** integration tests. No idempotency, cross-org, or receipt-lookup adversarial coverage.

## Coverage after

**105 tests, 0 failures** across domain/authn/authz/broker/storage/crypto/claims/connector-host/rotation/audit/redaction.

Run: `./scripts/battle-test.sh`

## Bugs found under fire (runtime-proven)

| ID | Finding | Evidence | Fix |
|----|---------|----------|-----|
| A | Idempotent retry re-executed side effects / FK-crashed | `existing_found:true, will_reexecute:true` then FK 787 | Return prior receipt; never re-insert intent |
| B | Cross-org grant+intent allowed | `org_match:false` then `outcome:Succeeded` | Reject `OrganizationMismatch` before quorum/idempotency |
| test | Multi-level grant fixture violated depth max | unit assertion | Corrected fixture (not a product bug) |

## Remaining gaps (honest)

- No live Keycloak/OpenBao/OpenFGA container conformance (no Docker here)
- No Playwright extension suite
- No Wasmtime guest component load tests (host mock only)
- No fuzz corpus persistence / cargo-fuzz CI yet
- Gateway HTTP surface not fully covered by hyper test server suite
- Property tests exist only lightly (proptest available; expand next)

## Security critique summary

Strengths now enforced in tests: grant attenuation matrix, availability fail-closed, SSRF host deny, unsigned component deny, E2EE wrong-key/AD/version, claim replay, receipt tamper, secret redaction nesting, broker org boundary, idempotent receipts.

Weaknesses still real: authority plane is memory/SQLite locally; policy engine is in-process not remote OpenFGA; connectors beyond mock are scaffolds.
