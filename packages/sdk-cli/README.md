# @opensesame/sdk-cli

The Node SDK for command-line clients of the Identity API: RFC 8628 device
authorization, loopback authorization-code login with PKCE, and a small typed
client for the Identity API's session, project, claim and agent routes. It
runs in Node (it uses `node:http`, `node:crypto` and `node:net`), not in a
browser.

## Where it fits

- **Used by:** [`packages/cli`](../cli) (`opensesame-id`), and the examples [`headless`](../../examples/headless) and [`agent`](../../examples/agent).
- **Builds on:** [`@opensesame/os-domain`](../os-domain); [`@opensesame/qr`](../qr) for the terminal QR in device-flow instructions.
- The device code never leaves the client: `start()` returns a `SafeDeviceStart` with no `device_code`, and `redactSecrets` scrubs it from anything logged.
- Every URL the SDK sends a code, a verifier or a bearer to must be https; http is allowed only on loopback. An endpoint the issuer *discovered* may only point into private space when the issuer itself is private, so a remote issuer cannot aim the next request at a listener on this machine (`secure-url.ts`).
- The loopback listener closes after five minutes by default (`timeoutMs`).

## Surface

| Export | What it does |
|---|---|
| `DeviceFlowClient` | `start()`, `pollOnce()`, `pollUntilComplete()`, `formatInstructions(start)` |
| `redactSecrets(value)` | Replaces every secret-named key (`device_code`, tokens, `code_verifier`, `client_secret`, …) with `[redacted]` before a value is printed |
| `loopbackLogin({ issuer, clientId, openBrowser, timeoutMs })` | Authorization code + PKCE through a one-shot `127.0.0.1` redirect listener; returns `LoopbackTokens` |
| `createControlPlaneClient(config)` | `createProvisionalSession`, `whoami`, `authStatus`, `createTemporaryProject`, `pollClaim`, `registerAnonymousAgent`, `logout` |

From [`examples/headless`](../../examples/headless/src/main.ts):

```ts
import { DeviceFlowClient } from "@opensesame/sdk-cli";

const client = new DeviceFlowClient({
  issuer: "http://127.0.0.1:8788",
  clientId: "opensesame-cli",
});
const start = await client.start();
process.stdout.write(`${client.formatInstructions(start)}\n`);
const tokens = await client.pollUntilComplete();
```

## Develop

```bash
pnpm --filter @opensesame/sdk-cli test
pnpm --filter @opensesame/sdk-cli test:watch
pnpm --filter @opensesame/sdk-cli typecheck
```

`MOCK_DEVICE_FLOW=1 pnpm --filter @opensesame/example-headless start` drives
the device flow against an in-process mock, with no Identity API running.

## Related

- [`packages/device-auth`](../device-auth) — the server-side RFC 8628 projection this client talks to
- [ADR 0008](../../docs/adr/0008-better-auth-oidc-provider.md) — oidc-provider behind the Identity API
