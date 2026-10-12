# @opensesame/browser-extension

A WXT (Manifest V3) browser extension on the Client plane. Its background
service worker reports Host API health, whether the local daemon answers, and
a client-core sync cursor; the popup shows that status and lets the user set
the Host API base. It is also the **local runner** of a person's own sandboxed
runs: it claims the steps of a run the person owns, executes each verb in the
page it is armed for, performs the candidate custody steps in its own sealed
store, and settles what it did. It never exposes a secret or a `getSecret()`
affordance to a web page, and no credential ever travels to the Host.

## Where it fits

- **Used by:** nothing in the workspace depends on it; it is loaded into a
  browser. Setup for people and agents is in
  [skills/opensesame-chrome-extension](../../skills/opensesame-chrome-extension/SKILL.md).
- **Builds on:** [`@opensesame/api-client`](../../packages/api-client)
  (`createApiClient`, `normalizeLoopbackBaseUrl`),
  [`@opensesame/client-core`](../../packages/client-core) (`createCursor`,
  `persistSealedStore`),
  [`@opensesame/browser-at-rest`](../../packages/browser-at-rest) (`sealForRest`,
  `openFromRest`), [`@opensesame/os-domain`](../../packages/os-domain).
- The Host API base is loopback only. The popup refuses a non-loopback URL
  before it is stored, and the background ignores a stored value that no
  longer normalizes to loopback and falls back to `http://127.0.0.1:8787`.
  `host_permissions` is limited to `http://127.0.0.1/*` and
  `http://localhost/*`.

## The local runner

The runner is the extension side of the step protocol
(`POST /api/v1/agent/runs/{id}/steps/claim` and `…/steps/{seq}/outcome`;
[ADR 0076](../../docs/adr/0076-autonomous-web-login-rotation.md) §8,
[ADR 0079](../../docs/adr/0079-shared-sessions-and-scoped-grants.md) §4,
[ADR 0082](../../docs/adr/0082-agent-run-registration-ceremonies.md) §4). It
lives in `runner/`, wired into `entrypoints/background.ts`, and is set up on the
options page (`entrypoints/options/`).

| Piece | What it does |
|---|---|
| `runner/loop.ts`, `drive.ts`, `readiness.ts` | One pass over the person's runs every minute (an alarm), plus one when an origin is armed. A run is claimed only when the Host lists it as the person's, it is `agent_driving` with the agent as driver, its origin is **armed** and the browser still **grants** it, a credential for the origin is held, a recovery key is pinned and a private window is allowed. The run is re-read before every claim; the moment a person asks for the page, is parked for or takes it, nothing more is claimed and the page is left as it is |
| `runner/driver.ts`, `verify.ts` | One step, executed. `navigate` (inside the run's origin only), `wait_for`, `fill_credential`, `assert_present`, `submit`, `read_dom_redacted`, `screenshot_redacted` (frames carry `{image, epoch, masked_boxes}`), `verify_login` (a fresh login in a private window), and the custody steps `generate_candidate`, `seal_candidate`, `promote_candidate`. A step it does not know is refused and not settled; the two ceremony captures answer `failed` because no envelope scheme exists to seal to |
| `runner/page-fns.ts`, `tab.ts`, `browser.ts` | The functions injected into the run's tab (isolated world, top frame, on demand — no content script), and the tab, grants and private window around them |
| `runner/wire.ts` | Outcomes in exactly the shape the Host decodes (it refuses unknown fields). No constructor takes a value; every answer passes `guard` against the step it answers; page text is scrubbed of every value the runner holds |
| `runner/vault.ts`, `backup.ts`, `store.ts` | The runner's own credentials and candidates, **sealed at rest** (`sealForRest`, [ADR 0149](../../docs/adr/0149-nothing-stored-in-the-clear.md)) and bound to their names. A candidate is backed up as a hybrid envelope (RSA-OAEP-256 + AES-256-GCM) addressed to a **recovery key** whose private half the person keeps off this device, put in the Host's ciphertext store and read back byte for byte; only then is `seal_candidate` answered `backed_up: true`. With no recovery key, or a Host that refuses or returns something else, it is `backed_up: false` and the run stops before the submit |
| `runner/settings.ts` | The Host session token, the armed origins (30 minutes each) and the runs in flight, all sealed. The last answer is kept so a settle that never arrived is answered again rather than a `submit` being pressed twice |

What a person does, once, on the options page: save a Host session token, pin
(or create) the recovery key, save a credential and — optionally — a login
check for an origin, then press **Allow this site** while a run is waiting. The
browser asks for that one origin and `scripting` on that click; the grant is
given back when the run ends or the arm expires. Messages that arm, disarm or
ask for status are answered only to this extension's own pages.

The runner authenticates with a bearer session token and holds its own
credentials. A DPoP-bound token is one the Host refuses without its proof key
(401), so the runner claims nothing under it; it does not read the Pages vault
or the sealed store.

## Not here: autofill

Filling a focused login field by reference after a person's gesture is the
optional `browser-autofill` plugin, a separate companion extension a person
installs at runtime:
[`apps/browser-extension-autofill`](../browser-extension-autofill)
([ADR 0150](../../docs/adr/0150-surrogate-credentials-at-the-last-hop.md)
§6.4, §7). Nothing of it is here: no fill guard, no daemon fill route, no
standing page permission. `tests/capability-parity.test.mjs` leaves that
plugin's registry rows to the companion's own parity test.

## Surface

| Piece | What it does |
|---|---|
| `entrypoints/background.ts` | Creates the sync cursor (`extension-device`), persists an empty sealed store on install, answers runtime messages, and wakes the runner on an alarm |
| `opensesame.health` message | Returns `{ health, daemon, discovery, cursor, hostBase }` from `client.health()`, `client.probeDaemon()` and `client.discover()` |
| `opensesame.sync_cursor` message | Returns `{ cursor }` |
| `opensesame.runner.status` / `.arm` / `.disarm` messages | What the runner has ready; arm one origin (once the browser has granted it) or give it back. From this extension's own pages only |
| `entrypoints/options/` | The runner's setup: session, recovery key, credentials, the site to drive, held candidates and their recovery |
| `entrypoints/popup/` | Status list (Host API, daemon, sync cursor) and the Host API base field, stored sealed at rest (ADR 0149) as `hostApiBase` in `chrome.storage.local` |
| `wxt.config.ts` | Manifest: `storage` and `alarms` permissions and loopback hosts (standing); `scripting` and `https://*/*` as **optional** only; no content script; extension-page CSP `script-src 'self'`; build target `chrome111`/`firefox115` |

## Develop

```bash
pnpm --filter @opensesame/browser-extension dev            # wxt dev
pnpm --filter @opensesame/browser-extension build          # wxt build
pnpm --filter @opensesame/browser-extension typecheck      # wxt prepare + tsc
pnpm --filter @opensesame/browser-extension test           # vitest (runner/) + node --test tests/*.mjs
pnpm --filter @opensesame/browser-extension test:install   # playwright install chromium
PLAYWRIGHT_BASE_URL=http://127.0.0.1:8787 \
  pnpm --filter @opensesame/browser-extension test:e2e     # live-gateway suite
```

`tests/pact.test.mjs` checks the source order of the loopback fence (normalize
before store, normalize before use) and that no `getSecret(` appears.
`tests/runner-pact.test.mjs` pins the runner's structure: nothing stored in the
clear, no logging, no outcome constructor that takes a value, every answer
guarded, a step decoded before it is run and re-read before it is claimed, every
injection origin-checked, messages from own pages only, and a manifest that
holds nothing standing for the runner. The behavioural pacts are the vitest
suites beside the code: a fake Host as strict as the real one, a full
change-password recipe walk over jsdom pages, and the negative cases (a run
that is not the person's, an unarmed or ungranted origin, a person holding the
page, an unknown step, an off-origin navigation, an unprovable backup, a
rejected or indeterminate login, a settle that never arrived). The
Playwright suites run under `test:e2e` (which runs `wxt build` first):
`tests/runner-storage.spec.ts` loads the built extension into Chromium and
checks that credentials are sealed and cross-origin ciphertext replay is
refused; `tests/auth-surface.spec.ts` is skipped unless `PLAYWRIGHT_BASE_URL`
points at a running gateway, and reads `OPENSESAME_OPERATOR_TOKEN` for the
operator header.

## Related

- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) — ConnectionRef, no `getSecret()`
- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client topology
- [ADR 0082](../../docs/adr/0082-agent-run-registration-ceremonies.md) — the extension as a second ceremony runner
- [Audit: extension Host API loopback fence](../../docs/security/audits/2026-08-08-extension-host-fence.md)
