# @opensesame/webmcp

The browser library the client PWAs use to expose tools to an in-page agent
through WebMCP (the Web Model Context draft). It detects the API —
`document.modelContext` first, then the legacy `navigator.modelContext` —
registers tools through a registrar that checks every name, and passes every
tool result through a secret fence before the agent sees it. WebMCP is
progressive enhancement: with no API present, registration is a no-op and the
page works as before.

## Where it fits

- **Used by:** [`apps/pages`](../../apps/pages) (the `agents.webmcp` capability module, `src/webmcp/lifecycle.ts`), [`packages/app-core`](../app-core) (`src/webmcp/` boot and login tools).
- **Builds on:** [`@opensesame/capability-registry`](../capability-registry) (`assertsNoSecretNames`), [`@opensesame/os-domain`](../os-domain).
- Every tool name must start with `opensesame_` and must not look like a secret; names are checked even when the browser has no WebMCP, so a misdeclared tool fails everywhere.
- A result is scrubbed and refused (`AgentPayloadRefused`) if it still looks like a credential. The fence is a browser-safe port of `@opensesame/observability`'s agent-payload fence; `fence.characterization.test.ts` runs both against the same fixtures.
- Discovery is not authorization: `listRegisteredTools` returns metadata without the `execute` member.
- A tool's `disposition` (`discoverable`, `tutorial_safe`, `human_required`) and `readOnly` hint are declarations read by prompt builders; they grant nothing.

## Surface

| Export | What it does |
|---|---|
| `detectModelContext()` | `DetectedModelContext` or `null`, normalized to one `ModelContextApi` |
| `createWebMcpRegistrar(api, { appId, onFailure, onRegistered })` | `register(tools)` → unregister function; each `WebMcpToolSpec` is `name`, `description`, `inputSchema`, `execute`, optional `disposition` and `readOnly` |
| `listRegisteredTools(api)`, `liveWebMcpToolNames()`, `toolDisposition(tool)` | Read back what is registered |
| `fenceForAgent`, `forAgent`, `scrubLocalSecrets`, `looksLikeCredential`, `REDACTED` | The secret fence |

## Develop

```bash
pnpm --filter @opensesame/webmcp test
pnpm --filter @opensesame/webmcp typecheck
```

Every tool registered here must map to a
[`capability-registry`](../capability-registry) entry; the parity tests in
Pages and the PWA sweep it.

## Related

- [ADR 0065](../../docs/adr/0065-agent-surface-parity.md) — agent surface parity (CLI, PWA, MCP, WebMCP)
- [ADR 0088](../../docs/adr/0088-ai-native-contextual-support.md) — in-product support; tutorial-safe tools
- [ADR 0130](../../docs/adr/0130-operator-controlled-capability-composition.md) — `agents.webmcp` as an optional capability
