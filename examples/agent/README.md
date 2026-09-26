# @opensesame/example-agent

A command-line agent that registers itself anonymously with the Identity API
and waits for a person to claim it. It mints a provisional principal, registers
an agent under it, prints the claim link and user code, then polls the claim
until it is completed, denied or expired. It finishes by rendering an `auth.md`
and an agent card for the same API.

## Where it fits

- **Talks to:** the Identity API ([`packages/control-plane`](../../packages/control-plane)),
  `:8788` by default — `POST /v1/principals/provisional`, `POST /v1/agents`,
  `GET /v1/claims/{id}`.
- **Builds on:** [`@opensesame/sdk-cli`](../../packages/sdk-cli)
  (`createControlPlaneClient`, `redactSecrets`),
  [`@opensesame/contracts`](../../packages/contracts) (response schemas),
  [`@opensesame/agent-protocols`](../../packages/agent-protocols)
  (`renderAuthMd`, `renderAgentCard`).
- The claim link it prints is `verificationUriComplete` when the Identity API
  has a client app (`…/claim#token=osc_clm_…`): opening it presents the claim,
  and the person types only the user code. Without one it prints the bare
  `verificationUri`.
- That link is the only place the claim token is printed. The token also
  authenticates the poll; the payload the agent shows goes through
  `redactSecrets` (which censors the token and the complete link), and the run
  fails if the token survives redaction.

## Run

```bash
# Against a local Identity API (see ../README.md to start it)
pnpm --filter @opensesame/example-agent start

# No Identity API: an in-process mock answers, and the claim completes on the second poll
MOCK_AGENT_FLOW=1 pnpm --filter @opensesame/example-agent start
```

| Variable | Default | Description |
|---|---|---|
| `OPENSESAME_IDENTITY_API` | `http://127.0.0.1:8788` | Identity API base URL |
| `MOCK_AGENT_FLOW` | unset | `1` swaps `fetch` for the in-process mock |

The package also declares an `opensesame-example-agent` bin pointing at
`src/main.ts`. `runAnonymousAgentDemo()` is exported so tests can drive it
with their own `fetchImpl`, `sleep` and poll count.

## Develop

```bash
pnpm --filter @opensesame/example-agent test
pnpm --filter @opensesame/example-agent typecheck
```

Like every example, it depends only on SDK and contract packages; see the
rules in [`examples/README.md`](../README.md).

## Related

- [ADR 0092](../../docs/adr/0092-auth-md-agent-registration.md) — auth.md agent registration
- [ADR 0013](../../docs/adr/0013-agent-actor-instance.md) — agent principal, actor and instance
- [ADR 0009](../../docs/adr/0009-claims-vs-device-auth.md) — claims separate from device authorization
- [`static-agent`](../static-agent) — the same advertisement from a static origin
