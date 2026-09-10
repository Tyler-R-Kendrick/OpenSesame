# Identity administration

OpenSesame's Identity API is an OIDC issuer, separate from the Host API and
the offline vault. The Pages **Identity** screen is its administration client;
registering an upstream provider is optional, not a prerequisite to opening it.

## Connect

Configure the Identity API under **Settings → Connectivity**, then connect from
Identity. Administrative requests use the signed-in Identity session, never a
Host operator credential. Production owners must authenticate using the
deployment's approved sign-in methods; connecting anonymously does not grant
organization ownership or verified assurance.

The shared-origin Pages demo cannot administer loopback services. Use an
explicitly configured loopback development build or dedicated-origin deployment
for local endpoints; do not weaken its deployment-profile checks. A remote
Identity deployment must explicitly allow the Pages origin. No backend is
required to keep using the vault or guest access.

## People and users

In **People → Users**, select an organization you own, then choose **New user**.
The username is the subject your organization's configured sign-in method will
verify. Edit a row to change its display name or directory activation state.
The server checks current ownership on every request.

These are the existing SCIM directory records, not a second user database.
Provisioning does **not** create a password, prove an email address, or mint an
authenticated principal. Verified sign-in establishes the canonical principal;
the existing organization provisioning policy determines admission. Enable
authoritative provisioning in the organization's server configuration when
the directory must be its allowlist. Deactivation uses the existing membership
and session revocation path. Removing a provisioned record does not erase the
deprovisioning tombstone.

Existing principal memberships and roles remain organization management, and
resource grants remain in **Access**. Directory provisioning is not a substitute
for either authorization boundary.

## Agents

**Agents → New agent** registers the agent's name and SHA-256 JWK thumbprint
from its runtime. Never paste its private key. The existing registration and
claim protocol binds the runtime key; registration itself grants no resource
access. The browser does not display the returned claim bearer.

Only the owner can list, rename or revoke these registrations. Revocation is
terminal, and further claim initiation is refused. This registry is distinct
from the AgentAuth OAuth protocol and from Host task runs; it does not mint an
OIDC application or a broad agent token.

## OIDC applications

**Applications** registers relying parties on this OpenSesame issuer. Enter an
application name, exact redirect URIs and subject sector. The built-in browser
profile uses authorization code with PKCE S256, without a browser client secret.
**Edit application** updates the name and redirects without changing the
existing subject sector. **Rotate client ID** revokes the previous registration
and creates a new ID; it is not secret rotation.

Use the screen's discovery link (`/.well-known/openid-configuration`) to obtain
the issuer, authorization, token and JWKS endpoints. Relying parties must check
issuer, audience, nonce and state and validate the signature. Do not use an
upstream broker token as a token minted for your application.

The `service-accounts` view URL remains compatible; its visible label is now
Applications. Agents have their own `?view=agents` URL, available through the
authored WebMCP navigation tool. Administrative mutations still require a human.
