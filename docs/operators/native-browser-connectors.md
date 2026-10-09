# Use provider connectors in a self-hosted browser

The Connections page configures the selected provider and verifies real access.
It runs directly in the browser, without a connector relay or a browser client
secret. The [support matrix](native-connector-support.md) covers all 225 listed
provider identities (160 tiles appear in Add a connection), including unavailable
native and confidential methods. Feature-bound provider categories route to their
settings rather than appearing as duplicate browse tiles. Existing
[Linear setup](connect-connectors.md#connect-linear), Git backup, GitHub, S3 and
vault-key protection keep their specialized experiences.

## Deployment requirements

Use a build that contains and approves `connectors.external`, then enable it in
**Settings › Capabilities** and unlock the vault. Operator permission, compiled
code and device selection are separate gates; see
[capability composition](capability-composition.md). The instance network policy
must allow external services and any non-empty `allowedServiceOrigins` list must
admit each actual API, issuer, token, discovery and registration origin. CSP must
admit the same calls. A request cannot bypass provider CORS using this app.

Set `PAGES_CANONICAL_ORIGIN` to the exact deployment origin and `VITE_BASE` to its
path with a trailing slash before building. For example:

```text
PAGES_CANONICAL_ORIGIN=https://connections.example.com
VITE_BASE=/vault/
OAuth callback=https://connections.example.com/vault/auth/native-connector.html
CIMD client ID=https://connections.example.com/vault/auth/native-client.json
```

Deploy both generated documents at those paths, without rewriting them to the
SPA index. Register the **exact displayed callback URL** at providers that
require application registration. The callback bridge removes original
`code/state/error` parameters and forwards the namespaced transaction to
Connections before identity bootstrap. It never trusts a URL provider name as
an authorization binding. Linear uses its separate `auth/linear.html` callback.

HTTPS builds emit `auth/native-client.json` with the canonical client ID,
callback, public `none` authentication and authorization-code metadata. WorkOS
and CIMD MCP servers require that publicly retrievable HTTPS document. Resend
REST OAuth is unavailable under the [audited resource policy](native-browser-preflight-policy.md);
its independently supported CIMD MCP route remains available.
An HTTP loopback callback is accepted only where the provider's public-client
contract permits it; loopback HTTP does not support CIMD. Application IDs and
client metadata are public deployment data. Do not put a client secret in them.

Follow [Pages origin deployment](pages-origin.md) for security-profile and
actual header configuration. `PAGES_HEADER_SECURITY=1` preserves enforced
COOP/COEP. **Google GIS authorization is unavailable under that isolation**,
including a browser that reports `crossOriginIsolated`. Its popup needs opener
access. A permitted non-isolated build admits only the official
`https://accounts.google.com/gsi/client` script and Google frame origin; the
script is loaded on authorization. Changing a connector field never weakens
vault headers. Google identity sign-in is a separate feature.

## Verify an API key

The compiled browser has 75 API-key provider IDs; Railway's account, workspace
and project variants make 77 credential profiles. Four payment-policy entries
are refused. The [audited preflight policy](native-browser-preflight-policy.md)
disables 27 more provider IDs (29 profiles), leaving 44 route-admitted IDs/profiles,
five of which have tenant/key-dependent URLs with untested CORS. The
[contract table](native-api-key-contracts.md) lists required fields, exact
credential placement, provider setup links and real verification probes.

1. Open **Connections › Add a connection** and select the provider. If its API
   route is unavailable, read the exact endpoint evidence and choose an independently
   supported method such as MCP when offered. Unavailable routes collect no key.
2. Choose **API Key**, create a restricted credential using its setup link,
   and fill that provider's required tenant, project or additional fields.
   Select the credential type when the provider offers variants.
3. Submit the form. The app waits for the provider probe and encrypted save.
   Invalid credentials, a denied origin, provider errors or a failed save
   report a failure and cannot produce verified access.
4. Use **Check [provider] access** to repeat the real compiled read. Inspect
   the returned label/resource summaries. A resource-list proof establishes
   key access, not an account identity or every permission that key might have.

Keys and provider-managed permissions are not OAuth scope grants. Provider
headers, Basic authentication, query placement and required verification bodies
follow the specific contract. No arbitrary secret map is sent to an inferred
`/<provider>/<operation>` URL. The browser does not offer unimplemented business
mutations just because a credential verifies.

Vault and OpenBao additionally support your own **Instance HTTPS origin**,
optional namespace and token. Configure that instance's CORS policy for this
app's exact origin; token `lookup-self` verifies access. This instance route does
not accept embedded URL credentials or a user-selected API path.

## Authorize a public REST application

Choose the provider's public OAuth method, enter its registered public client
ID when requested, retain the locked account-verification permissions, and
select only additional permissions you need. Save the configuration, then press
**Authorize** in the summary and complete the real provider consent. Saving
alone remains pending. The verified summary shows actual granted permissions,
account/resource evidence and any reported expiry.

| Provider | Setup and verification | Renewal / disconnect |
| --- | --- | --- |
| [GitLab](https://docs.gitlab.com/api/oauth2/) | Register a public GitLab.com PKCE app; required `read_user`; actual `/api/v4/user` proof. The compiled instance is GitLab.com. | Refresh supported; provider form revocation. Existing Git backup is separate. |
| [Microsoft / Teams](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) | Register the callback as a **SPA**, with `openid` and `User.Read`. Choose `common`, `organizations`, `consumers` or a tenant GUID. Signed token tenant/account must match Graph `/me`. | Refresh when granted. Local disconnect does not revoke provider-wide consent; use Microsoft application settings. |
| [Dropbox](https://developers.dropbox.com/oauth-guide) | Register a public PKCE app, with `account_info.read`; actual `users/get_current_account` proof. This route requests short-lived online tokens. | Reconsent at expiry; no invented refresh token. Bearer token revocation supported. |
| [Spotify](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) | Register a public PKCE app and callback; required `user-read-private`; actual `/v1/me` proof. Provider account/app eligibility still applies. | Refresh when granted; revoke app access in Spotify settings. |
| [Google](https://developers.google.com/identity/oauth2/web/guides/use-token-model) | Configure a GIS web client and authorized origin. Official token popup; `openid` and canonical user-info email scope; actual user-info subject proof. Strict vault isolation makes this method unavailable. | Short-lived token requires reconsent. No fake refresh. Google token revocation supported. |
| [OpenRouter](https://openrouter.ai/docs/guides/overview/auth/oauth) | Provider key PKCE creates a real key; actual `/api/v1/key` verifies key access. No confidential application secret. | Provider-managed key lifetime; local forget plus explicit provider key-settings revocation. |
| [WorkOS](https://workos.com/docs/authkit/connect/oauth) | Managed public CIMD client ID derives from this HTTPS deployment; metadata must match the compiled issuer. Required `openid email`; actual user-info `sub/email` proof. | Refresh when granted; provider form revocation. |
| [Resend](https://resend.com/docs/guides/building-a-resend-oauth-client) | Public CIMD authorization is documented, but the compiled `/domains` resource preflight refuses browser access. REST OAuth is unavailable; select eligible CIMD MCP. | Existing grants retain cleanup: revoke the refresh grant; an access JWT cannot be individually revoked. |

These are nine compiled profiles because Microsoft and Microsoft Teams have
separate connector IDs. **Verify [provider] access** can refresh an expired
refreshable grant and restores provider proof; non-refreshable or reduced grants
require authorization again. Required permissions cannot be silently removed
or silently added after explicit deselection.

## Connect a public MCP server

Select the provider's MCP method and its advertised permissions. Public support
requires complete protected-resource/issuer discovery, `none` token
authentication, S256, and supported registration. The compiled catalog currently
has 71 such metadata contracts (46 DCR and 25 CIMD), including Linear's published
MCP metadata; Linear's default page retains its specialized direct experience.
These counts describe contracts, not successful live account connections.

**Managed MCP** registers through the actual DCR endpoint or uses the deployment's
CIMD document. A manual public registration requires the actual public client ID.
Live discovery must agree with the compiled issuer/resource/endpoints and the
returned client must be public. A secret-bearing registration result is refused
and retained for cleanup rather than exposed or used as a browser secret.

After consent, the app performs real initialization and tool discovery before
reporting verified access. **Discover MCP tools** shows the server's actual tools.
Select a tool, enter JSON arguments matching its advertised schema, and invoke
it explicitly. Results and errors are awaited, bounded and displayed; advertised
read-only annotations are provider declarations, not authorization proof. The
browser neither invents tool names nor assumes every tool is a safe read.

Input and structured-output schemas are checked before validation. Unsafe regular
expressions, recursive or remote references, dynamic schema rebasing and excessive
validation work produce a browser-safety refusal. Finite local references, unions,
UUID patterns and supported anchored character classes remain usable. The schema
limit is 32 KiB serialized, with at most 512 JSON nodes and depth 24; argument and
output traversal also has node, string and work limits. If a tool exceeds these
limits, ask its provider to simplify the schema or request smaller arguments and
results. The browser keeps its existing CSP and does not silently accept an
unsupported schema.

Confidential and incomplete MCP contracts show unavailable explanations. A DCR
label by itself does not establish public-client support. If the provider offers
another compiled API-key or public REST method, choose that supported alternative.

## Encrypted persistence and recovery

Configuration, verified facts, credentials, pending consent and cleanup state
commit in one encrypted device record. Public form drafts and summaries expose
no keys, access/refresh tokens or registration secrets. OAuth redirect flows
require durable storage so the sealed ten-minute state/verifier survives
navigation. A session-only configuration is identified as such and cannot
pretend to survive a redirect or cold restart.

Reloading the page does not remove encrypted connectors. With a PIN-sealed vault,
a cold reload requires PIN unlock before the private records and provider calls
are available. Unlock restores stored evidence, not a new live validation;
**Check access** or **Verify [provider] access** performs a fresh provider check.
Neither the PIN nor provider credentials belong in screenshots or output logs.

Edits are revision/fingerprint guarded. Safe display-name changes preserve a
compatible grant; changing authority, client, method, target or scopes requires
cleanup or a separate connector according to that provider's form. A concurrent
edit or disconnect refuses stale work instead of adopting the newest record.

A token, registration or refresh mutation first seals a recovery intent. Known
returned credentials are retained before activation checks, including responses
that finish after capability withdrawal. A failed save or cleanup leaves
**Provider cleanup required**, with **Retry** controls. Finish that obligation
before authorizing again, changing the binding or removing the connection.

Where provider settings are needed, follow **Open provider revocation
instructions**, revoke the application/key there, then explicitly confirm that
action. Confirmation is a human attestation that clears failed authorization;
it does not verify working access. Pending mutations cannot be confirmed while
in flight. After an indeterminate deadline, retry cleanup to refresh the controls.
If storage and remote cleanup both fail, complete the provider action before
closing the browser; a process crash cannot recover an unsealed unknown grant.

**Remove connection** asks for confirmation and awaits exact provider-supported
cleanup plus durable local deletion. Shared API keys are forgotten locally;
revoke them in the provider console to invalidate their other uses. Providers
without a revocation API retain provider authorization after local disconnect,
as the summary explains. Successful removal cannot resurrect a legacy row on
reload. An unresolved registration or token-cleanup obligation remains visible.

## Native limits and verification evidence

Tailscale enrollment needs `tailscaled` and the OpenSesame native daemon;
[configure and pair that daemon](tailnet-devices.md). OS keychains, CLI password
stores and native password-manager integrations use their companions. Supported
**Vault › Import items** export files produce a local snapshot, not a running
provider connection. Wallet and refused payment routes do not collect issuer or
signing credentials. Confidential OAuth and hosted managed provisioning have no
browser relay; the page names the constraint instead of offering a dead form.

Only the specialized Linear flow registers webhooks. Other catalog trigger
metadata does not imply a registered subscription, receiver or business API.
Hosted Vercel imports remain a separate optional integration, not a prerequisite
for these direct-browser contracts.

[ADR 0185](../adr/0185-native-browser-connectors.md) describes the implementation.
Unit/protocol tests and production desktop/mobile browser journeys exercise real
application code against disclosed synthetic provider authorities, including
credential refusal, callback replay, tool calls, concurrency, cleanup and
PIN-sealed cold reload. They prove the tested protocol/UI behavior, not live
provider account consent or universal browser CORS. Operators must register their
own applications and verify their allowed origins and live provider permissions.
