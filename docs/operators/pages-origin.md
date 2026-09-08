# Pages origin and static relying parties

The default path-hosted GitHub Pages build is `shared_origin_demo`. Paths do
not isolate browser storage or scripts. It retains the offline vault, guest
entry and the compiled Google-via-Shoo entry, but cannot pair to local authority.
No runtime endpoint setting changes this decision.

Before building, run `node apps/pages/scripts/security-profile.mjs`. Its JSON
output is imported into the application at build time and also distributed for
inspection. Configuration:

| Profile | Required settings |
| --- | --- |
| `shared_origin_demo` | Default; canonical origin defaults to the existing project origin |
| `loopback_development` | `PAGES_CANONICAL_ORIGIN` must be an exact loopback origin |
| `dedicated_origin` | Exact HTTPS `PAGES_CANONICAL_ORIGIN` and `PAGES_HEADER_SECURITY=1` |

Set `PAGES_DEPLOYMENT_PROFILE` explicitly for the latter two. A mismatched
runtime origin loses pairing eligibility, never guest or offline vault access.
The header-security flag is an operator deployment assertion, not a browser
proof: configure actual HTTP CSP including `frame-ancestors`, nosniff,
Referrer-Policy, Permissions-Policy and the appropriate opener/embedder policy.
Meta CSP alone is insufficient. Verify custom domains in the GitHub account,
configure DNS and HTTPS, and dedicate the origin to this application; a project
path or domain name alone does not establish isolation.

## Static authentication

`@opensesame/static-auth` is the canonical browser implementation. The recommended
remote-RP profile is `hosted_identity`: a configured Identity issuer, RP client
ID, exact redirect URI, and same-issuer authorization/token/JWKS endpoints.
The issuer must support PKCE S256, nonce, `iss` authorization responses, and
exact-origin CORS on token and JWKS endpoints. No browser client secret exists.
The SDK consumes a five-minute transaction before exchanging the code, verifies
signature, issuer, RP audience, nonce and times, and strips callback parameters.
The result is a validated RP subject and expiry, not an API authorization token.

Generated remote snippets read `/opensesame-auth-profile.json` from the RP's own
origin. Publish the explicit profile there; it contains no secrets. For example,
a local Identity deployment may use:

```json
{
  "profile": "hosted_identity",
  "issuer": "http://127.0.0.1:8788",
  "clientId": "origin:http://localhost:5173",
  "redirectUri": "http://localhost:5173/opensesame/callback",
  "authorizationEndpoint": "http://127.0.0.1:8788/auth",
  "tokenEndpoint": "http://127.0.0.1:8788/token",
  "jwksUri": "http://127.0.0.1:8788/jwks"
}
```

`pages_passthrough_loopback` is explicit development compatibility only. Both RP
and broker refuse remote RP origins. A popup response must match the exact
window, origin, state and five-minute transaction. Shoo issuer and broker
audience are RP configuration, never response metadata. The SDK requires Shoo's
pinned `/session/check` to return `status: active`; redirects, transport errors,
oversized bodies, expired claims and unavailable checks refuse authentication.
No browser JWKS request to Shoo occurs. The broker token is transferable and is
not an RP-audienced credential; this profile cannot be promoted to production by
adding a domain rule. Tokens never travel in fragments or authenticated events.

## Immutable distribution and recovery

Commit the SDK build inputs, then run
`node apps/pages/scripts/build-static-auth.mjs` using the repository's Vite.
It emits an immutable versioned SDK, SHA-384 SRI sidecar and source-commit
manifest. Rebuilding an existing version with different bytes fails. New
snippets pin those bytes with SRI and anonymous/no-referrer attributes; the
legacy `/auth.js` alias is the same secure implementation, without automatic
unverified sign-in. Self-host the exact artifact or import the workspace package.
SRI pins bytes, not publisher trust or absence of vulnerabilities.

`pnpm lint:artifacts` verifies the exact manifest inventory, regular files (no
symlinks), SHA-384 sidecars, JavaScript syntax, and byte-for-byte rebuilds from
the current checkout. Published hashes in the base branch are an immutable floor;
changing a bundle and its local hash together still fails. It also runs the SDK source tests and shipped-artifact
behavior tests. Both `pnpm lint` and `pnpm lint:all` require this gate. Only the
two explicit generated bundles use this policy in place of authored-code Biome
rules; their source and all other files retain normal lint. Undeclared artifacts
or broader exceptions fail the gate. The recorded source commit identifies the
creation point; reproducibility is checked against current source even after a
squash merge changes ancestry. It is not a signature or publisher attestation.

Old consumers must explicitly choose one of the two profiles. The insecure
`acceptSession` and unverified `signIn` API semantics are removed. Roll back a
client deployment to a previously reviewed immutable secure SDK if needed;
never restore unverified events or fragment transport as a compatibility fix.
