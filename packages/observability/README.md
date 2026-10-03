# @opensesame/observability

Structured logging with deep redaction, and the last-mile guard for text that
crosses into model-visible tool output. `createLogger` is a pino logger whose
formatter censors sensitive keys at any depth; `forAgent` scrubs known local
secrets from a payload and refuses one that still looks like a credential.

## Where it fits

- **Used by:** [`packages/control-plane`](../../packages/control-plane),
  [`packages/identity-worker`](../../packages/identity-worker), [`packages/mcp-host`](../../packages/mcp-host)
  and [`packages/mcp-client`](../../packages/mcp-client) (`forAgent` on tool output),
  [`packages/agent-client`](../agent-client) (`registerAgentSecret`),
  [`packages/telemetry`](../telemetry) (reuses `SENSITIVE_KEY_PATTERN`) and
  [`packages/webmcp`](../webmcp).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) and `pino`.
- Diagnostic logs are kept apart from the audit trail
  ([`@opensesame/audit`](../audit)).
- `registerAgentSecret` has no readback API; entries last at most five
  minutes and the table holds at most 64.

## Surface

| Export | What it does |
|---|---|
| `createLogger({ name?, level?, redactPaths?, destination? })` | A pino `Logger`; level from the option, then `OPENSESAME_LOG_LEVEL`, then `LOG_LEVEL`, then `info`. Every argument to a log call is scrubbed by key *and* by shape ([ADR 0157](../../docs/adr/0157-logs-and-events-carry-no-secrets.md)): the message string, interpolation values and `err.message`/`stack` included |
| `redactDeep(value)`, `scrubValue`, `scrubText`, `isSensitiveKey`, `REDACTED` | The shared scrubber from [`@opensesame/log-scrub`](../log-scrub): sensitive keys censored at any depth, every string scrubbed by shape; cycle-safe, depth-capped at 12 |
| `LOG_REDACT_PATHS` | The pino redact paths (the fast path; the deep scrub is what holds) |
| `forAgent(text, env?)` | `scrubLocalSecrets`, then throws `AgentPayloadRefused` if `looksLikeCredential` still matches |
| `scrubLocalSecrets(text, env?)` | Replaces registered secrets and the values of `OPENSESAME_OPERATOR_TOKEN`, `OPENSESAME_ACCESS_TOKEN`, `OPENSESAME_IDENTITY_TOKEN`, `OPENSESAME_CLAIM_PEPPER` and `OPENSESAME_AGENT_LAUNCH_HANDLE` with `[REDACTED]` |
| `registerAgentSecret(value, expiresAt)` | Adds a short-lived secret to the scrub list |
| `looksLikeCredential(text)`, `REDACTED`, `AgentPayloadRefused` | Marker check and constants |

## Develop

```bash
pnpm --filter @opensesame/observability test
pnpm --filter @opensesame/observability typecheck
```

## Related

- [ADR 0015](../../docs/adr/0015-audit-vs-diagnostic-logging.md) — audit
  versus diagnostic logging
