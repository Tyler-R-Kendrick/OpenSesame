# Push enrolment — the notices a person can now read, and why there is no screenshot

AGENTS.md §5 asks for before/after images of any change a person could notice.
The notices below are on-screen copy: they appear in the notice tray when the
**Push on this device** key (Settings › General › Push) is pressed and
something refuses. They are **not captured**, and this page says exactly why
and what was verified instead, so the absence is not silent.

## Why no images

The Push row is drawn only where it can act (ADR 0158): a browser that can
receive push, an Identity API configured, **and a signed-in Identity session**
(`PushPanel` — `configured && session !== null && supported`). Every capture
harness this repository has (`capture-evidence.mjs`, `verify:static`, the
`verify:*` walks) runs the static Pages build with no backend, as a guest, so
the row is never drawn there. Reaching it means signing in to a live Identity
API (the control-plane with its database and an OIDC leg), which no harness
here starts; building a page that draws the panel by hand would be a staged
screenshot, which §5 forbids. A static capture of the unchanged-looking row
would show nothing the change touched.

## What changed on screen

Only the text of the tray notice (and one more case that now produces a notice
instead of a key that hangs). Layout, controls, marks and the row are
unchanged. Before is the code at `origin/main` before this branch; after is
this branch. Strings are read from the source, not paraphrased.

| Situation | Before | After |
| --- | --- | --- |
| This installation's egress policy refuses the call | "The sign-in service is not reachable from here, so notifications were not changed." (every enrolment, because the purpose was misspelt) | "This installation may not reach the sign-in service for push (`<denial code>`), so notifications were not changed." Only for a policy refusal; a real network failure keeps the old sentence. |
| The permission prompt is dismissed | "Notifications are blocked for this site, so nothing can be delivered here. Requests still wait for you in the app." | "Notifications were not allowed for this site, so nothing can be delivered here. Requests still wait for you in the app." (a blocked site keeps the old sentence) |
| The browser refuses to subscribe | the browser's own exception text | NotAllowedError: the "blocked" sentence. AbortError / NetworkError: "This browser's push service could not be reached, so push was not turned on. Try again later; requests still wait for you in the app." NotSupportedError / SecurityError: "This browser cannot subscribe to push from here. Requests still wait for you in the app." Anything else: "This browser could not subscribe to push. Requests still wait for you in the app." |
| No service worker is registered | the key hung with no notice | "No service worker is running for this app yet, so push cannot be turned on. Reload the page and try again." |
| The push worker has not taken the scope yet | a subscription was taken against a worker with no `push` handler | waits, then "The push worker is still being installed on this device. Try again in a moment." |
| The Identity API accepts the connection and says nothing, or the browser never answers `subscribe` | the key hung | after 15 s / 30 s: "The sign-in service is not reachable from here, so notifications were not changed." / the "push service could not be reached" sentence above |
| Another principal holds this browser's endpoint (409) | "The server refused that (409)." and push could never be turned on | a fresh subscription is registered; if that is refused too, "The server refused that (409)." |

## What was verified instead

- `apps/pages/src/lib/push-enrolment.test.ts`, `push-withdrawal.test.ts` and
  `push-pending.test.ts` assert each message above against the real
  `enablePush` / `disablePush`, each in a case that fails on the old code.
- `apps/pages/src/modules/notifications.web-push/PushPanel.test.tsx` renders
  the real panel in jsdom with an Identity session and asserts the notice
  reaches the tray with the tone `err` or `warn`, the mark stays `Off`, no
  in-page error box is drawn (`.note` absent), and the key is released after a
  hang.
- `pnpm lint:design` (no in-page error box, no caption prose) passes on the
  panel, which is unchanged apart from its logic.
- `pnpm --filter @opensesame/pages verify:push-worker` walks, in a real
  browser, everything on this path that is not behind the session: approval,
  the worker swap, a second tab, the doorbell, removal.
