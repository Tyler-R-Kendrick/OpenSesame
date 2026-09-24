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
| `createLogger({ name?, level?, redactPaths?, destination? })` | A pino `Logger`; level from the option, then `OPENSESAME_LOG_LEVEL`, then `LOG_LEVEL`, then `info` |
| `redactDeep(value)` | Censors keys matching `SENSITIVE_KEY_PATTERN` at any depth; cycle-safe, depth-capped at 12 |
| `LOG_REDACT_PATHS`, `SENSITIVE_KEY_PATTERN` | The pino redact paths and the key pattern (tokens, codes, secrets, passwords, private keys, DPoP, ciphertext …) |
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
