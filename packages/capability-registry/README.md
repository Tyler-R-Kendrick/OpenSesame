# @opensesame/capability-registry

The agent-surface parity source of truth. One literal list, `CAPABILITIES`,
maps every product capability to the surfaces that carry it: the CLIs, the
PWA, both MCP servers, WebMCP, the browser extension and Android. A capability
either ships on a surface, carries an explicit exclusion that cites an ADR, or
appears in the reviewed gap ledger `surface-gaps.json` (ADR 0139); parity tests
in each surface package compare their implemented catalogs against the views
derived here.

## Where it fits

- **Used by:** the parity tests and catalogs of
  [`packages/mcp-host`](../../packages/mcp-host), [`packages/mcp-client`](../../packages/mcp-client),
  [`apps/pages`](../../apps/pages),
  [`packages/cli`](../cli), [`packages/webmcp`](../webmcp),
  [`packages/app-core`](../app-core) and [`tests/redteam`](../../tests/redteam).
  The Host CLI's Rust test
  [`apps/cli/tests/capability_parity.rs`](../../apps/cli/tests/capability_parity.rs)
  reads the generated `capabilities.json`.
- **Builds on:** nothing in the workspace; it has no runtime dependencies.
- Every host or identity capability must be mapped or excluded on MCP, and
  every capability with a `pwa` surface must be mapped or excluded on WebMCP
  (`src/registry.test.ts`).
- `OPERATION_CAPABILITY` (`src/capability-map.ts`) maps each registry
  operation id to the one Pages product capability that owns it. Operation ids
  are not renamed to fit a capability.

## Surface

| Export | What it is |
|---|---|
| `CAPABILITIES` | Every `Capability`: `id`, `title`, `plane` (`host` / `identity` / `client_local`), `kind` (`read` / `act` / `admin` / `ceremony`), `surfaces` and `excluded` |
| `mcpHostCatalog`, `mcpClientCatalog`, `webmcpCatalog`, `webmcpPagesCatalog` | The tool names each agent surface must implement |
| `exclusionsFor(surface)` | Capabilities withheld from an agent surface, with reason and ADR |
| `SURFACES`, `surfaceGaps()` | Every surface (`cli`, `pwa`, `mcp_host`, `mcp_client`, `webmcp`, `extension`, `android`) and the capabilities that are neither mapped nor excluded on each; `surface-gaps.json` records it |
| `OPERATION_CAPABILITY`, `operationsForCapabilities`, `capabilitiesWithOperations` | Operation to product capability |
| `AGENT_SECRET_NAME_PATTERN`, `assertsNoSecretNames` | Refuses an agent tool name that reads as secret retrieval (`secret`, `materialize`, `pass_show` …) |
| `INTERACTION_SETTLEMENT_PATTERN`, `assertsNoInteractionSettlementTool` | Refuses an agent tool that would settle an interaction or mint an approval proof ([ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md)) |
| `capabilities.json` (`./capabilities.json` export) | The generated JSON copy of `CAPABILITIES` |
| `pwa-summaries.json` (`./pwa-summaries.json` export), `pwaSummaries` in `src/pwa-summaries.ts` | The generated projection Pages ships instead of the whole registry: the id, title and plane of every capability with a `pwa` surface |

Entries are grouped by domain in `src/*.ts` (vault, connectors, lifecycle,
wallet spending, transport security, shared sessions …); shared exclusion
reasons live in `src/exclusions.ts`.

## Develop

```bash
pnpm --filter @opensesame/capability-registry test
pnpm --filter @opensesame/capability-registry typecheck
pnpm --filter @opensesame/capability-registry generate   # rewrite capabilities.json, surface-gaps.json, pwa-summaries.json
```

After editing `CAPABILITIES`, run `generate` and commit the JSON; the sync
tests fail until the committed files match. A new gateway route, CLI verb or PWA
action needs an entry here, and a new optional Pages capability also needs its
operations in `src/capability-map.ts`.

## Related

- [ADR 0065](../../docs/adr/0065-agent-surface-parity.md) — agent-surface parity
- [ADR 0130](../../docs/adr/0130-operator-controlled-capability-composition.md)
  — capability composition (the operation map)
