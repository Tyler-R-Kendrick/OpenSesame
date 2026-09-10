# Local agent authentication boundary — 2026-09-10

## Scope and prior behavior

Reviewed the browser-local agent directory, new public-key enrollment and signed
challenge path, and its integration with existing local sessions. Previously an
agent was a directory record without an authentication ceremony. This work adds
key-possession authentication; it does not retroactively claim a demonstrated
exploit in that absent ceremony or completion of agent application delegation.

## Enforced properties

- Only public ES256 JWKs are admitted. Private material, alternative algorithms,
  key-selection URLs and malformed curve coordinates are refused.
- Verification uses an enrolled key and canonical saved challenge, with exact
  origin, principal, key thumbprint, nonce, protocol type and expiry binding.
- The pending nonce is spent before signature verification. Concurrent duplicate
  responses have one winner; failures cannot reuse the same challenge. Both
  monotonic and wall-clock deadlines limit challenge lifetime.
- Random enrollment IDs prevent revoke/re-enroll of the same public key from
  resurrecting an old session. Directory, key, origin, expiry and revocation
  checks run inside the existing session/directory fence.
- Agent sessions carry `authentication: agent_key`. They cannot satisfy the
  passkey-only human application consent or membership-administration guards.
- The session token remains digest-only in encrypted storage and private in the
  owning tab. A serialized handle is not authority. Failed persistence produces
  no usable session and consumes the proof.
- Version 1 sessions migrate as passkey records; version 2 requires an explicit
  authentication kind. A malformed new record cannot downgrade to passkey.
- The UI never requests a private key and distinguishes authentication from
  authorization. It reports unavailable status when validation fails, preserves
  focus moved elsewhere, and requires confirmation before key revocation.

## Evidence

- `packages/static-auth/src/local-agent.test.ts`: real signing/verification,
  public-key input restrictions, protocol and challenge binding.
- `apps/pages/src/lib/local-agent-auth.test.ts`: replay, expiry, origin and
  directory changes, locking, revocation/re-enrollment, failed persistence,
  membership enforcement and refusal of human approval with machine evidence.
- `local-sessions.test.ts`: authenticated-handle enforcement and session-format
  migration, including rejection of incomplete version 2 records.
- `LocalAgentKeys.test.tsx`: actual public-key enrollment, real signed response,
  session creation, key revocation and focus preservation during loading.
- `LocalIdentitySession.test.tsx`: failed validation replaces prior session
  status; successful reread clears the failure.
- `verify:keyboard`: two desktop/mobile runs passed against the built static PWA.
  The browser receives a public key and signed response, while the independent
  test process holds the private key. Actual keyboard input drives enrollment,
  authentication, sign-out and confirmed revocation at 1280px and 390px.

These are local deterministic tests and browser checks, not a fresh model-backed
security scan or a claim about all repository security boundaries. The initial
full Pages run also detected missing contextual-help registration for the new
capability; its authored mapping was added and focused registry tests passed.
The complete Pages suite then passed 3,521 tests across 287 files. A preceding
run had one five-second vault-lock/support timeout under concurrent work; that
test passed in isolation and the full rerun passed without changing its timeout
or assertions. This is rerun evidence, not a claim that a timing defect was fixed.
`pnpm quality`, strict scoped anti-slop lint, capability-registry tests and Pages
WebMCP registry parity also passed. The independent Impeccable reviewer returned
`ship` for this bounded UI extension, followed by design documentation.

## Residual boundaries

See ADR 0109. The manual exchange authenticates an agent locally; application
delegation, resource-specific authorization and a client transport still require
integration. Same-origin hostile code in an unlocked vault is outside this
key-possession boundary. Non-extractable keys do not prevent their owner context
from invoking signing. No network OIDC service, unattended remote authentication,
or cross-device durable replay service is claimed by this implementation.
