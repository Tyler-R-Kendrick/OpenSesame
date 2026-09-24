# @opensesame/telemetry

Anonymous product analytics behind an allowlist. `createTelemetry` wraps a
caller-supplied `capture` function and forwards only events named in
`ALLOWED_EVENTS`, with only the props named in `ALLOWED_PROP_KEYS`; anything
else is dropped silently. The package does no I/O of its own — the caller
decides what `capture` does, including nothing when no telemetry key is
configured.

## Where it fits

- **Used by:** [`apps/mcp-host`](../../apps/mcp-host) (`src/telemetry.ts`, which sends `mcp_tool_call` to PostHog when `OPENSESAME_TELEMETRY_KEY` is set).
- **Builds on:** [`@opensesame/observability`](../observability) (`SENSITIVE_KEY_PATTERN`), [`@opensesame/os-domain`](../os-domain).
- Additive only: a new event or prop key is an edit to this package, never something a call site can do.
- A prop whose key or stringified value contains a forbidden term (`token`, `secret`, `authorization`, `cookie`, `pepper`, `key`, `pin`, `prompt`, `email`, `sub`) is dropped whole, not redacted. The check runs before truncation, so a term past the cut-off is still caught.
- Values become primitives; strings are truncated to 64 characters.

## Surface

| Export | What it is |
|---|---|
| `createTelemetry({ capture })` | Returns `{ track(event, props) }` |
| `ALLOWED_EVENTS` | `app_opened`, `vault_unlocked`, `vault_unlock_failed`, `vault_locked`, `item_opened`, `ceremony_queued`, `ceremony_completed`, `settings_changed`, `mcp_tool_call` |
| `ALLOWED_PROP_KEYS` | `tool`, `client`, `client_version`, `duration_ms`, `outcome`, `error_class`, `item_type`, `queue_depth` |
| `FORBIDDEN_SUBSTRINGS` | The substring deny-list above |
| `redactionTest` | Table-test fixture: one row per forbidden term smuggled into an allowed key |

## Develop

```bash
pnpm --filter @opensesame/telemetry test
pnpm --filter @opensesame/telemetry typecheck
```

The allowlist must match the contract in
[`docs/contributing/posthog-setup.md`](../../docs/contributing/posthog-setup.md);
change both together. Keys and hosts are `OPENSESAME_TELEMETRY_KEY` /
`OPENSESAME_TELEMETRY_HOST` and their `VITE_` counterparts in
[`.env.schema`](../../.env.schema).

## Related

- [PostHog setup](../../docs/contributing/posthog-setup.md) — the telemetry contract and operator settings
- [ADR 0130](../../docs/adr/0130-operator-controlled-capability-composition.md) and [ADR 0135](../../docs/adr/0135-always-on-capabilities-and-feature-rollups.md) — `telemetry.external` as an optional capability in the Pages build
