# Approved provider authentication audit

Checked 2026-10-09 against provider-owned documentation and the deployed browser origin `https://tyler-r-kendrick.github.io`. Browser-only routes remain the selected deployment model. The catalog-wide capability audit is maintained by the capability audit slice; this report covers approved authentication alternatives to the shipped confidential integration presets.

## Implemented provider routes

| Provider | Approved route and actual resource operation | Required public registration / recovery |
| --- | --- | --- |
| Vercel | Sign in with Vercel public client (`none`), authorization code + S256 PKCE. Signed RS256 issuer/audience/nonce assertion and `userinfo` subject must agree. | Identity account access only; no Vercel Connect, deployments, or management grant claim. Exact callback belongs to originating browser state. Documented secretless revoke endpoint includes public client ID. |
| Codeberg | Forgejo public client + S256 PKCE, authenticated `/api/v1/user`, and actual `/api/v1/user/repos`. | Provider does not implement granular OAuth API scopes. UI exposes no invented scope selector; successful access reports provider-managed permission. OAuth app removal uses actual Codeberg application settings; credential removal alone is local. |
| Auth0 | Tenant public SPA + S256 PKCE, signed tenant ID assertion plus authenticated `/userinfo`. | Canonical tenant hostname, registered SPA callback and allowed browser origins; identity access, not Auth0 management API access. Secretless tenant revoke includes client ID. |
| Okta | Organization public SPA + S256 PKCE with `okta.users.read.self`, signed issuer/audience/nonce assertion and authenticated `/api/v1/users/me`. | Canonical organization hostname, approved app scope and Trusted Origins. Org issuer is distinct from custom authorization server issuers. Tenant revoke is pinned to the immutable grant and client ID. |
| Crowdin | Public PKCE client, authenticated `/api/v2/user`. | Documented token response can omit scopes. Verify actual resource access and report provider-managed permission rather than pretending requested scopes were granted. Settings removal / local credential removal are distinct. |
| Databricks | Registered custom public OAuth app + S256 PKCE at configured workspace, authenticated SCIM `Me`. | Never reuse Databricks CLI client ID. Optional advanced OAuth integration ID enables documented DELETE `/api/2.0/oauth-app-integrations/{integration_id}/user-consent/me`. Consent deletion does **not** invalidate issued access/refresh tokens until expiry; outcome is local credential forgotten, never provider revoked. No invented connected-apps URL. |
| Twitch | Official public device-code grant, finite polling/slowdown/expiry/cancellation; actual token validation and Helix user read. | Public client ID; no secret or pretend redirect callback. Token scopes are the provider's array. Startup/hourly validation hooks, retained rotating grants and old access token revocation. Documented access-token revoke plus validation proof; no invented refresh-token revoke. |
| Discord | Official implicit grant, encrypted static browser return, authenticated OAuth authorization metadata, user read and scope-gated guild membership list. | Exact originating ephemeral receiver key; application ID, scopes, expiry and user ID must agree before connected. No refresh token. Client-authenticated revocation is not pretended secretless; local disconnect truthfully forgets the credential and provider consent remains until user removes it. |

Google's approved GIS token model is implemented by the capability audit slice and shares the encrypted receiver; Vault/OpenBao approved browser OIDC and verified secret reads are implemented by the Vault slice. Linear approved PKCE and scoped API access are implemented by the callback / parent slices.

## Browser and provider evidence

- Vercel official public-SPA instructions explicitly allow `none` client authentication. Discovery omits that method, so the exception is tied to current official instructions, not an invented discovery override. `web_message.opener` official reference requires exact `https://vercel.com` origin and exact popup source; the shipped strict-COOP flow uses query return + static same-origin callback, so it does not depend on an opener surviving cross-origin navigation.
- Vercel token, userinfo, revoke and JWKS OPTIONS permit deployed-origin browser requests. Management API OPTIONS can also be readable; this does not establish a Sign in with Vercel management grant. Resource API permissions remain private beta, so identity grant is never labelled Connect/management.
- Codeberg token and authenticated user OPTIONS permit browser content-type/Authorization headers. Official Forgejo docs confirm public clients + PKCE and explicitly distinguish unimplemented OAuth API scopes from OIDC identity scopes.
- Crowdin token/API OPTIONS allow the deployed origin. Official token examples omit scope; resource proof is required.
- Twitch actual OPTIONS probes cover all five token/device/revoke/validate/Helix routes; all return readable browser CORS headers. Actual user grants require provider account consent; tests are protocol fixtures and are not claimed as live Twitch account grants.
- Discord Python HTTP probes initially hit Cloudflare fingerprint error 1010. A real Chromium browser with provider requests untouched returned readable CORS 401 from both `/api/v10/users/@me` and `/api/v10/oauth2/@me` for a deliberately invalid bearer. This establishes browser API reachability, not a live account grant. Only the initiating HTML document was scaffolded at the exact deployed origin; no provider response was mocked.
- Reddit Chromium resource and token requests both fail browser fetch/CORS at the deployed origin. Official installed-client / implicit support is not denied or relabelled confidential-only. No unsupported browser `+` admission is justified for those routes.
- X public SPA PKCE, Zoom public PKCE and beehiiv public PKCE are officially documented; their probed token/resource routes lack usable deployed-origin CORS. Do not misdescribe these as inherently requiring a client secret. Their current browser operation capability remains unavailable unless an approved independently reachable route exists.
- Salesforce global token/resource probes lack usable deployed-origin CORS. Tenant-specific approved routes require tenant evidence rather than an unqualified global denial.
- Auth0/Okta tenant browser support depends on the operator's registered SPA origin / tenant settings. No tenant grant was live authenticated in this session.
- Databricks official custom public-client PKCE is confirmed, but no actual configured workspace/account is available. Workspace CORS and SCIM fixture tests are not proof of a live Databricks connection; the browser must verify the configured workspace's actual endpoints before marking connected.

## Return transport security and lifecycle

The served callback never needs a server-side per-user session. Each initiating tab seals provider/state/PKCE transaction data before authorization. Code return channels are exact state / same-origin bound. Browser bearer returns use nonextractable initiating P-256 ECDH private keys, separate HKDF purposes for AES-GCM encryption and receipt HMAC, and exact provider/state/redirect URI authenticated data. BroadcastChannel carries ciphertext only; no bearer enters storage, logs or a public receipt.

The initiating receiver journals observed bearer material durably before acknowledging the callback. Cancellation during journaling lets durable retention and the authenticated receipt finish. The runtime then refuses activation when consent or its originating lifetime was canceled; the observed credential remains sealed and actionable in recovery. An acknowledged grant is never silently discarded. Malformed minted token details preserve the observed access token for cleanup with protocol validity false. Denial is a separate encrypted outcome. A same-origin peer cannot forge delivery completion using a public ciphertext digest; acknowledgement requires a shared-secret HMAC. Callback fragment is scrubbed before asynchronous encryption. The forged-public-receipt regression test confirms that the sender does not complete until the durable recipient emits its shared-secret receipt.

Activation checks the captured authorization guard immediately before the durable atomic close. Cancellation before that commit boundary aborts the staged activation and preserves sealed recovery; canceling an already committed operation cannot undo its completed atomic write.

Provider-issued credentials survive verification failures in sealed recovery until truthful cleanup. Databricks/Discord unobserved replies retain sanitized `authorization_outcome` metadata, make no remote revocation claim, and allow honest local credential forgetting once the finite exchange has settled. Fresh verified grants clear that audit outcome. Provider configuration mutations retain stricter cleanup requirements; these exceptions apply only to the named provider-owned issued OAuth credentials.

## Source receipts

Official source fetch inventory covers 41 candidate providers beyond the nine existing browser profiles. The underlying catalog has 50 manual OAuth presets and three dynamic-registration presets; this fetch inventory is not a complete independent review of all 225 cards. Fetch denial is a research limitation, not evidence that a provider lacks public-client support. The following is a fetch inventory, not a functional-support claim:

| Provider | Official source | Fetch receipt |
| --- | --- | --- |
| asana | https://developers.asana.com/docs/oauth | HTTP Error 403: Forbidden |
| bamboohr | https://documentation.bamboohr.com/docs/getting-started | HTTP Error 403: Forbidden |
| beehiiv | https://developers.beehiiv.com/oauth2 | 200 |
| bitbucket | https://developer.atlassian.com/cloud/bitbucket/oauth-2/ | 200 |
| calendly | https://developer.calendly.com/docs/authentication/creating-an-oauth-app | HTTP Error 403: Forbidden |
| canva | https://www.canva.dev/docs/connect/authentication/ | HTTP Error 403: Forbidden |
| clickup | https://developer.clickup.com/docs/authentication | HTTP Error 403: Forbidden |
| convex | https://docs.convex.dev/platform-apis/oauth-applications | 200 |
| crowdin | https://support.crowdin.com/developer/authorizing-oauth-apps/ | 200 |
| discord | https://docs.discord.com/developers/topics/oauth2 | HTTP Error 403: Forbidden |
| docusign | https://developers.docusign.com/platform/auth/confidential-authcode-get-token/ | 200 |
| dropbox | https://developers.dropbox.com/oauth-guide | 200 |
| figma | https://developers.figma.com/docs/rest-api/oauth-apps/ | <urlopen error Tunnel connection failed: 403 Forbidden> |
| gitee | https://gitee.com/api/v5/oauth_doc | 200 |
| github | https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps | 200 |
| gitlab | https://docs.gitlab.com/api/oauth2/ | 200 |
| google | https://developers.google.com/identity/protocols/oauth2/web-server | 200 |
| harvest | https://help.getharvest.com/api-v2/authentication-api/authentication/authentication/ | HTTP Error 403: Forbidden |
| hubspot | https://developers.hubspot.com/docs/guides/apps/authentication/working-with-oauth | HTTP Error 403: Forbidden |
| intercom | https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/setting-up-oauth | 200 |
| jira | https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/ | 200 |
| linkedin | https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow | 200 |
| microsoft | https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow | 200 |
| microsoft-teams | https://learn.microsoft.com/en-us/graph/teams-concept-overview | 200 |
| monday | https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow | HTTP Error 403: Forbidden |
| notion | https://developers.notion.com/docs/authorization | 200 |
| photon | https://photon.codes/docs/api-reference/oauth | HTTP Error 403: Forbidden |
| reddit | https://github.com/reddit-archive/reddit/wiki/OAuth2 | 200 |
| sanity | https://www.sanity.io/docs/oauth2 | 200 |
| sentry | https://docs.sentry.io/api/auth/ | 200 |
| shopify | https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant | 200 |
| spotify | https://developer.spotify.com/documentation/web-api/tutorials/code-flow | 200 |
| twilio | https://www.twilio.com/docs/iam/oauth-apps/org-oauth-apps | 200 |
| twitch | https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/ | 200 |
| typeform | https://www.typeform.com/developers/get-started/applications/ | 200 |
| vercel | https://vercel.com/docs/sign-in-with-vercel/authorization-server-api | 200 |
| webflow | https://developers.webflow.com/data/reference/oauth-app | HTTP Error 403: Forbidden |
| whoop | https://developer.whoop.com/docs/developing/oauth | 200 |
| workday | https://doc.workday.com/ | 200 |
| zeplin | https://docs.zeplin.dev/docs/authentication | HTTP Error 403: Forbidden |
| zoom | https://developers.zoom.us/docs/integrations/oauth/ | 200 |

Repository evidence receipts: [official Vercel source hashes](provider-authentication/vercel-source-receipt.json), [Vercel CORS](provider-authentication/vercel-cors-management.json), [public PKCE CORS](provider-authentication/public-pkce-cors.json), [additional public-client CORS](provider-authentication/additional-public-client-cors.json), [Twitch browser OPTIONS](provider-authentication/twitch-browser-options.json), [Discord/Reddit Chromium fetch](provider-authentication/discord-reddit-browser-fetch.json), and [candidate official source fetch inventory](provider-authentication/candidate-official-source-fetch.json). These contain public source/probe receipts without user credentials.

## Executable contracts

- [Signed Vercel account verification](../../packages/app-core/src/lib/native-vercel-verify.test.ts) uses generated RSA signatures to check issuer, audience, nonce, signing key and resource subject agreement.
- [Tenant OAuth verification](../../packages/app-core/src/lib/native-tenant-oauth.test.ts) checks provider/tenant binding, signed assertions and authenticated resource subjects.
- [Approved PKCE provider flows](../../packages/app-core/src/lib/native-approved-oauth-flows.test.ts) exercise Codeberg repositories, Crowdin provider-managed scope responses and Databricks SCIM resource reads.
- [Discord approved consent and cancellation](../../packages/app-core/src/lib/native-discord-consent.test.ts) checks pre-ACK durable retention, actual application/user checks, unobserved replies and canceled handoff refusing activation while retaining cleanup capability.
- [Discord guild permission and resource operation](../../packages/app-core/src/lib/native-discord-operations.test.ts) checks actual scope admission and safe server link projection.
- [Databricks consent and lost-reply recovery](../../packages/app-core/src/lib/native-databricks-cleanup.test.ts) checks the documented DELETE route, immutable workspace targeting, honest remaining-token outcomes and finite unobserved-reply recovery.
- [Ephemeral bearer encryption](../../packages/app-core/src/browser/native-implicit-crypto.test.ts), [durable encrypted handoff / cancellation / forged-ACK refusal](../../packages/app-core/src/browser/native-implicit-session.test.ts) and [fragment capture](../../packages/app-core/src/browser/native-implicit-return.test.ts) check encryption to one nonextractable initiating key and exact provider/state/deployed callback binding.
- [Canceled token exchange, API verification and guarded final activation](../../packages/app-core/src/lib/native-approved-oauth-cancellation.test.ts) checks late minted replies remain sealed, canceled account verification cannot activate and cancellation before the durable close aborts activation while preserving prior recovery.
- [Unexchanged popup dismissal](../../packages/app-core/src/lib/native-browser-oauth-cancel.test.ts) checks matching pending state removal and preserves a newer consent.
- [Twitch public device consent](../../packages/app-core/src/lib/native-twitch-device.test.ts), [public token protocol](../../packages/app-core/src/lib/native-twitch-device-protocol.test.ts) and [rotating token recovery](../../packages/app-core/src/lib/native-twitch-device-refresh.test.ts) check provider-approved device flow and retained old/new grants.

These unit/contract tests use issued-token fixtures or generated cryptographic keys. They do not assert provider account grants occurred live. The real browser fetch receipt establishes Discord API CORS reachability with a deliberately invalid bearer; it is not an authenticated account grant. Authenticated live OpenBao/Vault authorization evidence belongs to the separate provider-auth validation suite.
