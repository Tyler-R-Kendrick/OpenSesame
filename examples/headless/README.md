# @opensesame/example-headless

An RFC 8628 device login from a machine with no browser. It discovers the
issuer's endpoints, starts a device authorization, prints the user code and
verification URL, and polls the token endpoint until the person approves on
another device. It prints that a token arrived, never the token itself.

## Where it fits

- **Talks to:** the Identity API ([`packages/control-plane`](../../packages/control-plane)),
  `:8788` by default — `/.well-known/openid-configuration`, then the
  `device_authorization_endpoint` and `token_endpoint` it names.
- **Builds on:** [`@opensesame/sdk-cli`](../../packages/sdk-cli)
  (`DeviceFlowClient`: `start`, `formatInstructions`, `pollUntilComplete`).
- The `device_code` is a polling secret and never reaches the instructions a
  person sees; the run fails if `formatInstructions` output contains it.

## Run

```bash
# Against a local Identity API (see ../README.md to start it)
pnpm --filter @opensesame/example-headless start

# No Identity API: an in-process mock answers `authorization_pending` once, then a token
MOCK_DEVICE_FLOW=1 pnpm --filter @opensesame/example-headless start
```

| Variable | Default | Description |
|---|---|---|
| `OPENSESAME_ISSUER` | `http://127.0.0.1:8788` | OpenSesame issuer / Identity API |
| `OPENSESAME_CLIENT_ID` | `opensesame-cli` | Client id sent with the device authorization |
| `MOCK_DEVICE_FLOW` | unset | `1` swaps `fetch` for the in-process mock |

The package also declares an `opensesame-example-headless` bin pointing at
`src/main.ts`. `runHeadlessDeviceLogin()` is exported so tests can drive it
with their own `fetchImpl` and `sleep`.

## Develop

```bash
pnpm --filter @opensesame/example-headless test
pnpm --filter @opensesame/example-headless typecheck
```

## Related

- [ADR 0009](../../docs/adr/0009-claims-vs-device-auth.md) — claims separate from device authorization
- [`packages/sdk-cli`](../../packages/sdk-cli) — the device-flow client this example wraps
- [`examples/README.md`](../README.md) — the rules every example follows
