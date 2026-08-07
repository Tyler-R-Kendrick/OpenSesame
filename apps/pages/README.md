# `@opensesame/pages`

Installable **GitHub Pages PWA** — offline client shell for OpenSesame.

## Depths

1. **Surface** — brand + descent into Vault / Ceremonies
2. **Vault** — sealed local sync store (OPFS)
3. **Ceremonies** — Authorize CLI + Claim ownership
4. **Task** — live Host inspect or labeled offline demo
5. **Ratchet** — protocol honesty (Bearer ≠ DPoP)

Offline outbox queues device/claim intents until flush.

## Develop

```bash
pnpm install
pnpm --filter @opensesame/pages dev
```

## Build (project Pages base)

```bash
VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
```

Publish the `dist/` folder yourself (no GitHub Actions). Example:

```bash
VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
# upload apps/pages/dist to GitHub Pages (branch/folder or other host)
```
