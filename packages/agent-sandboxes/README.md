# @opensesame/agent-sandboxes

Configurable browser sandbox providers for agent runs. Every provider
implements the same contract (`src/types.ts`): `allocate()` returns a
`BrowserDriver` from `@opensesame/cua-password-reset`, the navigation
allowlist for the run, and a `close()`. The ceremony runner, recipes, and
credential custody do not change between lanes — only where the browser
lives and how its traffic reaches the site.

| Provider id | Where the browser runs | Driver |
| --- | --- | --- |
| `local` | Ephemeral agent-browser session on the user's device | `LocalSandboxProvider` over `createLocalSandbox` |
| `wasm-relay` | DOM-level driver with no direct network; every fetch is virtualized through a user-controlled relay, so the same code can run in a WASM/browser host | `WasmDomDriver` + `VirtualNetwork` relay (`vnet-server.ts`) |
| `cloudflare` | Temporarily unavailable | Allocation fails before contacting Cloudflare |
| `boat` | Boat cloud sandbox allocated over the Boat REST API | Relay agent inside the sandbox (`boat-agent.ts`) behind its hosted port; allocation registers the agent via auth.md when no API key is configured |

Selection: the CLI bundled runtime picks a provider from the reset
config's `runtime.provider` field (`--provider` at configure time),
defaulting to `local`. Providers belong to the bundled runtime only;
external runtime adapters own their browser.

## Security invariants

- Provider credentials are read only at allocation time, from the
  environment (e.g. `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`).
  They are never put in URLs surfaced to users.
- Provider credentials are separate from site values passed to browser
  steps. The relay carries secret fills on the authenticated driver channel,
  never in provider command history.
- When allocation itself needs a person (e.g. claiming an agent),
  providers throw `SandboxClaimRequiredError` with only a verification
  URL and short code, so callers surface it through the existing
  human-intervention channel (notifications queue + toast).
- Hostname filters on navigation are not a network firewall. A page's
  scripts, redirects and subrequests may reach other destinations; use an
  independently enforced outbound policy when the site or network is not
  trusted.

## Honest limits

- The `wasm-relay` lane is a DOM/form driver, not a real browser. It
  supports server-rendered reset flows; JS-heavy pages, WebAuthn, and
  interactive challenges surface as non-actionable static fields so the
  run parks for a person instead of guessing.
- Cloudflare allocation and direct `CdpBrowserDriver` construction are
  disabled until browser network and credential-entry isolation is established.
  The low-level CDP transport remains available to trusted callers; it does
  not provide those protections.
- Boat allocates a real remote browser; a person takes
  over through the allocation's `takeoverUrl` when the provider exposes
  one, or through the Host step-channel otherwise. Boat does not expose
  a takeover URL here (its hosted/desktop URLs carry access tokens),
  and Boat allocation does not yet rejoin a prior sandbox by session
  id — keep the allocation alive in the host process for the run.
- The Boat lane needs an operator-configured agent start command
  (`BOAT_RELAY_AGENT_COMMAND`), typically run from a saved snapshot
  with this package installed. Sandboxes are created with none of the
  account's secrets, monitoring off and snapshots off. Close waits for
  Boat to confirm deletion. If it raises `BoatDeletionPendingError`, retain
  its operation and sandbox IDs and resume with the provider's
  `waitForDeletion`; erasure is not confirmed until that call succeeds.
  Failed allocation can report a pending cleanup inside an `AggregateError`;
  retain and resume that operation in the same way. If no valid deletion
  receipt is available, `BoatDeletionUnconfirmedError` retains the sandbox ID
  for checking cleanup with Boat.
