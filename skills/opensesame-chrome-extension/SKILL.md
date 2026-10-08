---
name: opensesame-chrome-extension
description: Install, configure, initialize, and use the OpenSesame browser extension
---

# OpenSesame Chrome extension

Uses `@opensesame/api-client` against Host API **8787**; optionally probes daemon **18790**. It has no Identity API (**8788**) code.

## Install

```bash
pnpm install
pnpm --filter @opensesame/browser-extension build
# Load `apps/browser-extension/.output/chrome-mv3` (WXT's output) as an unpacked extension
```

## Configure

Set the Host API base in the popup's Host API field (default `http://127.0.0.1:8787`). Only loopback URLs are accepted; there is no build-time setting.

## Init

1. Start Host API + optional daemon.
2. Load unpacked extension.
3. Open the popup: it shows Host API health, daemon reachability and the sync cursor. The background answers its `opensesame.health` message; on install it only persists an empty sealed sync store.

## Use

- The background answers the popup's health request with the Host's `/health/live` and the daemon's `/health`.
- Never exposes a secret or `getSecret()` to a web page, and does not invoke connections.
- Local runner: on the options page save a Host session token, pin a recovery key, save a credential for an origin, then **Allow this site** while a run for it is waiting. The extension claims that run's steps, fills from its own sealed store (never the Host), backs a candidate up to the recovery key before any submit, and gives the site grant back when the run ends. A person asking for the page stops it.
- The extension has no unlock or step-up of its own; account passkeys and the authenticator app are rows in Pages › Settings › Security.
