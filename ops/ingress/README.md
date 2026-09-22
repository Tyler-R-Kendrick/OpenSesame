# Reference trusted ingress (RFC 9440)

A vendor-neutral, runnable reference for the `trusted_ingress` transport
profile: one Caddyfile, one pinned binary, and an end-to-end test that drives
it against a real origin. It is a *reference* — the directives are the
contract an operator's own edge must meet, not a claim that Caddy is required.

## What it is

```
client ──(1) TLS, client certificate required and verified──▶ ingress (Caddy)
ingress ──(2) TLS, ingress presents its own client certificate──▶ origin trusted_ingress listener
```

Two TLS sessions, not one. The origin's handshake authenticates **the
ingress** (hop 2) with the ingress's own certificate, which its service
binding names with purpose `trusted_ingress` and operation `ingress.forward`.
The **originating client** (hop 1) reaches the origin only as the
`Client-Cert` header the ingress writes. The origin re-validates that
certificate against `OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE`, which
constrains what it accepts, but the client's proof of possession happened at
hop 1 and cannot be recreated; the origin therefore labels the result
`trusted_ingress_assertion` with the ingress's own verified identity beside
it, and attaches it to that one request, never to the pooled connection.

## Files

- `Caddyfile` — the configuration. Every `{$VAR}` is required and documented
  at the top of the file; nothing defaults to an address.
- `caddy.version` — the pinned Caddy release, asset name, URL and digests.
  The upstream checksums file publishes SHA-512; the SHA-256 is recorded too.
- `crates/ingress-evidence/tests/reference_proxy.rs` — the test that runs it.

## What the Caddyfile does, and why each line

| Directive | Why |
|---|---|
| `https://:{$PORT}` + `bind {$BIND}` | A bare port. A hostname in the site address becomes an SNI matcher and Caddy then adds a fallback connection policy *without* client authentication for any other SNI. With a bare port there is exactly one policy. Verified with `caddy adapt`. |
| `tls <cert> <key> { client_auth { mode require_and_verify; trust_pool file <ca> } }` | Every handshake on this listener presents a certificate that chains to the originating-client bundle. Decided at the handshake, before any path exists. |
| `header_up Client-Cert ":{http.request.tls.client.certificate_der_base64}:"` | RFC 9440 §2.2: a Structured Field Byte Sequence of the DER leaf. `header_up name value` is a *set* and replaces every incoming value, which is §2.4 rule 3 for the leaf. |
| `header_up -Client-Cert-Chain` | Caddy has no placeholder for the verified chain, so the field is never emitted and any client-supplied one is deleted. The origin must therefore hold the full originating chain (root and intermediates) in its trust file. |
| `transport http { tls_client_auth <crt> <key>; tls_trust_pool file <origin-ca>; tls_server_name <name> }` | Hop 2: the ingress authenticates itself to the origin and verifies the origin's certificate against the origin CA by name. `tls_trusted_ca_certs` is deprecated in 2.11 and not used. |
| `admin off`, `auto_https off` | No admin API, no ACME; certificates are the operator's. |

The header ops adapt to `{"set": {"Client-Cert": [...]}, "delete": ["Client-Cert-Chain"]}`.
The reference test proves the behaviour rather than trusting the docs: a
client that sends forged `Client-Cert` / `Client-Cert-Chain` fields reaches
the origin with only the ingress-written leaf.

## The health exception

TLS client authentication cannot be waived for a path — the handshake is over
before the path is known, and asking a browser to renegotiate per path is
not something this reference relies on. The exception is therefore a
**separate plaintext listener** (`http://:{$HEALTH_PORT}`) that answers
`/healthz` for the proxy process itself and never forwards to the origin.
The origin's own `/health/live` stays on its plain listener, which yields no
protected operation (`ListenerProvenance::Plain`).

## What it does not do

- It does not make the origin trust `Client-Cert` from anywhere else. The
  origin strips the fields on every listener but its `trusted_ingress` one,
  and there only from a peer its binding set names (`AT-INGRESS-SPOOF`,
  `AT-INGRESS-WRONGPEER`).
- It does not stop a direct connection to the origin's plain or `mtls_required`
  listeners; those listeners simply carry no originating identity
  (`AT-INGRESS-ORIGIN`).
- It does not forward the chain. Put the whole originating-client hierarchy in
  the origin's trust file.
- It does not exempt certificate-authenticated browser requests from CSRF,
  Origin, cookie or CORS controls. Ambient authentication is not consent.

## Running it

```bash
# once: fetch the pinned binary into the fixture cache
. ops/ingress/caddy.version
mkdir -p "$CADDY_CACHE_DIR" && curl -sSL -o "$CADDY_CACHE_DIR/$CADDY_ASSET" "$CADDY_URL"
echo "$CADDY_SHA256  $CADDY_CACHE_DIR/$CADDY_ASSET" | sha256sum -c
tar -xzf "$CADDY_CACHE_DIR/$CADDY_ASSET" -C "$CADDY_CACHE_DIR" caddy

# the end-to-end proof (generates a disposable PKI, starts origin + Caddy on loopback)
OPENSESAME_MTLS_FIXTURES=1 cargo +1.88.0 test -p opensesame-ingress-evidence --test reference_proxy -- --ignored --nocapture
```

The test helper downloads the binary itself when it is absent and verifies
the SHA-256 before running it.
