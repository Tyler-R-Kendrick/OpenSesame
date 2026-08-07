---
name: opensesame-chrome-extension
description: Install, configure, initialize, and use the OpenSesame Chrome extension
---

# OpenSesame Chrome extension

Package: `apps/browser-extension` (WXT). Depends on `@opensesame/api-client`.

```bash
pnpm --filter @opensesame/browser-extension install
pnpm --filter @opensesame/browser-extension dev
# Load unpacked extension from `.output/chrome-mv3` (WXT output)
```

Background listens for `opensesame.health` messages and probes Host API + local daemon.

Env / build: `VITE_HOST_API` (default `http://127.0.0.1:8787`).

Rules: never expose `getSecret` to webpages; use ConnectionRef invoke only.
