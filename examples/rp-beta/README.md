# @opensesame/example-rp-beta

The second of the two React relying parties. It is the same app as
[`rp-alpha`](../rp-alpha) — sign in through `@opensesame/sdk-browser` with PKCE
and show the pairwise `sub` — under its own client id, sector and port. Signed
in to both as the same person, the two show different subjects: that is the
pairwise property this pair exists to demonstrate.

## Where it fits

- **Talks to:** the Identity API ([`apps/control-plane`](../../apps/control-plane)),
  `http://127.0.0.1:8788` unless `VITE_OPENSESAME_ISSUER` says otherwise.
- **Builds on:** [`@opensesame/sdk-browser`](../../packages/sdk-browser)
  (`createOpenSesame`), wrapped in `src/sdk-browser.ts` so tests can replace it.
- Shows the pairwise subject, never a canonical principal id, and strips the
  authorization code from the URL after the callback; `src/pact.test.ts`
  checks that ordering in the source.

## Configuration

| Setting | Value | Where |
|---|---|---|
| Client id | `rp-beta` | `src/main.tsx` |
| Redirect URI | `http://127.0.0.1:5175/` | derived from the port in `src/main.tsx` |
| Sector (display only) | `https://beta.example.test` | `src/main.tsx` |
| `VITE_OPENSESAME_ISSUER` | `http://127.0.0.1:8788` | build-time env |

The Identity API must know client `rp-beta` with that exact redirect URI
before **Sign in** can complete. Open the app at `127.0.0.1`, not `localhost`.
**Demo pairwise sub (mock)** derives a string from the sector locally and does
not call the Identity API.

## Develop

```bash
pnpm --filter @opensesame/example-rp-beta dev        # vite on :5175 (strict port)
pnpm --filter @opensesame/example-rp-beta test
pnpm --filter @opensesame/example-rp-beta typecheck
pnpm --filter @opensesame/example-rp-beta build      # tsc --noEmit && vite build
pnpm --filter @opensesame/example-rp-beta preview    # serves dist/ on :5175
```

`src/RpApp.tsx`, `src/sdk-browser.ts` and `src/rp.css` are identical to
`rp-alpha`'s; only the values in `src/main.tsx`, the port in `vite.config.ts`
and the title in `index.html` differ. Change the two apps together.

## Related

- [ADR 0011](../../docs/adr/0011-pairwise-subject-storage.md) — pairwise subject storage
- [`rp-alpha`](../rp-alpha) — the first relying party, with the fuller notes
- [`examples/README.md`](../README.md) — the rules every example follows
