# Connector page: the API family select

This branch holds temporary before/after review material for the family-selects pull request (`claude/ecstatic-mayer-wbm2c3-family-selects`). It is not approved evidence and is not for merging. It holds only this gallery.

The same journey ran on two real Pages builds, at phone and desktop width:

- **Before:** `main` at `0e61826d0`.
- **After:** the branch at `d977386ad`.

The journey (`journey.json`):

1. enter as a guest;
2. switch on External connectors;
3. open a provider's page at `/connections/<id>`;
4. read the select's label and options, and measure it, in the browser (the `report` and `measure` steps of `apps/pages/scripts/capture-evidence.mjs`).

| Sheet | Before | After |
| --- | --- | --- |
| [1280-google.png](1280-google.png) | label `API family` · options Google, **google-drive**, Google Gemini, Google Vertex AI, Google Wallet · select 190×32 | label `Google API` · options Google, **Google Drive**, Google Gemini, Google Vertex AI, Google Wallet · select 190×32 |
| [1280-microsoft.png](1280-microsoft.png) | label `API family` · options Microsoft, **m365**, Microsoft Teams | label `Microsoft API` · options Microsoft, **Microsoft 365**, Microsoft Teams |
| [1280-vercel-ai-gateway.png](1280-vercel-ai-gateway.png) | two selects both labelled `API family` (the provider's, the model form's protocol) | `Vercel API` (the provider's), `API family` (the model form's protocol) |
| [390-google.png](390-google.png) | label `API family` · google-drive · select 352×44 | label `Google API` · Google Drive · select 352×44 |
| [390-microsoft.png](390-microsoft.png) | options Microsoft, m365, Microsoft Teams | options Microsoft, Microsoft 365, Microsoft Teams |

A select's options appear only when it is open, so the screenshots show the selected value; the options listed above were read from the page.

## Build and limits

Both builds used:

- `VITE_BASE=/OpenSesame/`;
- `OPENSESAME_BUILD_MODE=hardened`;
- a capability profile of `rich-explicit` minus `networking.tailnet` and the three capabilities that depend on it.

This sandbox's network policy refuses `codeload.github.com` (HTTP 403), so the pinned Tailscale source those native assets are built from cannot be fetched here. Connections (`connectors.external`) is in both builds.

Captured 2026-10-31 by Claude Code (agent-assisted) with `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium`. No approval was given: these are review captures, not current-state evidence.
