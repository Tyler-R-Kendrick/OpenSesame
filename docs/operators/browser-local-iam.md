# Browser-local application sign-in

The encrypted vault can maintain people, passkeys, organizations, memberships
and application registrations without a Host or Identity service. Its local
browser sign-in profile keeps the authority in an open issuer window. It is not
a substitute for a network OIDC server's discovery, token or JWKS endpoints.

## Configure

1. In Identity, create a person and organization, assign that person as an
   organization owner or member, and enroll their passkey.
2. Create an application. Open its registration, choose the organization, and
   save the exact RP callback URL and allowed scopes, including `openid`.
   Select which organization roles may receive each scope. A new custom
   scope permits nobody by default; owners do not bypass these choices.
3. Copy the application's local ID into the RP's own configuration. Call the
   workspace SDK directly from a user click, so the browser can open a popup.

```ts
import { signInLocalBrowser } from "@opensesame/static-auth";

const session = await signInLocalBrowser({
  authorizationEndpoint: "https://your-issuer.example/identity/authorize",
  clientId: configuredApplicationId,
  redirectUri: "https://your-app.example/callback",
  scopes: ["openid", "records:read"],
});
const currentIdentity = await session.check("records:read");
// Check at the operation, then enforce access to this application's records.
await session.revoke();
```

These are example domains. Pin your own exact endpoints and include the issuer
deployment's base path when applicable. This API is available in the workspace
source package; it is not provided by the existing frozen hosted SDK artifacts.
Bundle it with the RP or self-host the reviewed build. No browser client secret
is required or supported.

The person unlocks the issuer vault, chooses their local identity, verifies the
passkey, then allows or denies the displayed site and permissions. A verified
passkey alone never auto-approves the application. The callback address binds
the registration; this profile uses the channel rather than redirecting a token
through that URL.

Keep the issuer popup open while the application uses its session. Closing or
navigating away from it, locking its vault, expiry or revocation stops further
identity checks. `session.identity` is an initial snapshot, not proof that a
session remains active. Use `session.check()` at protected decision points and
handle rejection. Use `session.check(scope)` for a specific consented permission.
A scope outside consent is refused, and changing registration policy invalidates
pending codes and existing grants. `session.close()` drops the RP's channel immediately.

Version 1 registrations remain readable, but only `openid` is admitted until
custom role permissions are explicitly saved. Saves use version 2, which older
builds reject rather than ignoring the policy. Close old issuer tabs and reload
before using the new policy; do not downgrade stored registrations on rollback.

## Agents and public keys

Create an agent in Identity → Agents, expand **Agent keys**, and choose
**Enroll public key**. Supply its public ES256 JWK only. The private key stays
with the agent; the form refuses a JWK containing private material.

Choose **Authenticate agent**, send the displayed challenge to that agent, and
return its signed response. The workspace SDK's `createLocalAgentKey()` returns
`publicKey` for enrollment and `signChallenge(challenge, expectedOrigin,
principalId)` for signing with independently pinned origin and identity. Its
non-extractable private key stays in the running agent context; persist or
recover a production agent key through that agent's own reviewed custody system.
Do not generate a new key for each challenge against an older enrollment.

The challenge is valid once for two minutes, including failed attempts. A
verified response creates a local machine session, not human approval or an
application grant. **Sign out agent** revokes the session; **Revoke agent key**
also invalidates sessions using that enrollment. Directory changes invalidate
existing sessions. Closing the tab loses the session presentation; authenticate
again after reopening.

### Agent application access

A registered application can request access as an enrolled agent. Use its
existing agent signing key, not a new key per request:

```ts
const session = await signInLocalBrowser({
  authorizationEndpoint: "https://issuer.example.test/identity/authorize",
  clientId: applicationId,
  redirectUri: "https://rp.example.test/callback",
  scopes: ["openid", "records:read"],
  agent: {
    principalId: agentId,
    keyId: agentKey.keyId,
    signChallenge: (challenge) =>
      agentKey.signChallenge(challenge, "https://issuer.example.test", agentId),
  },
});
```

These `.test` URLs are illustrative; use your exact admitted HTTPS origins.
Call sign-in from a user action so the browser can open the consent window. The
application proves possession of the enrolled key over its private message
channel. A human organization owner/admin then reviews the named agent, key,
site and scopes, verifies an enrolled passkey and chooses **Allow agent access**
or **Deny**. Both principals must satisfy the application's scope-role policy.
The returned identity is the agent's, not the human's. `session.check(scope)`
revalidates authority; `session.revoke()` ends this grant. Neither operation
retrieves vault contents or supplies a network OAuth token.

Agent grants expire with the shorter of the two sessions. Revoking either
session, enrollment or membership invalidates access. Grant storage writes
version 2, preserving version 1 person records on read; older builds refuse
version 2. Do not downgrade encrypted records to make an old client accept them.

Session storage upgrades from version 1 to version 2 on the next write. Existing
passkey sessions remain readable, but older builds refuse the new version. Close
old tabs before upgrading and retain encrypted records during rollback.

## Manage local application policies

Open **Access → Policies**, choose a local application and expand **Application
registration**. The editor is shared with Identity → Applications. Configure
its organization, exact callbacks and scopes, then choose **Roles allowed per
scope**. Unchecked roles are denied, including owners; a new custom scope allows
nobody until explicitly selected. **Save registration** persists the encrypted
policy. **Reload registration** reads it back. No Host is required.

A changed registration invalidates its outstanding codes and existing grants.
Applications must recheck their scope at protected decision points; they cannot
keep using an earlier successful check after the policy changes. New access
still requires sign-in and explicit consent.

## Review and revoke local access

Open **Access → Grants** to review application grants, or **Access → Sessions**
to include local sign-in sessions. Both work independently of configured Host
or Identity endpoints. Application sign-in issues grants only after the existing
passkey approval, scope-policy checks and PKCE exchange; this list does not mint
unauthorized replacements. Optional Host delegations remain separate. The list
shows unexpired records, not connected clients: a closed application may no longer
hold its private presentation even while its stored grant remains unexpired.

Choose the exact session or grant, select **Revoke**, and confirm. Cancel changes
nothing. Session revocation also prevents use of dependent application grants;
grant revocation leaves the person's session intact. New access needs a new
sign-in or approval. Reload checks persisted changes from another tab.
These are human vault-custodian operations, not agent administration tools.

## Create and decide local requests

Open **Access → Requests → New local request**. Choose a local person or agent,
authenticate that identity, then select a registered application, exact callback,
scopes and reason. Creation writes an encrypted five-minute request; it grants
no application access.

Choose **Review request** to inspect the exact requester, application, organization,
callback and scopes. An authorized organization owner/admin chooses **Approve with
passkey** or **Deny with passkey**. The fresh passkey assertion binds the request,
decision and approver. Application scope policy still applies to both identities.
Concurrent decisions have one winner; changing policy or revoking the enrollment
invalidates consumption. A request can be withdrawn before consumption. Settled
history can be removed with confirmation; a pending request cannot be erased as
history.

Approval is not execution. The requesting operation must consume the approval
once using its original private local session, and recheck current policy. The
request management panel does not execute an application operation or issue an
application session. Popup application sign-in now creates a transaction-bound
request, asks for a fresh approval passkey after identity verification, and
consumes it into the existing PKCE flow. Its history appears as **Application
sign-in · consumed**. Members may consent to their own bound sign-in within the
application's scope policy; manual requests and agent approvals still require a
human owner/admin. Manual requests cannot be substituted for popup transactions.
If an effect fails after consumption, its approval stays spent: start a new
request rather than retrying an uncertain effect.

## Deployment and trust

### Upstream sign-in providers

**Identity → Providers → Register an IdP** can start the compiled Shoo browser
flow without an Identity service. The saved provider's **Sign in** action uses
the same pinned upstream as the front door. Registration starts authentication;
only the validated return leg establishes the upstream session. A failed retry
preserves an existing registration.

Catalog metadata cannot introduce a browser trust anchor. Providers outside the
compiled browser trust list still need a configured Identity broker; registering
their names does not make their server-only protocols run inside the browser.
Local people, agents, applications and passkeys do not require an upstream IdP.

### Local authenticator management

Without an Identity endpoint, **Identity → Devices** collects the existing
**Passkeys** and **Agent keys** controls for this vault's people and agents.
Enroll, authenticate, sign out and confirm key revocation there or from the
corresponding identity row. Revoking a key invalidates sessions authenticated by
that enrollment and their dependent application access; it does not erase other
enrolled keys. Disabled identities cannot enroll or authenticate but their keys
remain revocable. An open passkey list refreshes after local changes or when the
tab regains focus, and read failures disable stale controls.

The list describes authenticator enrollments, not physical-device inventory:
synced passkeys may exist on multiple devices. It neither enrolls nor approves
Host/daemon devices. Configured hosted Identity deployments retain their existing
device-code approval ceremony. Agent-facing navigation may open Devices, but key
enrollment and revocation remain human-custodian operations under ADR 0103/0109.

### Application origin

The exact authorization route needs a cross-origin opener for the handshake.
Serve it with `Cross-Origin-Opener-Policy: unsafe-none`, retaining the stronger
default on other routes. The Vite development server scopes this exception to
`<base>/identity/authorize`; reverse proxies/static hosts must do the same.
Do not use a `noopener` link or an RP opener policy that severs cross-origin
popups. If the opener is unavailable, sign-in is refused.

The popup cannot simultaneously claim cross-origin isolation. Its message port
is not operator authority, and it exposes no arbitrary fetch, vault or Host
operation. A public subject may correlate the same local person across admitted
applications. Same-origin malicious scripts can act inside the unlocked vault;
neither a path prefix nor a MessagePort cures that trust boundary. Use a dedicated
trusted issuer origin for real deployments; a shared-origin Pages demo is not
production origin isolation.

## Verify

```sh
VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
pnpm --filter @opensesame/pages verify:local-iam
pnpm --filter @opensesame/pages exec vitest run scripts/local-iam-headers.test.mjs
pnpm --filter @opensesame/static-auth test
```

The browser verifier uses two intercepted HTTPS origins, real encrypted storage,
and Chromium's virtual WebAuthn authenticator. It supplies disposable identities,
not live credentials, and rejects unexpected backend requests. Set
`PLAYWRIGHT_CHROMIUM` to the installed Chromium executable when needed.
