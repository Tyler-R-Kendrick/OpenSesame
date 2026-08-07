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
