# Local agent application approval boundary — 2026-09-10

Scope: browser-local authorization core in the current uncommitted working tree.
This is source review and deterministic regression testing, not a model scan or
completed full-IAM assessment.

## Enforced properties

- Agent key possession cannot approve application access. A distinct, recently
  passkey-authenticated organization owner/admin must authorize the exact scopes.
- Both sessions and application admissions are revalidated inside one shared
  directory lock at approval, code redemption and protected grant use.
- Existing PKCE one-use redemption is reused; concurrent requests have one winner
  and persistence failure burns the code without returning a grant.
- Encrypted grant records bind both principals/sessions. Missing or mismatched
  approval, organization substitution, scope widening and expiry extension are
  refused against the original private presentation and current admission.
- The approving human can revoke the agent's individual grant; revocation of
  either session, agent enrollment or membership also stops use.
- Version 1 person grants remain readable; version 2 approval metadata is strict.
  Invalid persisted input is refused and preserved, never silently repaired.

## Verification

Node 22.23.1, pnpm 9.15.0:

```sh
pnpm --filter @opensesame/pages exec vitest run \
  src/lib/local-agent-authorization.test.ts src/lib/local-grant-store.test.ts \
  src/lib/local-authorization.test.ts src/lib/local-sessions.test.ts \
  src/lib/local-issuer-channel.test.ts
```

Result: **58 tests passed in 5 files**, including real passkey and agent signature
verification. Structural quality gate passed with no baseline increases.

## Incomplete integration and residual risk

The new dual-principal flow is not yet connected to the browser consent channel
or UI. No browser end-to-end success is claimed for it. Resource operations still
need explicit application/scope enforcement; authentication alone grants none.
Same-origin malicious JavaScript and an unlocked vault custodian retain their
existing trust position. Full-repository verification, bundle budgets and remote
delivery remain separate and have not been completed for this change.

## Subsequent channel integration verification

The SDK and issuer channel now carry the complete principal/key binding and
perform enrolled-key challenge verification before consent becomes available.
The existing person-approval method refuses agent requests; only the explicit
agent-approval method can invoke the dual-session authorization core. That
method is not yet called by the consent UI, so this is not an end-to-end product
completion claim.

The same five-file Pages command now passes **60 tests**, including real agent
signatures over MessageChannel and refusal after human revocation.
`pnpm --filter @opensesame/static-auth test` passes **71 tests**. SDK regressions
refuse mismatched principal/key/origin/expiry before invoking the signer and
reject authorization codes received before agent proof. Pages typechecking and
the structural gate pass without baseline changes. No new browser-rendered
evidence, full-repository verification or external scanner result is claimed.

## Consent UI integration verification

The screen now explicitly names the requesting agent, its public key binding,
application and scopes, separately from the approving human. Agent requests list
enabled human owners/admins; passkey verification rechecks the authorization
core before revealing the explicit Allow agent access command. Denial never
issues a code. Person self-sign-in retains its original separate path.

The built static PWA passed `node scripts/verify-local-iam.mjs` in real Chromium
at 1280px and 390px for both person and agent profiles. Each journey includes
keyboard-only vault unlock, passkey verification, approval, PKCE redemption,
scope check, revocation, denial and explicit clock rollback refusal. The agent's
private key is generated on the RP origin; only its public JWK enters fixture
enrollment. Screenshots show both profiles' actual pre-approval state.

An initial agent journey closed before the consent heading appeared. A complete
rerun passed without changing runtime validation. Stable diagnostic stage codes
were added to the harness; the intermittent cause remains unproven. Do not label
that failure fixed, count the failed run as a pass, or infer whole-IAM completion
from this bounded browser result. No full repository gate or scanner ran here.

After the consent and authored-help changes, `pnpm --filter @opensesame/pages
test` passed **3,544 tests across 289 files** in 63.33 seconds. Scoped anti-slop
lint, Pages typechecking, the production Pages build and structural quality
checks passed. Existing jsdom navigation-not-implemented diagnostics remained
in the test output; the suite exited successfully. Bundle budgets and the
root `pnpm verify` command have not been cleared by these results.
