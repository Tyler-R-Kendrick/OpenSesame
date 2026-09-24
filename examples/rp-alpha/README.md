# @opensesame/example-rp-alpha

A React relying party that signs a person in with OpenSesame through
`@opensesame/sdk-browser`: authorization code with PKCE against the Identity
API, then a display of the pairwise `sub` the session carries. Run it beside
[`rp-beta`](../rp-beta), which is the same app under a different client id and
sector, to see one person arrive at two sites with two unlinkable subjects.

## Where it fits

- **Talks to:** the Identity API ([`packages/control-plane`](../../packages/control-plane)),
  `http://127.0.0.1:8788` unless `VITE_OPENSESAME_ISSUER` says otherwise.
- **Builds on:** [`@opensesame/sdk-browser`](../../packages/sdk-browser)
  (`createOpenSesame`: `signIn`, `handleRedirectCallback`, `getSession`,
  `signOut`), wrapped in `src/sdk-browser.ts` so tests can replace it.
- It shows the pairwise subject and never a canonical principal id. After the
  callback it replaces the URL so the authorization code does not stay in
  history; `src/pact.test.ts` checks that ordering in the source.

## Configuration

| Setting | Value | Where |
|---|---|---|
| Client id | `rp-alpha` | `src/main.tsx` |
| Redirect URI | `http://127.0.0.1:5174/` | derived from the port in `src/main.tsx` |
| Sector (display only) | `https://alpha.example.test` | `src/main.tsx` |
| `VITE_OPENSESAME_ISSUER` | `http://127.0.0.1:8788` | build-time env |

The Identity API must know client `rp-alpha` with that exact redirect URI
before **Sign in** can complete. Open the app at `127.0.0.1`, not `localhost`,
so the redirect matches.

**Demo pairwise sub (mock)** does not call the Identity API. It derives a
string from the sector locally, so the difference between alpha and beta is
visible without signing in.

## Develop

```bash
pnpm --filter @opensesame/example-rp-alpha dev        # vite on :5174 (strict port)
pnpm --filter @opensesame/example-rp-alpha test
pnpm --filter @opensesame/example-rp-alpha typecheck
pnpm --filter @opensesame/example-rp-alpha build      # tsc --noEmit && vite build
pnpm --filter @opensesame/example-rp-alpha preview    # serves dist/ on :5174
```

`pnpm dev` at the repository root starts this app with `rp-beta`, `static-rp`
and the Identity plane. `index.html` carries a Content-Security-Policy; keep it
when you add scripts or origins.

## Related

- [ADR 0011](../../docs/adr/0011-pairwise-subject-storage.md) — pairwise subject storage
- [`rp-beta`](../rp-beta) — the second relying party
- [`static-rp`](../static-rp) — the same idea with no backend and an origin-derived client id
- [`examples/README.md`](../README.md) — the rules every example follows
