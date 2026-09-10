# ADR 0109: Browser-local agent authentication

Status: Accepted for enrolled-key authentication; agent application delegation remains incomplete.

## Decision

An enabled agent directory entry can enroll public ES256 keys in the encrypted
vault. Enrollment and revocation are human vault-custodian operations, not
agent-accessible registration APIs. Private JWK material is rejected rather
than stripped. Keys have both a public SHA-256 JWK thumbprint and a random
enrollment ID; re-enrolling the same key cannot revive an earlier session.

The agent keeps its private key. The static-auth package provides a
non-extractable WebCrypto signing closure, public-key validation, and verification
using the existing JOSE dependency. The custodian can exchange a challenge and
signed response through the Agents form. No private key, broad bearer, vault
content or operator credential is returned by that form.

A challenge binds the exact issuer origin, principal, public-key thumbprint,
random 256-bit nonce and two-minute expiry. Its compact JWS has the dedicated
`opensesame-local-agent+jws` type, ES256 algorithm and exact key ID. Verification
uses the stored key and canonical saved challenge, never proof-supplied key
metadata. Both wall-clock expiry and a monotonic deadline bound pending work.
Pending challenges are capped at 128, proofs at 8 KiB; a nonce is consumed before
verification, including invalid attempts. Vault locking clears pending proof and
authentication evidence. Directory and enrollment state are rechecked under the
existing shared Web Lock before issuing the session.

ADR 0104 sessions now carry an explicit authentication kind: `passkey` or
`agent_key`. The latter is machine key possession, not human presence, MFA or
consent. Agent sessions can read their current organization memberships but
cannot change membership or approve application access. A consumer still needs
its own resource/operation policy inside the session fence. Existing origin,
expiry, directory revision, credential and revocation checks apply on every use.

## Storage and migration

The encrypted key ledger is version 1, bounded to 1,000 public keys and 1 MB.
Session writes use version 2 with mandatory authentication kind. Version 1
session records remain readable as passkey sessions because only that verifier
could mint them; a version 1 row already containing the new field is rejected.
Malformed version 2 rows cannot fall back to passkey authentication. Reading does
not rewrite the ledger; the next mutation saves version 2. Older builds refuse
version 2. Close old tabs before upgrading; do not downgrade the stored format.
Removing the application build never justifies deleting encrypted user records.

## Boundaries

This is local authentication, not an OAuth client credential grant or an OIDC
token. The manual challenge exchange does not constitute an agent transport.
Application-bound agent authorization and transport must consume this evidence
without allowing an agent to approve its own permissions. MCP/WebMCP may navigate
to Identity but cannot enroll sibling keys or invoke the human approval controls.

The unlocked vault custodian remains the administrative root. Same-origin script
compromise is not contained by non-extractable keys or private JS handles. An
agent's authentication does not unlock the vault or expose its contents.

## Regression evidence

`local-agent.test.ts` signs with real keys and rejects wrong protocol, key,
origin, principal, nonce and claim bytes. `local-agent-auth.test.ts` covers
single-winner replay, expiry, locking, membership and key revocation,
disable/re-enable, failed persistence and human-approval refusal.
`local-sessions.test.ts` covers both format migration and malformed new records.
`LocalAgentKeys.test.tsx` covers the complete form flow with real signatures and
focus preservation during delayed challenge loading. The keyboard browser
contract exercises the built PWA with an independent signing key held outside it.
