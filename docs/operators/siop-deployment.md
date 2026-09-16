# Native SIOPv2 on Pages

Self-Issued OpenID Provider v2 (SIOPv2) runs entirely in the browser vault on
the Pages PWA. A relying party receives a Self-Issued ID Token whose ES256 key
never leaves the encrypted store. No Host, Identity API, or loopback service is
required for this profile ([ADR 0116](../adr/0116-browser-native-siop-v2.md)).

## Static deployments

**GitHub Pages** is the reference profile: ship the built `apps/pages` bundle with
`VITE_BASE` set to the repository path. The consent route lives at
`{origin}{base}identity/siop`. Cross-origin opener policy is `unsafe-none` only
on that route and on `/identity/authorize` so an RP popup can retain
`window.opener`; every other path stays `same-origin` with
`Cross-Origin-Embedder-Policy: require-corp`.

**Vercel** (or any static host) may serve the same artifact with hardened
headers or a custom domain. The SIOP ceremony still needs no server-side
signing—the vault mints the token locally. Hosted Identity on the control plane
remains a separate OIDC issuer; do not merge the two planes.

## Hosted bridge

Operators who need conventional OIDC tokens after a SIOP login use the hosted
SIOP→OIDC bridge described in
[ADR 0117](../adr/0117-hosted-siop-oidc-bridge.md). That path is optional and
distinct from native SIOP.

## Not supported

The experimental browser-signed conventional OIDC facade (ADR 0116 §5) is
**not implemented** and must stay disabled. Cloudflare-specific configuration is
out of scope for this repository.

## Verification

After a production build:

```bash
VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:siop
```

The harness registers local applications, walks SIOP consent with virtual
WebAuthn, captures the fragment redirect, and verifies the token with
`@opensesame/siop-v2`—without mocking the verifier.
