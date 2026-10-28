# Tailscale in the PWA

Enable Networking in Settings → Features, then open Settings → Integrations →
Tailscale. The browser node uses the official Tailscale WebAssembly client in a
Worker. It needs no application backend, extension or installed CLI. Use a
modern browser with Workers, WebAssembly and DecompressionStream support.

Choose a hostname and control server, connect the browser node and sign in with
Tailscale. Continue through the real authorization link. A provider-issued auth
key can be entered instead. The screen reports connected only after the actual
SDK reports `Running` and an authorized node with addresses. Administrative
approval may still be required by your tailnet.

Private node state is encrypted as a Token CredentialItem in the current vault;
public connection metadata contains its reference. Locking the vault, disabling
Networking or disconnecting terminates the Worker and clears transient state.
Reconnect explicitly to resume the encrypted state. Forget local browser node
requires a second click and removes its local state; remove the remote machine
through your Tailscale admin console when remote revocation is intended.

A connected browser node can test an HTTP GET on an allowed tailnet service.
The SDK's published HTTP surface is GET without custom headers. Its Go HTTP
client follows peer redirects internally; tailnet routes and grants govern them.
The PWA checks the initial peer URL and each outer control/relay request, and
does not claim to intercept each redirect inside the encrypted stack. Peer text
is limited to one million UTF-16 code units after the SDK materializes it; this SDK does not expose a
streaming body limit. A 30-second GET timeout terminates the Worker to cancel
the underlying operation. This path does
not claim to execute authenticated vault-drive PUT sync or run a native daemon.

The PWA worker does not offer an SSH command. Consumers using the distributed
raw WASM client's SSH method can connect only to an authorized direct tailnet
peer with an advertised SSH host key. SSH fails closed when peer authority or
the key is unavailable, the key or route changes, an exit node or route-all is
selected, or the destination is an ordinary unadvertised SSH host.

## OAuth app device provisioning

The separate registration controls prepare an operator-specific application
name, exact callback URI, `auth_keys:create:once` scope and optional custom node
attributes. Download or copy its public registration request. That generated
deployment identifier is not a vendor client ID. Tailscale generates the actual
ID and client secret. No deployment credential is committed to the repository.

Direct API registration sends the documented POST, retains the one-time app
secret in an actual vault Token CredentialItem, then verifies the returned app
through GET. The admin API token stays transient. The hosted management API
currently restricts direct browser CORS access; a configured endpoint must
actually admit this browser origin. The UI reports refusal instead of treating
a stored configuration as a verified connection.

You can import the actual provider-returned app JSON. Its callback, restricted
scope and node-attribute set must match this deployment. Import performs no
network request and remains unverified. The configuration supports only
`custom:` node attributes. These concern devices provisioned through the OAuth
app and do not imply the ordinary browser node has those attributes.

Where direct API access is available, fresh user consent opens the documented
Tailscale authorization page. The exact callback and unpredictable state are
checked, then the one-time code is exchanged. The returned token already is a
single-use auth key expiring in one hour; there is no additional keys-API call.
A supplied key with unknown provenance is explicitly unverified, with unknown
expiry and reuse. Device enrollment is confirmed only by the actual target
client/control response, never merely by generating or pasting a key.

Workload trust credentials are a separate Tailscale OIDC trust configuration.
This PWA does not invent a workload JWT issuer, silently create a trust grant or
assert node attributes without a provider response.

The primary browser client and management paths are both direct browser code.
Neither falls back to a proxy, application backend, extension or host process.

## Verification and provenance

The official SDK is pinned and its actual WASM/JavaScript bytes verified at
build time. An intact Go runtime statement is extracted using the TypeScript
AST to avoid the SDK's DOM terminal dependency. Its compressed WASM and both BSD
licenses ship as capability-owned assets; excluded hardened profiles omit them.
See [ADR 0204](../adr/0204-pwa-tailscale-browser-node.md).

Protocol tests use actual HTTP sockets for the documented management messages.
Their synthetic consent page is a fixture boundary and does not establish
hosted API CORS support. Native-browser tests use the actual WASM, real Headscale
Noise control and DERP, and an official native userspace peer. Their certificate
and DNS overrides are isolated test-fixture settings, never product defaults.
No hosted user account or physical target device was enrolled by those tests.

- [Auth keys](https://tailscale.com/docs/features/access-control/auth-keys)
- [OAuth clients](https://tailscale.com/docs/features/oauth-clients)
- [Tailscale API](https://tailscale.com/docs/reference/tailscale-api)
- [OAuth app device provisioning](https://tailscale.com/docs/features/oauth-apps/device-provisioning)
- [Develop with AI](https://tailscale.com/docs/develop-with-ai)
- [Official Tailscale skill](https://tailscale.com/docs/features/tailscale-skill)
- [Node attributes for provisioned devices](https://tailscale.com/docs/reference/tailscale-api#node-attributes-for-provisioned-devices)
- [Trust credentials](https://tailscale.com/docs/reference/trust-credentials)
- [Tailcat](https://github.com/tailscale/tailcat)
- [Official browser SDK source](https://github.com/tailscale/tailscale/tree/main/cmd/tsconnect)
