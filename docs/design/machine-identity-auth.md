# Machine identity authentication parity

Competitive contract for machine identities against
[Infisical machine identities](https://infisical.com/docs/documentation/platform/identities/machine-identities)
and every authentication method Infisical documents for them.

Status: research and target design. It does not claim the inbound methods are
implemented. The "OpenSesame now" column says what this checkout actually has.

## Shared model

Infisical machine identities are principals with one role, one or more auth
methods, and project membership. Every method except Token Auth exchanges a
proof for a short-lived access token. The token settings are shared:

| Setting | Default | Meaning |
|---|---|---|
| Access Token TTL | 30 days | Lifetime of one issued token; used at renewal |
| Access Token Max TTL | 30 days | Hard cap on the token's total life |
| Access Token Max Uses | unlimited | Exact when finite; approximate when unlimited |
| Access Token Period | none | Renewable non-expiring token; TTL/Max TTL ignored |
| Access Token Trusted IPs | `0.0.0.0/0` | CIDRs that may present the token |
| Renewal | per TTL | Extends life by one TTL, never past Max TTL |
| Revocation | explicit | Token, credential, auth method or identity removal |
| Lockout | 3 failures / 5 min | Universal Auth and LDAP Auth only |

Universal Auth adds per-client-secret settings: description, TTL (0 = never),
max uses (0 = unlimited), last-used metadata, and lockout. Token Auth adds a
named direct token with TTL, max uses, and expiry alerts. Auth method changes
and credential expiration are alertable.

Infisical keeps access tokens as bearer JWTs. A copied token works until it is
revoked or expires. That is the main property OpenSesame should not copy.

## Every auth method

| # | Method | Proof presented | Infisical verifies with | Allowlist / binding | OpenSesame now |
|---|---|---|---|---|---|
| 1 | Universal Auth | Client ID + client secret | Its own stored secret hash | Client-secret TTL/uses; trusted IPs; lockout | Outbound Infisical connector only; local agent keys use ES256 proof, not a client secret |
| 2 | Kubernetes Auth | Service-account JWT | Kubernetes TokenReview API | Host, reviewer JWT / self / gateway, namespaces, service accounts, audience, API CA | None |
| 3 | AWS Auth | SigV4-signed `GetCallerIdentity` | AWS STS | Allowed principal ARNs, account IDs, STS endpoint | Outbound AWS connector only |
| 4 | GCP Auth — ID token | Google-issued ID JWT | Google OAuth2 certs | Service-account emails, projects, zones | Outbound GCP connector only |
| 5 | GCP Auth — IAM | Service-account-signed JWT | Google public key from the signed JWT | Service-account emails | Outbound GCP connector only |
| 6 | Azure Auth | Managed-identity access JWT | Entra ID OpenID keys | Tenant ID, resource/audience, service-principal IDs | Outbound Azure connector only |
| 7 | Alibaba Cloud Auth | HMAC-SHA1-signed `GetCallerIdentity` | Alibaba Cloud | Allowed ARNs | Outbound connector only |
| 8 | OCI Auth | OCI Signature v1 `GET /users/{id}` | OCI Get User | Tenancy OCID, allowed usernames | Outbound OCI connector only |
| 9 | JWT Auth | JWT from any issuer | Static PEM keys or JWKS | Issuer, audiences, subject, claims; glob matching | Not an inbound machine method |
| 10 | Token Auth | Direct access token | Its own token hash | TTL, max uses, trusted IPs | No machine token; human/device sessions only |
| 11 | SPIFFE Auth | JWT-SVID | Static JWKS or SPIRE HTTPS Web Bundle | Trust domain, SPIFFE ID globs, audiences, refresh hint | X.509-SVID/mTLS transport identity, not JWT-SVID login |
| 12 | TLS Certificate Auth | TLS client certificate | Configured CA; direct issuer or full chain | Common names, typed SANs, name constraints, EKU, path length | mTLS transport identity, not a login-token exchange |
| 13 | OIDC Auth | OIDC ID token | OIDC discovery + JWKS | Discovery URL, issuer, audience, subject, claims, CA | Human OIDC/SAML; not machine login |
| 14 | LDAP Auth | LDAP username + password | LDAP bind + search | URL, bind DN/pass, search base, filter, required attributes, CA, lockout | None |
| 15 | Service token (legacy) | `st.<id>.<secret>` | Stored token | Environment/path scopes, read/write, expiry | No equivalent; agent keys and device sessions are not project tokens |

OIDC presets are not separate verification methods: GitHub Actions, Azure
DevOps, CircleCI, GitLab, Terraform Cloud and SPIFFE/SPIRE all use the same
OIDC discovery/JWKS checks with provider-specific subject and claim guidance.
LDAP JumpCloud is the same LDAP method with a preset. GCP is one method with
two proofs. Kubernetes has three reviewer modes, not three methods.

## Method details to preserve

### Universal Auth

- Login: `POST /api/v1/auth/universal-auth/login` with `clientId`,
  `clientSecret`.
- Response: `accessToken`, `expiresIn`, `accessTokenMaxTTL`, `tokenType`.
- Renew: `POST /api/v1/auth/universal-auth/renew` while a periodic token is
  live.
- Periodic token: a period makes the token renewable indefinitely (unless a
  use limit applies); TTL and Max TTL are ignored.
- Client secrets: independent TTL and max uses; finite uses are exact.
- Lockout: threshold, duration and counter-reset window; reset all lockouts.
- Trusted IPs: separate lists for client secret and access token.
- Alerts: client-secret expiry and auth-method/credential changes.

### Kubernetes Auth

- Client reads `/var/run/secrets/kubernetes.io/serviceaccount/token`.
- Server calls TokenReview with a reviewer JWT, the client token itself, or a
  gateway's service account.
- Bind namespace and service-account name; audience optional.
- Verify the API server TLS certificate unless explicitly disabled; CA is
  required when verification is on.

### AWS Auth

- Client signs `Action=GetCallerIdentity&Version=2011-06-15` with SigV4.
- Server reconstructs and sends it to the configured STS endpoint.
- Bind allowed principal ARNs (`user`, `role`, or account wildcard) and account
  IDs.
- Regions differ by STS endpoint; the endpoint is configuration, not trust.

### GCP Auth

- ID-token mode: fetch an identity token for the identity ID as audience; server
  verifies Google's RS256 signature against Google OAuth2 certs.
- IAM mode: service account signs a JWT with `sub` = service-account email and
  `aud` = identity ID; server verifies the signature and subject.
- Bind service-account emails; ID-token mode can additionally bind project and
  zone for GCE.

### Azure Auth

- Client gets a managed-identity access token for the configured resource.
- Server verifies it against the tenant's Entra ID OpenID configuration.
- Bind tenant, audience/resource and service-principal object IDs.

### Alibaba Cloud Auth

- Client signs a `GetCallerIdentity` query with HMAC-SHA1.
- Server reconstructs and verifies it with Alibaba Cloud.
- Bind allowed ARNs.

### OCI Auth

- Client signs `GET /20160918/users/{userId}` with OCI Signature v1.
- Server reconstructs and calls OCI Get User.
- Bind tenancy OCID and allowed usernames.

### JWT Auth

- Static RSA/ECDSA PEM public keys, or a JWKS URL with optional CA.
- Required issuer, subject, audiences and arbitrary claims.
- Glob matching is supported but hardcoded values are preferred.
- `*` matches separators too; this is broader than a path glob and must be
  documented at the field.

### Token Auth

- Operator creates a token once; the client presents it directly.
- Token has TTL, max uses and trusted IPs.
- Revocation is explicit; expiry alerts use the token's original expiry.
- This is a bearer credential by design. Any parity implementation must offer a
  proof-bound alternative, not only this mode.

### SPIFFE Auth

- JWT-SVID only; Infisical does not accept X.509-SVID for this auth method.
- Trust bundle is static JWKS or an HTTPS SPIRE bundle endpoint.
- Bind trust domain, allowed SPIFFE ID globs (`*` one segment, `**` many) and
  audiences.
- Bundle cache refresh hint defaults to one hour; remote refresh is possible.

### TLS Certificate Auth

- Client presents a TLS client certificate at login.
- CA may be direct issuer or trust anchor for a chain.
- Bind common names and typed SANs (`URI:`, `IP:`, `EMAIL:`, bare = DNS).
- Honor CA name constraints, EKU clientAuth, path length.
- Deployment must terminate TLS where the client certificate is proven; never
  trust a forwarded header without that handshake.

### OIDC Auth

- Discovery URL yields issuer and JWKS.
- Bind issuer, subject, audiences and claims; optional CA for private IdPs.
- Provider presets: GitHub, Azure DevOps, CircleCI, GitLab, Terraform Cloud,
  SPIFFE/SPIRE. They are documentation presets over the same checks.

### LDAP Auth

- URL (`ldap://` or `ldaps://`), bind DN/password, search base, user filter
  with `{{username}}`, required attributes, optional CA.
- Lockout applies.
- Bind is a proof of the directory password. TLS verification is mandatory for
  `ldaps` in our target, not optional.

## Auth templates

Infisical supports reusable machine-identity auth templates for LDAP,
Kubernetes and OIDC. Templates carry the shared connection/trust settings;
per-identity workload selectors and token settings stay on the identity.
Editing a template changes every linked identity. Deleting one leaves the
existing identity configuration but breaks the link.

Our equivalent must be a template record with a content digest and explicit
"used by" list. An edit is a new revision, not a silent mutation of every
identity; identities pin a revision and can be rolled forward deliberately.
That is a deliberate improvement over "edit propagates immediately".

## Native versus PWA

The proof source decides where a method can run.

| Method | Native | PWA | Reason |
|---|---|---|---|
| Universal Auth | Yes | Yes | Client ID/secret can be entered or sealed; login is HTTPS |
| Token Auth | Yes | Yes | Direct token, with the same bearer warning |
| JWT Auth | Yes | Yes | The issuer's JWT can be fetched or pasted; verification is server-side |
| OIDC Auth | Yes | Yes | Discovery/JWKS is HTTPS; browser can present the ID token |
| LDAP Auth | Yes | No | Browser cannot speak LDAP; a server-side bridge would be a new trust boundary |
| Kubernetes Auth | Yes | No | Service-account JWT and TokenReview belong to the workload/cluster |
| AWS Auth | Yes | No | SigV4 proof needs workload credentials; PWA must not receive them |
| GCP Auth | Yes | No | Metadata server or service-account signing is native-only |
| Azure Auth | Yes | No | Managed-identity token is native-only |
| Alibaba Auth | Yes | No | Access-key signing is native-only |
| OCI Auth | Yes | No | Private-key request signing is native-only |
| SPIFFE JWT-SVID | Yes | No | Workload API socket is native-only |
| TLS certificate | Yes | No | Browser `fetch` cannot present a chosen client certificate |

The PWA can *manage* all methods and display their status. It can *perform*
only the four HTTPS/JWT-shaped methods above. Native performs every method. A
PWA that pretends to offer Kubernetes or cloud-instance auth would either need
long-lived cloud keys in the page or a new server-side proxy; neither is
acceptable.

## Parity gaps in this checkout

Wired today:

- Local agent identity: ES256 public-key enrollment, signed challenge,
  120-second origin-bound evidence, 15-minute local session, per-key revoke.
- mTLS and SPIFFE X.509-SVID workload identity for transport.
- Human OIDC/SAML and device sessions.
- Outbound Universal Auth as an Infisical *connector* (`native-infisical.ts`),
  which is not an inbound OpenSesame auth method.
- Outbound AWS/GCP/Azure/OCI/Alibaba connectors.

Not wired today:

- Any inbound machine-identity login endpoint.
- Universal Auth client IDs/secrets with TTL/uses/period/lockout/trusted IPs.
- Direct Token Auth machine tokens.
- Inbound JWT/OIDC machine login with JWKS/discovery and claim binding.
- JWT-SVID SPIFFE login (X.509-SVID is transport only).
- TLS client-certificate login exchange (mTLS identity is transport only).
- Kubernetes, AWS, GCP, Azure, Alibaba, OCI and LDAP login proofs.
- Auth templates, identity credential-expiry/auth-change alerts, and
  machine-identity project roles.

## Target architecture

One `MachineIdentity` record, one `MachineAuthMethod` union, one token service.

```text
MachineIdentity
  id, name, role, projectBindings[]
  methods: MachineAuthMethod[]
  attributes: map          # ABAC inputs
  alerts: AlertRule[]

MachineAuthMethod
  id, identityId, kind, enabled, createdAt, updatedAt
  config (discriminated union per kind)
  tokenPolicy { ttl, maxTtl, maxUses, period, trustedCidrs }
  lockout { enabled, threshold, durationSec, resetSec }   # Universal, LDAP
  templateRef? { id, revision }

MachineAccessToken
  id, identityId, methodId, digest, issuedAt, expiresAt,
  maxUses, uses, proofKeyThumbprint?, revokedAt
```

Issued tokens should be **proof-bound by default**: the login returns a token
handle plus a DPoP key or mTLS binding. Token Auth remains available only as an
explicit compatibility mode and is marked bearer in the UI.

## Delivery slices

1. **Token service and Universal Auth.** Identity, method, client secret hash,
   TTL/max/uses/period, lockout, trusted IPs, revoke, renewal, alerts. Native and
   PWA login.
2. **Token Auth and JWT Auth.** Direct token compatibility plus static/JWKS
   JWT validation with issuer/audience/subject/claims.
3. **OIDC Auth.** Discovery, JWKS, CA, presets for GitHub/Azure/CircleCI/
   GitLab/Terraform/SPIRE.
4. **SPIFFE JWT-SVID and TLS certificate.** Reuse the existing SPIFFE and
   transport-security code; add JWT-SVID bundle modes and a login exchange.
5. **Kubernetes Auth.** Reviewer JWT, self-review and gateway modes; namespace,
   service-account and audience binding.
6. **Cloud auth.** AWS, GCP (both), Azure, Alibaba, OCI with per-method
   verifiers and allowlists.
7. **LDAP Auth and templates.** LDAP bind/search with `ldaps` required; templates
   for LDAP, Kubernetes and OIDC with pinned revisions.
8. **Alerts and access control.** Credential expiry and auth-method change
   alerts; native channel adapters; machine-identity roles and project bindings.

## Acceptance for parity

- Every method above has a login test with a positive proof and a negative
  proof, including a wrong audience, subject, namespace, ARN, account, tenancy,
  trust domain, SAN, CA, or password.
- Universal Auth: secret TTL, max uses, period renewal, max TTL, lockout,
  trusted IP, revoke and identity-delete paths are all covered.
- A copied bearer token fails where proof binding is required.
- LDAP and Kubernetes are refused from the PWA, not emulated.
- Every method supports a per-method disable and a per-credential revoke.
- No credential, client secret, token or proof appears in logs, URLs, model
  context, or a PWA-visible global.
- Auth templates cannot silently widen authority: an edit is a new revision and
  identities must roll forward.
