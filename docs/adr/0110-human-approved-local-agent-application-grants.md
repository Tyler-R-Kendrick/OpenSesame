# ADR 0110: Human-approved local agent application grants

Status: Accepted for the authorization core, channel and consent UI.

## Decision

Reuse ADR 0107's one-use PKCE code and private application grant handles for
ADR 0109 agent sessions. An agent cannot approve its own application access.
Approval requires a separately authenticated human passkey session, less than
five minutes old, and an agent key-authenticated session. The human must be an
owner or admin of the application's organization. Both principals must satisfy
the application's current membership and requested-scope policy.

`withLocalIdentityPair` validates both private session presentations under the
existing shared directory Web Lock. Approval, redemption and each protected
grant operation reuse `withLocalApplicationApproval`; they never nest session
locks. Both sessions remain subject to origin, enrollment, directory revision,
expiry and revocation checks. Human freshness is checked again after asynchronous
work before issuing an approval code.

Codes expire within two minutes and no later than either session. The existing
PKCE verifier, exact application, redirect URI, nonce, scopes and revision
bindings remain. A code is consumed before persistence, including failed writes.
Grants expire no later than either session. Their encrypted records bind the
agent principal/session and approving human principal/session. Every grant use
rechecks both sessions and admissions, the recorded approval, organization,
redirect, exact granted scopes and expiry ceiling before calling the protected
operation. Revoking either session or its enrollment invalidates use.

The subject and approving human can inspect and revoke their own grants. A
person's ordinary self-sign-in continues to use the existing passkey-only path.

The unlocked vault custodian also has ledger administration through
`local-grant-admin.ts`, consistent with the existing directory/session custody
boundary. Its display projection includes IDs, scopes, timestamps and approving
principal, never a nonce, bearer, session digest or private grant presentation.
It calls entries recorded grants, not live connections: persisted metadata cannot
prove that a tab still holds a usable presentation. Exact-ID revocation holds the
same directory lock as grant issuance and use, modifies only the selected vault,
and preserves unrelated grants. This API is not mounted on the application or
agent channel. Access → Sessions exposes this administration without a Host or
Identity endpoint. Each row has an exact-record revocation confirmation. Cancel
receives initial keyboard focus, and completion restores the row control or
Reload without overriding focus moved elsewhere. Host task sessions remain a
separate optional panel; Identity receipts are independently available.

## Storage and recovery

Grant writes use ledger version 2. Version 1 person grants remain readable without
rewriting their bytes; the next mutation writes version 2. A version 1 record
with approval metadata is refused. Malformed approval metadata and unknown
versions fail closed without deleting data. Older builds refuse version 2 rather
than ignoring its authority binding. Close old tabs before upgrading and restore
a compatible build or encrypted backup instead of downgrading the ledger.

## Limits and evidence

This does not create a network OAuth token or resource service.
The browser profile now accepts a paired `agent_id` / `agent_key_id` request.
The exact opener channel challenges the enrolled key before enabling consent.
The SDK pins the challenge to its configured agent/key/issuer and refuses a code
before proof acknowledgement or an identity response for another subject.
The issuer's ordinary person approval refuses agent requests. The consent screen
displays the requesting agent separately from its approving person, offers the
public identity/key binding in a disclosure, lists only enabled organization
owners/admins as approvers, and calls `approveAgent` only after the human chooses
Allow agent access. Agent proof and passkey verification alone never consent.
Grant handles do not unlock vaults,
export secrets or establish a same-origin XSS boundary.

`local-agent-authorization.test.ts` uses actual passkey verification and ES256
agent signatures. It covers distinct principals, self-approval, copied handles,
role downgrade, session/key/grant/membership revocation, scope and organization
mutation, missing recorded approval, concurrent redemption, failed persistence
and stale human approval. `local-grant-store.test.ts` checks migration and
malformed data preservation.
The deterministic channel fixture now completes an actual ES256 proof, explicit
human approval, PKCE redemption and rejection after human-session revocation over
a MessageChannel. It invokes consent directly and is not a rendered UI test.
`verify-local-iam.mjs` separately exercises the built PWA at 1280px and 390px:
RP-owned agent key, enrolled public key, encrypted vault unlock, human passkey,
keyboard consent, PKCE, session check, revocation, denial and clock rollback.
One initial agent run refused before displaying consent; the unchanged runtime
passed the full rerun. Its intermittent cause is not established, so this evidence
does not claim that all reliability defects are resolved.
