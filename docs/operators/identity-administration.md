# Identity administration

OpenSesame's Identity API is an OIDC issuer, separate from the Host API and
the offline vault. The Pages **Identity** screen is its administration client;
registering an upstream provider is optional, not a prerequisite to opening it.

## Connect

Enter the Identity API address in the **Sign-in service** field of the
**Connect a sign-in service** panel on the Identity screen; once an address
is saved the panel offers **Connect**. Administrative requests use the signed-in Identity session, never a
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

## Who may ask whom: authorization requests and interactions

An agent's action that needs a person is an **authorization request** (ADR
0046) fronted by an **interaction** (ADR 0086) the person answers with a
passkey. The Identity API holds four rules here; they are not settings.

- **The caller is never the approver.** `POST /v1/interactions` over an
  `authorization_request` refuses a caller whose principal is the principal the
  inbox handle names. An agent that runs as its owner therefore cannot put a
  question to its owner and have the same principal answer it. The refusal is
  `404 interaction_not_found`, the same answer as an unverifiable handle, so it
  does not reveal who a handle belongs to. Device, pairing, claim and
  transaction interactions are not bound this way: one person routinely starts
  them on one device and approves them on another.
- **Only the addressee is asked.** The interaction's approver must be the
  principal the request was addressed to. A requester cannot raise a request to
  one person and front it with a question to somebody else.
- **The requester can take a question back.** `POST
  /v1/authorization-requests/{id}/cancel` withdraws a request nobody has
  answered (`cancelled`, no decider recorded) and revokes the interaction
  fronting it, so nothing stays approvable and nothing stays in the approver's
  inbox. Only the requester may call it; everyone else, the approver included,
  gets `404 not_found`. Withdrawing twice answers the same state; a request
  already approved, refused or lapsed keeps that ending (`409
  request_not_pending`, `410 expired_request`). The agent-hooks Interaction
  approver (`crates/agent-hooks`, ADR 0159) calls it on every exit that is not
  an approval.
- **A refusal is not silence.** Spending an interaction a person refused
  (`POST /v1/interactions/{ref}/consume`) answers `403 approval_denied`, final.
  An interaction nobody has answered yet still answers `401 approval_required`.

If an approval never arrives, check first that the requester's bearer belongs
to a different principal than the approver's inbox handle: a deployment that
runs its agents under its operators' own credentials will see every such
request refused with `interaction_not_found`, by design. Give the agent its own
principal.

