# `@opensesame/pages`

Installable **GitHub Pages PWA** — Bitwarden-class **authority vault** for humans and agents.

## Surfaces

1. **Unlock** — session PIN (does not decrypt sealed blobs into the page)
2. **Vault** — search / filter typed items (connection, task, claim, device, note)
3. **Agent** — peer view of agent-usable items (no `getSecret()`)
4. **Tools** — authorize CLI, claim, task ceiling, offline queue, protocol
5. **Settings** — Host / Identity API bases

## Develop

```bash
pnpm install
pnpm --filter @opensesame/pages dev
```

## Build & deploy (no custom Actions)

```bash
./scripts/deploy-pages.sh
# → https://tyler-r-kendrick.github.io/OpenSesame/
```

## Identity cookie deployment

Connections uses the Identity service's HttpOnly session cookie. Pages and
Identity must therefore be served over HTTPS on the same schemeful site,
typically sibling custom domains such as `vault.example.com` and
`identity.example.com`, with the Identity origin explicitly allowing the Pages
origin for credentialed CORS and CSRF checks.

The default `tyler-r-kendrick.github.io` deployment cannot use an Identity
cookie hosted on a separately sited domain. Configure a same-site custom domain
for production Connections; this PWA intentionally does not add a browser-held
Identity bearer-token fallback.
