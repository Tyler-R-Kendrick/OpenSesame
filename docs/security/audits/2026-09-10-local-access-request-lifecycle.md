# Browser-local access request lifecycle

Date: 2026-09-10. Scope: the uncommitted local IAM implementation, not a deployed
release or a complete IAM security assessment.

## Enforcement

Local requests are strict, bounded records encrypted inside the current vault.
Creation requires a genuine private requester session and current application
admission. The immutable digest binds requester/session, organization, application
and policy revisions, exact callback, scopes, reason and the five-minute lifetime.

Approval and denial require a fresh WebAuthn assertion bound to the request,
decision and approver. The approver must be an enabled person with an owner/admin
membership and explicit application scope admission. The existing Interaction
machine controls transitions. The vault's existing Web Lock serializes writes;
after the authenticator returns, the request version and policy are reread. A
withdrawal or competing decision prevents a stale approval from committing.

Consumption requires the original private requester session and rechecks policy,
enrollment and approval binding. The consumed record is persisted before the
effect. Persistence failure executes nothing; effect failure leaves approval
spent. This prevents duplicate effects but does not make an arbitrary external
effect transactional. No public session token, private key or generic network
execution surface was introduced.

## Regression evidence

`pnpm --filter @opensesame/pages exec vitest run
src/lib/local-access-requests.test.ts`: **13 passed**. Cases cover real signed
approval, single-winner consumption, denial, stale/swapped references, forged
private presentations, cross-vault references, independently changed policy and
key, withdrawal during WebAuthn, requester-session revocation, owner policy denial,
concurrent decisions, effect/storage failure, corrupt binding and expiry.

The initial Chromium run passed all ten 1280px/390px IAM journeys, including
request creation, bound approval, persistence, withdrawal and history removal.
Both viewport-specific Requests journeys subsequently passed real denial and
below-fold control checks. Broader repeat runs failed at varying agent consent
or revocation assertions. The final post-fix Chromium run passed all ten journeys
at 1280px and 390px, including open-review expiry. Earlier intermittent failures
remain recorded; one green run does not explain their cause.

The independent Impeccable review found that an open review retained its selected
record snapshot after refresh. Selection now resolves the current record by ID;
expired or externally settled requests no longer show obsolete decision controls.
`LocalRequestsPanel.test.tsx` passes five tests through real encrypted storage and
refresh events, including focus retention and deleted-record recovery. The
reviewer's verdict scored its one material finding resolved. This is a scoped
panel verdict, not whole-IAM certification.

Pages build/typecheck, scoped anti-slop, Biome, design lint (294 files), and
`git diff --check` passed during implementation. A complete Pages rerun did not
pass: one run timed out in two existing tests, which passed in a 79-test focused
rerun; a sandboxed rerun encountered subprocess/listener EPERM and a support-panel
timing failure. The affected lint/server/support tests passed with execution
permission. No tests were skipped or timeouts increased. These focused results
are not a substitute for the outstanding clean full run. A later permission-enabled
full run had 3,588 passing tests and one support reflow timeout; the reflow tests
and five new panel tests passed together in an eight-test focused rerun.

## Remaining boundary

The Requests panel manages real persisted decisions but does not yet connect
consumption to the application's private popup channel. Its callback-level
consumption test is not an end-to-end application-operation proof. Existing
application sign-in uses its separate explicit consent path. Do not describe a
request approval as an issued application session or completed operation.

No model-backed scanner, full root verification, remote merge or deployment ran
as part of this evidence. Same-origin malicious JavaScript remains inside the
unlocked browser authority boundary; encrypted storage and a non-extractable
passkey do not cure that threat.
