# Native Chrome WebMCP

WebMCP requires browser support. A visible DevTools Application > WebMCP pane
alone does not mean the page has access to the experimental API. On Chromium
151.0.7922.10, a clean launch exposes no model context by default; launching
with `--enable-experimental-web-platform-features` exposes the native API.
Enable the corresponding experimental Web Platform flag in Chrome, relaunch,
and reload the app. A website cannot enable a browser flag. No JavaScript
polyfill can register tools in Chrome's native pane.

Support reports acknowledged registrations, not catalog size or pending
promises. A device that has not chosen the WebMCP tools capability exposes no
tool at all ([ADR 0130](../adr/0130-operator-controlled-capability-composition.md)).
Once it is chosen, the sign-in/locked screen has 4 tools,
and an unlocked vault with the capabilities the gate chooses (`CHOSEN` in
`apps/pages/scripts/verify-webmcp.mjs`) has 24. Application > WebMCP lists
these tools and can invoke them. The counts do not include remote MCP servers:
these are in-page WebMCP tools.

## Reproduce against shipped bytes

```bash
VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
PLAYWRIGHT_CHROMIUM=/path/to/webmcp-capable/chrome \
  pnpm --filter @opensesame/pages verify:webmcp
```

A browser without the `WebMCP` DevTools domain (the Chromium 141 in the
agent container) stops at `WebMCP.enable`. Chrome for Testing 154 has it:
download `chrome-linux64.zip` for the version `last-known-good-versions` names
from `storage.googleapis.com/chrome-for-testing-public/` and point
`PLAYWRIGHT_CHROMIUM` at its `chrome`.

The test serves `dist/` under the production HTTPS origin without a backend.
It listens to native `WebMCP.toolsAdded`/`toolsRemoved`, invokes tools with
`WebMCP.invokeTool`, and inspects actual rendered state. It covers every
authored destination (it requires at least 23), six built-in new-item
ceremonies (account, secret, note, card, certificate, passkey), metadata creation,
rename/favorite/read, forbidden input, human reveal handoff, Support, lock,
existing-item edit navigation, and reload. Missing native support fails; it never silently skips.
The existing Bundle budgets CI job runs the same test using installed Chrome.

The figures below are what those dated local runs observed; the gate's current
expectations are the ones above.

Local validation on 2026-09-09 used Chromium 151.0.7922.10: 3 boot tools,
20 unlocked tools, 23 destinations and 44 CDP invocations passed. The full
Pages suite passed 3,265 tests; the shared WebMCP suite passed 52. Subsequent
focused navigation/caller regressions passed 138 tests. Typechecks, the
offline static-origin journeys, structural/package quality, and all three
application bundle budgets passed. This records local evidence, not a claim
that the branch has merged or the hosted CI/deployment has run these changes.

Local validation on 2026-10-05 used Chrome for Testing 154.0.8037.92: 4 boot
tools, 19 unlocked tools, 24 destinations and 51 CDP invocations passed, with
accounts as the item kind and the derived generator the default.

## Authority limits

Tools navigate sections, tabs and ceremonies and execute mapped capabilities.
Opening a credential or approval ceremony does not complete it: secret entry,
reveal and approval remain human operations. There is no arbitrary selector,
JavaScript execution, raw-secret reader, or permission bypass tool. Host and
Identity operations still need configured services and authorized sessions.
Guest navigation and local metadata operations require neither service.

Chrome's current [imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
and [DevTools protocol](https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/)
are the native contracts tested here.
