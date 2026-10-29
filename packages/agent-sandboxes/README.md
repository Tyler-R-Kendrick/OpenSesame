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
| `cloudflare` | Cloudflare Browser Run session allocated over REST | `CdpBrowserDriver` over the session CDP socket |
| `boat` | Boat cloud sandbox allocated over the Boat REST API | Driver relay hosted inside the sandbox (`relay-server.ts`); provider lands next in this stack |

## Security invariants

- Provider credentials are read only at allocation time, from the
  environment (e.g. `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`).
  They are never put in URLs surfaced to users.
- Site credentials never cross the allocation contract. Drivers receive a
  secret value per `fillSecret` call, exactly as with the local driver.
  The CDP driver types secrets with `Input.insertText` so a secret is
  never embedded in evaluated JavaScript source; the relay carries the
  value only on the authenticated driver channel, never in provider
  command history.
- When allocation itself needs a person (e.g. claiming an agent),
  providers throw `SandboxClaimRequiredError` with only a verification
  URL and short code, so callers surface it through the existing
  human-intervention channel (notifications queue + toast).
- Navigation is pinned to the ceremony origin host plus explicit extras
  in every lane.

## Honest limits

- The `wasm-relay` lane is a DOM/form driver, not a real browser. It
  supports server-rendered reset flows; JS-heavy pages, WebAuthn, and
  interactive challenges surface as non-actionable static fields so the
  run parks for a person instead of guessing.
- Cloudflare and Boat allocate real remote browsers; a person takes
  over through the allocation's `takeoverUrl` when the provider exposes
  one, or through the Host step-channel otherwise.
