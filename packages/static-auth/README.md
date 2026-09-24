# @opensesame/static-auth

Sign-in for static sites with no backend of their own. It is the canonical
static integration: named profiles a relying party pins in its own
configuration, plus the browser-local profile that lets the Pages PWA act as
an identity broker for another origin. Its browser entry points are bundled
into versioned, SRI-pinned artifacts under
[`apps/pages/public/static-auth/`](../../apps/pages/public/static-auth).

## Where it fits

- **Used by:** [`apps/pages`](../../apps/pages) (`screens/LocalAuthorize.tsx`, the `identity.site-broker` module, local agent keys), [`packages/app-core`](../app-core), [`packages/control-plane`](../../packages/control-plane) (interoperability test and browser fixture), [`examples/static-rp`](../../examples/static-rp).
- **Builds on:** [`@opensesame/sdk-browser`](../sdk-browser) (PKCE, origin canonicalization, JWT envelope), [`@opensesame/os-domain`](../os-domain), `jose`.
- `hosted_identity` is the recommended remote-RP profile: authorization code with PKCE S256, an issuer, client, redirect and endpoints fixed by the RP (no discovery or callback metadata may replace them), and an ID token verified against the configured JWKS. No client secret reaches the browser.
- `pages_passthrough_loopback` is a local-development compatibility profile. It refuses a non-loopback relying-party origin and has no fragment fallback.
- `opensesame:signed_in` is dispatched only after the selected profile validated. Public results carry the subject and expiry, never bearer fields; errors are stable codes.

## Surface

| Export | What it does |
|---|---|
| `createHostedClient(profile)` | The `hosted_identity` profile client |
| `signInLoopback(profile)`, `validateLoopbackToken` | The loopback passthrough profile |
| `signInLocalBrowser(profile)` | Browser-local authorization against the Pages broker; returns `LocalBrowserIdentity` |
| `parseLocalAuthorizationRequest`, `localAuthorizationQuery`, `localMessage` | The local authorization request and popup message wire format |
| `createLocalAgentKey`, `localAgentPublicKey`, `verifyLocalAgentChallenge` | P-256 local agent keys and `opensesame-local-agent+jws` challenges |
| `exactOrigin`, `isLoopbackOrigin` | Origin checks shared by every profile |

`src/browser.ts` installs `window.OpenSesame` (`signIn`, `complete`) for the
hosted artifact; `src/compatibility.ts` is the deprecated loopback-only root
artifact.

## Develop

```bash
pnpm --filter @opensesame/static-auth test
pnpm --filter @opensesame/static-auth typecheck
pnpm lint:artifacts   # rebuild check of the immutable artifacts + these tests
```

The version in `package.json` names the published artifact directory.
Existing versioned bytes cannot change: `apps/pages/scripts/build-static-auth.mjs`
rejects a mismatch, so a behavioural change needs a version bump. Changes to
local sessions, grants or popup transport also run
`pnpm --filter @opensesame/pages verify:local-iam`.

## Related

- [ADR 0096](../../docs/adr/0096-static-auth-profiles-and-immutable-distribution.md) — the profiles and immutable distribution
- [ADR 0034](../../docs/adr/0034-origin-brokered-static-site-signin.md) — the original static broker rationale
- [ADR 0090](../../docs/adr/0090-static-frontend-complete-without-backend.md) — the static front end without a backend
