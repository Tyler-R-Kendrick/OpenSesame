# Browser-local authenticator management — 2026-09-10

Scope: Identity → Devices without a configured Identity endpoint, using the
existing encrypted local credential/session implementations. This view previously
fell through to hosted device approval rather than exposing local management.

## Implementation

The Devices view now collects person passkeys and agent keys through the same
components used on their identity rows. It adds no credential format, trust
anchor, authority tier or network endpoint. Hosted deployments retain their
existing device-code approval. Synced credentials are explicitly not described
as a physical-device inventory.

Open passkey lists refresh on local IAM invalidation and window focus. Failed
reads clear stale credentials and disable operations rather than implying an
empty vault. Generation checks discard out-of-order reads. Removing the focused
credential restores its disclosure; removing an entire focused identity row
restores Reload directory only when focus has fallen to the body. Focus moved
elsewhere is preserved.

## Regression evidence

`LocalDevicesPanel.test.tsx` uses real encrypted storage and a cryptographic
WebAuthn fixture. Six tests cover confirmed key revocation and dependent session
refusal, external credential refresh/focus, unreadable storage, actionable empty
state, and external principal deletion with/without active row focus. The tests
refuse network calls. The initial fixture failed under jsdom's distinct
ArrayBuffer realm; the fixture was corrected without weakening verification.

The broader focused suite passed 67 tests across IdentitySection, Devices,
agent keys, passkeys and WebMCP navigation before adding the two principal-removal
cases. Guide/registry parity passed 20 tests. Pages build/typecheck, scoped
anti-slop and design lint passed. The complete quality suite passed; extracting
the existing hosted device panel reduced IdentitySection's recorded line ceiling
from 2,618 to 2,504. No baseline was increased.

The real Chromium harness passed twelve journeys at 1280px and 390px, including
enrolling a second passkey, cancelling then confirming revocation of the original,
retaining the second key and rejecting the original relying-party session. The
independent UI review subsequently required principal-removal focus recovery;
the six-test suite above includes that correction. After that fix, all twelve
browser journeys passed again. The same reviewer inspected the four refreshed
desktop/mobile captures and scored the sole focus finding resolved, with a
`ship` disposition restricted to that correction in offline Devices.

The final Pages suite (`pnpm --filter @opensesame/pages exec vitest run
--maxWorkers=1`) passed all 3,608 tests across 297 files in 421.98 seconds.
An earlier run exposed a module-load timestamp assumption in ConnectivityBar's
freshness test; its clock and expected age are now explicit. A sandboxed rerun
could not spawn design-contract subprocesses or bind the local header-test
listener; the final run used the required local execution permissions.

## Limits

This is authenticator management, not remote hardware inventory, Host pairing,
or proof that a syncable passkey exists on only one machine. Existing human
custodian restrictions and agent-surface exclusions remain in force. No model
security scanner, full integrated verification, merge or deployment is claimed.
