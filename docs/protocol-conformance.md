# Protocol conformance (identity plane)

Mandatory local suite does **not** require cloud IdP credentials.

| Feature | Spec | Library | OpenSesame-owned |
|---------|------|---------|------------------|
| OIDC discovery / JWKS | OIDC Core, RFC 8414 | oidc-provider | Mount + issuer config |
| Auth code + PKCE S256 | RFC 7636 | oidc-provider | Public-client policy |
| Device authorization | RFC 8628 | oidc-provider | Domain projection + console UX |
| PAR | RFC 9126 | oidc-provider | Feature enabled |
| Resource indicators | RFC 8707 | oidc-provider | Client allowlists |
| DPoP | RFC 9449 | oidc-provider | CLI/agent preference |
| Revocation / introspection | RFC 7009 / 7662 | oidc-provider | Policy gates for introspect |
| Pairwise `sub` | OIDC Core | oidc-provider + store | Sector mapping table |
| Protected resource metadata | RFC 9728 | Hono | `/.well-known/oauth-protected-resource` |
| Passkeys / anonymous | WebAuthn L3 | Better Auth | Principal mapping adapter |
| Origin client profile | OpenSesame (not IETF) | OpenSesame | Feature flag + restrictions |
| CIMD | Draft | oidc-provider (gated) | SSRF fetcher; **disabled by default** |
| DCR | RFC 7591 | oidc-provider (gated) | **Disabled by default** |
| auth.md / Agent Card | Product profile | agent-protocols | Generated from config |

## Draft features (pinned / gated)

| Flag | Default | Fallback |
|------|---------|----------|
| `OPENSESAME_ORIGIN_CLIENTS_ENABLED` | false | Pre-registered clients only |
| `OPENSESAME_CIMD_ENABLED` | false | Reject URL client_ids |
| `OPENSESAME_DCR_ENABLED` | false | `/reg` denied |
| ATProto / Nostr adapters | disabled | Interfaces only until mandatory green |

Do **not** claim OAuth 2.1 RFC compliance; follow RFC 9700 BCP.

## Trust-broker implementation status

The repository also ships the trust-broker domain contracts and assurance
evaluator. OIDC4VP, OIDC4VCI, FedCM, Digital Credentials API, OpenID
Federation, SD-JWT VC, and Token Status List adapters are not implemented in
this slice and their flags default to `false`. No conformance or hardware
assurance claim is made for those protocols.

The implemented invariant surface is covered by
`packages/trust-broker/src/index.test.ts`: evidence expiry, subject-kind
separation, and the non-equivalence of MFA and phishing resistance.
