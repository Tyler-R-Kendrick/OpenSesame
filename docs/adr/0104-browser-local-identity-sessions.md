# ADR 0104: Browser-local identity sessions

Status: Accepted for local session enforcement and person controls; resource-policy integration remains incomplete.

## Decision

Only the real local WebAuthn verifier can produce authentication evidence. Its
immutable evidence is tracked by object identity and consumed once; copying its
fields does not create proof. Session issuance invokes that verifier itself,
then rechecks the directory revision and exact enrolled credential under the
same cross-tab lock used by identity and credential mutations.

A session lasts fifteen minutes, is bound to the vault and exact browser origin,
and has the fixed audience `opensesame:local-iam`. Its 256-bit presentation secret
exists only in a tab-private WeakMap. Public handles contain no bearer material;
serialization or copying loses presentation authority. Encrypted session records
store only SHA-256 token digests. Page restart requires another passkey sign-in.
Vault lock clears presentation authority, including pending sign-ins.

The tab owns active handles independently of React disclosures and navigation.
People's passkey controls offer explicit local sign-in and sign-out. Reopening
the controls validates the existing handle rather than minting a new session.
Mounted controls refresh on local identity/credential writes and window focus;
the authority guard still reads current state before every protected operation.

Every use reads current encrypted session, directory and credential state under
the shared Web Lock. Expiration, clock rollback before authentication time,
revocation, deletion, origin change and credential replacement refuse use before
the protected callback. Directory revision binding deliberately invalidates all
sessions after any directory edit, including rename; disable/re-enable cannot
resurrect an old session. This is conservative and bounded by the 1,000-entry
directory, not a cached role policy. Session records are capped at 256 and 1 MB;
issuance prunes expired records and fails before returning a handle on storage
failure. Revocation is acknowledged only after the encrypted write completes.

## Trust and remaining integration

Authentication establishes a local person, never an organization role, resource
grant, agent capability, remote bearer or OIDC token. Consumers must enforce
their resource policy inside the session fence; callbacks must not recursively
acquire that same fence. Session administration is a vault-custodian operation.
Public handle metadata cannot be submitted as an authentication assertion.

The vault custodian is still the administrative trust root. Same-origin script
compromise can use an unlocked vault; this is not an XSS containment boundary.
OPFS-unavailable operation remains session-only, and the VFS index is not a
multi-record transaction for external side effects. Distributed authority and
network OIDC are not claimed. Organization membership is defined by ADR 0105.
Agent keys, application admission, resource authorization and browser RP
transport remain required for full browser IAM.

## Evidence

`local-sessions.test.ts` uses a WebCrypto-backed ES256 authenticator and the real
SimpleWebAuthn verifier. It covers issuance, forged handles and evidence, proof
reuse, expiry, clock rollback, origin mismatch, vault locking, persistent
revocation, credential removal, disable/re-enable and failed persistence.
`verify:keyboard` exercises actual Chromium WebAuthn, disclosure/navigation
retention, disable/re-enable invalidation, sign-out and passkey revocation while
signed in at desktop and mobile viewport widths.
