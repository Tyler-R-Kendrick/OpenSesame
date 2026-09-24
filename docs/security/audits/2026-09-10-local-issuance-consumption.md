# Mandatory one-use local application issuance

The earlier issuance transaction-binding review left an internal compatibility
path that accepted no consumed request. A regression using a valid passkey
session confirmed that path returned a code without a bound approval. A second
regression submitted the same consumed request concurrently to issuance and
observed two successful codes.

The common person/agent issuance function now refuses missing references and
always validates the persisted consumed approval. It records `codeIssuedAt` in
the encrypted request ledger under the existing cross-tab directory/session
lock before returning a code. Repeated calls, including calls with a refreshed
ledger reference, fail. An interrupted issuance after that durable write leaves
the approval spent; recovery requires a fresh request and passkey decision.

The new optional record field is admitted only for consumed, transaction-bound
requests and must fall between consumption and expiry. Existing records remain
readable. Older builds strictly reject records containing the new field; do not
strip it or downgrade the ledger to reopen spent authority.

Authorization test helpers now create, approve with the real fixture passkey,
and consume requests rather than bypassing that lifecycle. Negative tests still
exercise substituted actors, handles, agent keys, claims and PKCE material with
an actual consumed reference. The capacity test retains all 128 authorizations;
its timeout is 30 seconds because those operations now perform real cryptography
and encrypted persistence. Explicit clock-rollback tests remain.

This closes the two tested internal issuance paths. It does not make a browser
window a network OIDC server, defeat malicious same-origin code, or establish
completion of the broader browser-local IAM assignment.

Validation on the integrated working tree:

- Six Pages authorization/request/agent suites: 76 tests passed. The final
  request-authorization rerun passed 14 tests, including the subsequently added
  interruption-after-persistence regression.
- Shared contracts: all 48 tests passed.
- All 14 desktop/mobile browser-local IAM journeys passed on the rebuilt
  bundle, including real person/agent consent and relying-party revocation.
- Pages build/typecheck, scoped Biome/anti-slop, structural quality and
  `git diff --check` passed. No quality baseline was increased.
