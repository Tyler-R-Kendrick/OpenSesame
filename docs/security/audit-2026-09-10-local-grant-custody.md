# Local grant custodian administration — 2026-09-10

Scope: the current uncommitted browser-local grant administration core.

The unlocked vault custodian can inspect display-only recorded grants and revoke
one exact ID without impersonating its subject. This reuses the existing
encrypted grant ledger, validation, change notification and shared directory
Web Lock. No second store, bearer reconstruction or new trust root is introduced.
Agent/channel callers do not receive these operations.

Display records contain principal, application, organization and optional
approving-principal identity, scopes and expiry. They omit nonce, session IDs,
digest and private handle. An unexpired ledger row is not advertised as a live
connection. Locked reads/writes, malformed storage and failed persistence refuse
the operation without silently deleting unrelated data.

Validation:

```sh
pnpm --filter @opensesame/pages exec vitest run \
  src/lib/local-grant-admin.test.ts src/lib/local-authorization.test.ts \
  src/lib/local-agent-authorization.test.ts src/lib/local-grant-store.test.ts
```

**45 tests passed in 4 files.** New coverage includes display-field allowlisting,
expiry, concurrent revocation, isolation between two encrypted vaults, exact-ID
refusal, locked storage, failed writes and corrupt-ledger preservation. A test
using real passkey authentication and PKCE issuance verifies that custodian
revocation prevents the protected grant callback while leaving the person's
session usable. Pages typechecking, scoped strict lint, structural quality and
`git diff --check` passed without changing baselines.

Access UI integration and browser verification of custodian administration are
still incomplete. These results do not establish full IAM completion, a complete
repository gate or any external scanner execution.

## Access UI integration

Subsequent work wires the custodian APIs into Access → Sessions independently of
network configuration. The panel reads only the local directory and projected
ledgers, distinguishes recorded sessions from grants, confirms exact revocation,
and refreshes on changes, focus and expiry. Loading and failed reads are not
rendered as successful empty lists. Failed writes retain confirmation and never
announce success. A moved keyboard focus is not stolen by asynchronous completion.

The first expanded Chromium run proved second-tab grant revocation at 1280px:
real passkey/PKCE consent in one tab, separately unlocked encrypted ledger in
another, keyboard cancellation/confirmation/recovery, and subsequent refusal at
the real cross-origin RP. It also reproduced an intermittent agent proof failure
later in the broader suite; this run is partial, not clean.

The initial full Pages run reported 3541 passing and 17 failing tests: two stale
Access label expectations, fourteen child-process/listener sandbox permission
failures, and one agent authorization refusal at the explicit auth-time guard.
The Access assertions now require both the local and optional Host identities.
Happy-path fixtures use fixed wall time with real timers; explicit rollback
refusal remains tested and production time/authentication policy is unchanged.
Subsequent rerun results must be recorded separately, not inferred from these edits.

## Final scoped validation

The rebuilt UI passes all six real-Chromium journeys at 1280px and 390px:
person consent, agent consent, and second-tab local grant administration at each
width. The new journey checks cancellation and recovery focus, confirmation
button bounds, persisted revocation, and refusal by the actual RP. Mobile capture
review caught inherited horizontal notice styling that clipped the buttons; the
confirmation now uses a wrapping native fieldset and the bounds are asserted.

The complete Pages suite passes **3558 tests in 291 files** (193.36 seconds).
The preceding rerun also exposed wall-clock rollback in the legacy session
compatibility fixture; its happy path now fixes wall time while retaining its
explicit expiration and rollback assertions. No production guard was relaxed.
Scoped strict lint, Biome, Pages build/typecheck and structural quality pass.
Quality remains 818 tracked violations across 494 files, with no raised baseline.
The independent Impeccable review returns `ship` for the local-access panel only.

This does not establish full repository verification, bundle-budget clearance,
full offline IAM completion, external scanning, or publication.
