# Audit 2026-08-08 — proofs that were not bound to a token

Tick 74 read `packages/api-client`, the client the extension, the PWA, the MCP
client and the CLI all use to reach the Host API.

## The proof carried no `ath`

`createDpopProof` minted `jti`, `htm`, `htu` and `iat` and stopped there, while
`request` attached both the proof and `Authorization: Bearer <token>`. RFC 9449
§4.3 binds a proof to the token it accompanies with `ath`; without it the proof
attests to a key and a request but not to a credential, so a proof observed with
one token is a proof for any token on the same URL.

The verifier already asked for it: `crates/proof` returns
`AccessTokenHashMismatch` when it expects an `ath` and the proof has none, so
every DPoP-bound authenticated call from this client was also going to be refused.
Proofs now carry `ath` — `base64url(SHA-256(token))`, the same construction as
`access_token_hash` in the Rust crate — whenever a token is sent, and omit it when
none is, because an unexpected `ath` is rejected too.

## The bound URI included the query string

`htu` was the full request URL. RFC 9449 §4.2 binds scheme, authority and path;
`crates/proof::normalize_htu` drops the query on both sides, so nothing broke, but
a client should not put a caller-controlled query string inside a signed claim the
server then ignores. `htu` is now normalized before signing.

## The client exported a destination fence it did not apply to itself

`normalizeHttpBaseUrl` lives in this package and every careful caller — the
extension, the MCP client — remembered to run its base URL through it first. The
client itself took `baseUrl` verbatim and sent a bearer to it. `apps/pwa` passed
`VITE_HOST_API` straight through, so a build pointed at a cleartext remote host
handed the session token to the network.

`createApiClient` now applies the fence to its own `baseUrl` and refuses to be
built otherwise. The PWA reports the refusal once instead of failing every call.

Two related destinations were also taken on trust: `discover()` passed
`authorization_servers` from the resource metadata through as `string[]` — where a
client goes to be issued tokens, from a document that may not be trustworthy —
and `probeDaemon` would probe any URL handed to it. The first is now filtered
through the same fence, and the second is confined to loopback, since a daemon is
a process on this machine by definition.

## Not fixed here

- ~~DPoP server nonces are not implemented~~ — closed: the client remembers any
  `DPoP-Nonce` a server offers, includes it in later proofs, and retries exactly once
  when a 401 asks for one. A refusal that is not about the nonce is handed back
  untouched, and there is no loop.
- The proof key is generated per client instance and lives only in memory, so a
  reload is a new key. That is deliberate for these local-first surfaces, but it
  means nothing ties a session to a durable key.
