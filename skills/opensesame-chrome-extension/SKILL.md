---
name: opensesame-chrome-extension
description: Install, configure, initialize, and use the OpenSesame browser extension
---

# OpenSesame Chrome extension

Uses `@opensesame/api-client` against Host API **8787**; optionally probes daemon **18790**. Identity flows use **8788**.

## Install

```bash
pnpm install
pnpm --filter @opensesame/browser-extension build
# Load `apps/browser-extension/.output/chrome-mv3` (or WXT output) as unpacked extension
```

## Configure

Set Host API base (default `http://127.0.0.1:8787`) in extension options / env used at build time.

## Init

1. Start Host API + optional daemon.
2. Load unpacked extension.
3. Open background service worker console — health + daemon probe on install.

## Use

- Background checks Host `/health/live` and daemon `/health`.
- Never requests secrets; invoke uses ConnectionRef via api-client when wired.
- Pair with Mobile MFA / Identity for step-up.
