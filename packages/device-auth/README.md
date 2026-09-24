# @opensesame/device-auth

RFC 8628 device-authorization logic for the Identity plane, as pure functions
over the `DeviceAuthorizationSession` that `@opensesame/os-domain` defines. It
evaluates a device-code poll into the RFC 8628 error it should return, manages
the `slow_down` interval, and projects a session into a shape that is safe for
UI and audit (it never carries a code or a token). Device authorization grants
a client session; ownership transfer is the separate claim flow in
[`@opensesame/claims`](../claims).

## Where it fits

- **Used by:** [`apps/control-plane`](../../apps/control-plane)
  (`src/routes/authorization-requests.ts` and `src/routes/claims.ts`).
- **Builds on:** [`@opensesame/os-domain`](../os-domain), which owns the
  session type and its transitions (`maybeExpireDeviceAuth`,
  `recordDevicePoll`).
- No I/O. A consumed device code polls as `invalid_grant`, so one approval
  cannot mint a second set of tokens. `slow_down` raises the interval by five
  seconds up to `MAX_POLL_INTERVAL_SECONDS` (60).

## Surface

| Export | What it does |
|---|---|
| `evaluateDevicePoll(session, clock?)` | Returns the next session, an optional `DevicePollError` (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`, `invalid_grant`) and the projection |
| `projectDeviceAuth(session)` | `DeviceAuthProjection`: id, client, state, interval, poll count, expiry, approver and an `auditSummary` |
| `shouldSlowDown`, `initialPollInterval`, `applySlowDown`, `MAX_POLL_INTERVAL_SECONDS` | Poll-interval handling |

## Develop

```bash
pnpm --filter @opensesame/device-auth test
pnpm --filter @opensesame/device-auth typecheck
```

## Related

- [ADR 0009](../../docs/adr/0009-claims-vs-device-auth.md) — claims versus
  device authorization
- Client side of the flow: [`@opensesame/sdk-cli`](../sdk-cli)
