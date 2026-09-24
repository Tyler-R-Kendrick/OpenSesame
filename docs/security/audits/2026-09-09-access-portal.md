# Access portal authorization wiring — 2026-09-09

Scope: working tree based on `f658bb3dc91cf2a90186c093f7bc9553d177c4c2`.
Preserves the separate, uncommitted Identity administration changes.

## Confirmed issue and correction

The authenticated-browser route ceiling omitted delegation lifecycle, relay
decisions and task management. Existing Pages controls therefore failed before
reaching their authorized handlers. Exact method/path entries now admit those
operations only for Identity-authenticated paired grants. Native membership,
DPoP origin/key/audience/replay validation and each handler's resource checks
remain authoritative. Unverified pairing does not acquire these capabilities.

Requests now includes the existing Identity inbox and its create/approve/deny
protocol. Activation is bound to the reviewed digest, decision and current
policy. Missing comparison evidence, malformed passkey challenges, changed
policy and cancelled authenticators cannot produce a decision. API request
responses use the existing shared contracts. Passkey activation runs on the
Identity origin with its same-origin cookie, not on the Pages relying-party
origin. The hosted page checks the reviewed digest and current policy, requires
confirmation, and keeps the assertion on Identity. Pages polls authenticated
request state; no popup message grants authority and no credential or comparison
code enters the popup URL.

Session creation obtains its principal and organization from Host whoami and
uses the existing task API. A real-DPoP full-router test proves cross-principal,
cross-organization and post-revocation requests fail. The browser ceiling still
does not include invoke, raw credential access, operator administration or
browser-control elevation.

## Completed verification

The full-suite results below precede the final hosted-passkey correction. Its
additional focused and aggregate reruns are recorded separately below.

- Focused Pages Access/Identity client and component tests: 85 passed.
- Complete Pages suite: 270 files, 3,368 tests passed.
- Gateway package: 609 tests passed, one pre-existing ignored test.
- Gateway all-target/all-feature Clippy with warnings, pedantic and excessive
  function length denied: passed.
- Identity authorization-request and administration API tests: 15 passed.
- `pnpm typecheck`: 61 workspace tasks passed.
- `pnpm test`: all 65 workspace test tasks passed (57 cached).
- `pnpm lint:all`, focused anti-slop, `pnpm lint:design`, `pnpm quality`,
  `pnpm audit:ast-grep`, `pnpm test:security`, `pnpm test:task-access`: passed.
- `pnpm audit:gitleaks`: working tree clean. Its non-blocking history stage
  reported 102 historical findings; these were not reclassified as resolved.
- Production Pages build and existing bundle-budget checks: passed without
  increasing budgets. Static-origin and authentication Chromium harnesses:
  passed with no page errors or unexpected loopback requests.
- Live Chromium with a disposable loopback Identity API: two principals,
  request creation and server-backed approve/deny transitions passed. An expired
  request was refused with HTTP 410 rather than accepted.
- Desktop and 390px mobile inspection: readable request controls, no document
  overflow. The temporary loopback profile was restored to the shared-demo
  manifest and only the disposable browser/service were stopped.

### Hosted-passkey correction

- `pnpm --filter @opensesame/control-plane exec vitest run --config
  vitest.authentication.config.ts e2e/approval-portal.test.ts`: two real-Chromium
  tests passed. A different-origin opener, actual passkey enrollment and
  cryptographic assertion verification approve and deny the reviewed requests.
  Development assertion shortcuts are disabled. Wrong digest, missing session
  and cancelled authenticator leave requests pending; replay is refused.
- Hosted-page/activation API regressions: 24 passed. Pages approval client and
  portal regressions: 14 passed. Popup opening precedes asynchronous work;
  blocked windows, cancellation and changed digests cannot settle a request.
- Final workspace rerun: 65 tasks passed, including 271 Pages files and 3,373
  tests. The aggregate run exposed an existing GitHub registration recovery
  timer outliving its settings panel. The extracted lifecycle now cancels on
  unmount; two focused timer tests cover mounted recovery and cancellation.
- Workspace typecheck passed, followed by a final Pages typecheck after the
  timer fixture was typed correctly. Strict anti-slop on all final approval and
  timer changes passed without ignores. Structural baselines were tightened,
  not increased; package metrics retain zero cycles and phantom dependencies.
- Final three-app bundle-budget gate, static-origin and authentication browser
  harnesses passed. Deterministic ast-grep security rules passed again.
- Full-repository `pnpm lint:all` completed successfully, supplemented by strict
  focused lint on the final hosted-approval and timer files. The final
  `pnpm lint:design` and `pnpm quality` checks passed. No diagnostics were
  suppressed and no source or test file was excluded to obtain these results.

## Incomplete aggregate evidence

Full-workspace Clippy fails in the existing `uniffi_bindgen` dependency: Askama
expands a cache-relative `askama.toml` path that cannot be read through the
environment's symlinked Cargo registry. The initial shared target also failed
to load `const_oid`; an isolated target built and tested Gateway successfully.
Neither issue was suppressed or worked around by weakening source checks.
`pnpm verify` reaches the same UniFFI failure and is not green.

The red-team harness passed 14 deterministic cases. Four model-backed cases
could not run because its Claude OAuth credential was expired. Fixture ports
were moved to 19887/19890 after the defaults were occupied; existing services
were not stopped. This is partial coverage, not a clean full red-team review.

No Codex Security scan, full PAM parity, remote publication, or aggregate green
verification is claimed by these focused results. Remaining product boundaries
are documented in ADR 0101 and the Access operator guide.
