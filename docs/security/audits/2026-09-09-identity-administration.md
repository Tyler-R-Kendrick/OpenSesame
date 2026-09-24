# Identity administration boundaries

This change removes an upstream-provider ceremony that hid Identity's existing
administration views, and adds browser access to existing directory provisioning
and owned-agent lifecycle operations. It does not introduce a new OIDC issuer,
credential database, identity-joining rule, or development authentication bypass.

## Enforcement

- The SCIM surface retains provisioning-token authentication and additionally
  accepts the current organization owner's Identity session. An invalid SCIM
  token cannot fall back to the owner's cookie. Cookie mutations retain the
  existing Origin/CSRF fence. Inactive organizations are refused.
- Browser directory writes carry human audit attribution; provisioning-token
  writes retain their system actor. Directory updates are audited even when
  they do not deactivate a user.
- Agent reads are owner-scoped, including the database predicate. Rename and
  terminal revocation serialize on the existing registry transaction; concurrent
  revocations have one winner. Unknown and foreign agent IDs return the same
  not-found response. Revoked agents cannot start another claim.
- User provisioning does not mint a verified principal. Agent registration does
  not grant resource access. The UI discards claim bearer fields.
- Application edits reuse owner-fenced OAuth registration and redirect policy.
  OIDC signing, PKCE, nonce, consent and replay checks remain in the established
  provider and static-auth implementation.

## Regression evidence

`apps/control-plane/src/__tests__/identity-management.test.ts` covers owner and
foreign sessions, anonymous refusal, role downgrade, directory edits, agent
isolation, forbidden ownership changes and concurrent terminal revocation.

`apps/pages/src/sections/identity/management.test.tsx` exercises forms through
the real directory client and a faithful HTTP fixture, including request
serialization, response parsing, discarded claim bearers, failed saves and
offline controls. `IdentitySection.test.tsx` asserts that no upstream binding
is needed to reach administration and retains explicit provider-ceremony tests.

The existing SCIM, durable-agent, OAuth-client and static-auth interoperability
suites additionally exercise deprovisioning, second-instance persistence and
real HTTP authorization-code/PKCE exchange with signed-token and replay checks.

Validation on the integrated working tree:

- `pnpm test`: final rerun passed all 65 workspace tasks, including 3,347 Pages tests.
- Final Identity UI regression run: 35 tests passed, including application-edit
  serialization; final SCIM/management run: 13 passed.
- `pnpm typecheck`: 61 tasks passed.
- `pnpm lint`, `pnpm lint:anti-slop`, `pnpm quality` and `pnpm lint:design`: passed without
  suppressions or increased baselines.
- Pages production build, `verify:static` and `verify:auth`: passed.
- Bundle-budget check: all existing budgets retained and satisfied; Pages was
  freshly built for this check.
- Interactive Chromium against a disposable loopback Identity API created a
  directory user, registered an agent, and created/edited an OIDC application.
  At 390px width all six views remained reachable without horizontal overflow.

The complete Rust-inclusive `pnpm verify` is not claimed: its preceding run
stopped on a Cargo `const_oid` dependency/cache compilation error. No Rust code
changed in this administration work.

## Scope limits

Provisioning is not native password enrollment; verified sign-in is still
required. Legacy agent registration is not AgentAuth token issuance. Self-hosted
production still needs explicit trust, durable storage and production signing
configuration. A shared-origin demo remains ineligible for local authority.
No model-backed security scan or deployment is claimed by this record.
