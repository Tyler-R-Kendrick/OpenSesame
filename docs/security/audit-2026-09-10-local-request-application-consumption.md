# Local application request consumption — 2026-09-10

Scope: the working-tree browser-local popup, encrypted request decision and
existing PKCE/private application-grant path. No production deployment or model
scanner was exercised. This is focused implementation evidence, not an IAM
completion claim.

## Controls established

- Popup consent creates a real encrypted request bound to the full canonical RP
  transaction, including state, nonce, S256 challenge and optional agent key.
- A fresh request-bound passkey decision is mandatory before consumption. A
  member may self-consent to their own bound application request only; ordinary
  request administration and agent approval remain human owner/admin actions.
- The requester spends the approval once. Substitution or failed issuance burns
  it; manual unbound requests cannot be exchanged for popup authorization.
- The code-issuance fence rechecks private sessions and registration revision,
  then rereads the exact consumed record and verifies the original approval key.
  This closes the key-revocation interval between consumption and issuance.
- UI role eligibility shares the enforcement predicate; enabled-person and
  cryptographic/application checks remain mandatory at the authority boundary.

## Focused evidence

`pnpm --filter @opensesame/pages exec vitest run
src/lib/local-request-authorization.test.ts
src/lib/local-access-requests.test.ts
src/lib/local-issuer-channel.test.ts
src/sections/access/LocalRequestsPanel.test.tsx --maxWorkers=1` passed 31 tests.
Tests exercise real encrypted storage and cryptographic fixtures, PKCE redemption,
replay, transaction substitution, member-versus-administration policy, approval
key revocation after consumption, and current-record UI refresh/focus behavior.

Pages typecheck/build, scoped strict anti-slop, and design lint passed.
The structural gate passed after rerunning with subprocess permission; its first
sandboxed invocation failed with `spawnSync ... oxlint EPERM`.

The first browser run passed both Requests widths but timed out waiting for RP
sign-in. A later capture showed the popup connected. The unchanged rerun passed
all ten desktop/mobile IAM journeys. This does not establish the initial stall's
cause or justify relaxing timeouts. After rebuilding with the key-revocation
fence, `node apps/pages/scripts/verify-local-iam.mjs` also passed all ten journeys
at 1280px and 390px using the local Chromium virtual authenticator. The real RP
flow additionally checks its persisted consumed request in Access → Requests.

## Limits

Only popup-originated requests have this application-code consumer. Arbitrary
deferred administrative proposals do not execute an operation merely because an
approver records a decision. Browser-local grants are private object capabilities,
not remotely usable OIDC tokens. Same-origin malicious code and full-device
compromise remain outside claims of isolation. Full integrated verification,
delivery and the broader IAM completion audit remain outstanding.
