# opensesame-tailnet-admin

Tailnet device management through the daemon
([ADR 0169](../../docs/adr/0169-tailnet-device-management.md)): the Tailscale
credential, origin-bound role pairings, the upstream client and the audit
trail. The daemon (`crates/daemon`, the `/v1/tailnet/*` routes) serves it and
`opensesame daemon tailnet` configures it; it builds on
[`opensesame-invoke-through`](../invoke-through) (every device and key call),
[`opensesame-plugin-settings`](../plugin-settings) (the pairing-origin rule) and
[`opensesame-sealed-log`](../sealed-log) (the credential envelope and the sealed
audit lines). The rest of this file is how the credential rests.

The managed OAuth client secret or API key rests in `tailnet-admin.secret` as an
`osev2.` wrapped-DEK envelope. Each write generates a fresh data key. Both AEAD
operations bind the trusted canonical admin directory, tailnet, credential
kind, OAuth client ID, and `tailnet-admin.credential` purpose. Configuration is
read from the known local state path; ciphertext never supplies its ownership
or wrapping-key context.

`tailnet-admin.key` is a separate private local bootstrap root, supplied by the
existing sealed-log key-file provider. That root remains under operator custody;
encrypting it under itself would not add protection. Different directories have
independent roots and namespace bindings, even when someone copies the root and
ciphertext together. Relocating state requires restoring the original trusted
namespace or explicitly disconnecting and reconnecting with the credential.

Current configuration version 2 accepts only authenticated envelopes. A version
1 credential written by an older build may migrate once when its known local
configuration is valid and the plaintext has the expected credential shape.
On Unix the legacy configuration, secret and directory must also be private
and cannot be symlinks. The secret is sealed before the configuration version is
advanced, so an interrupted migration can resume. Unknown markers, malformed
configuration and missing roots for existing ciphertext fail closed; reconnect
does not silently replace an orphaned root.

OAuth access tokens remain in memory. The cache binds the verified local
configuration and credential snapshot, so two directories using the same
client ID and reconnects that rotate the credential cannot reuse each other's
cached token. Pairing codes and bearers are persisted only as SHA-256 digests,
not recoverable secrets. Tailnet administration is deployment-level authority;
its local namespace does not claim independent customer vault key custody.
