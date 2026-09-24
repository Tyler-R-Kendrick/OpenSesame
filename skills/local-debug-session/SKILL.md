---
name: local-debug-session
description: >
  Attach a live hot-reload debug session when the human asks to run the app
  locally. Watch real console, page, and network errors and patch the same
  session. Use when: "run locally", "run the app", "start the server",
  "let me test", "debug this", "hot reload", "open the app", "start pages".
---

# Local debug session

When the human asks to run the app locally, attach. Do not print a URL and
stop. Do not serve `dist/` or a headless `verify:*` harness unless they asked
for that gate.

## Attach

1. Start the HMR server as a long-lived attached process. Keep it running.
   - Pages UI, no backend (ADR 0090): `pnpm --filter @opensesame/pages dev:web`
     (`http://localhost:5180` — localhost, not `127.0.0.1`, for passkeys).
   - Pages plus Host/Identity/mock IdPs: `pnpm --filter @opensesame/pages dev`
     (`scripts/pages-dev.sh`).
   - Other Vite surfaces: that package's `dev` script, same attach rule.
2. Open the same origin in a browser/debug session the agent can read
   (console, pageerror, failed requests, runtime overlay).
3. Exercise the changed surface the way a person would.

## Watch and fix

- Subscribe to process stdout/stderr and browser console / page errors /
  failed network. Capture the real message, stack, and the user action that
  produced it.
- Patch source in the running tree so Vite HMR updates the attached session.
  Re-observe the same session. Do not restart from a production build to
  "confirm" a live-debug fix.
- Keep the session up until the human says stop.

## Not this skill

`verify:static`, `verify:auth`, `verify:keyboard`, and `verify:local-iam`
drive a fresh `dist/` in headless Chromium. Those stay merge gates. They are
not a substitute for an attached local debug session.
