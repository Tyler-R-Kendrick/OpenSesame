# Callback destination binding and replay admission

The callback edge previously authenticated only a body under one shared HMAC
key. A signature did not bind its connection or route. Forwarding was not an
implemented production delivery path, so this was a latent confused-deputy flaw.

The edge now requires `X-OpenSesame-Signature: v1=<base64url HMAC-SHA256>`,
`X-OpenSesame-Timestamp`, and `X-OpenSesame-Delivery-Id`. The MAC covers these
newline-separated fields, without a final newline:

```
v1
POST
/webhooks/<connection>/<route>
<canonical decimal timestamp>
<delivery id>
<lowercase hex SHA-256 of body>
```

HKDF-SHA256 derives each connection key from a 32-byte master, using the salt
`opensesame/callback-edge/key/v1` and exact connection ID as HKDF info. Provision
only a connection-derived key to its sender; never distribute the master. MAC
verification is constant-time. Duplicate signature metadata, noncanonical paths,
encoded delimiters, query routing, and timestamps outside 300 seconds are refused.

Configuration is explicit: `OPENSESAME_CALLBACK_MASTER_KEY` is 64 hex characters;
`OPENSESAME_CALLBACK_ROUTES` contains at most 128 comma-separated exact
`connection/route` entries; `OPENSESAME_CALLBACK_DATABASE_URL` names a pre-created
durable SQLite file. The process uses strict deployment-mode resolution and a
loopback listener; put public ingress behind a TLS reverse proxy. An optional
`OPENSESAME_CALLBACK_PUBLIC_URL` participates in exposure classification. Do not
put keys, request bodies, or signatures in proxy logs.

Migration 0029 provides a unique connection/delivery key. One database transaction
claims it before acceptance; a repeated identical destination/method/body is
idempotent, while a different digest is refused. State survives replicas and
restart, expires after 601 seconds to cover the complete timestamp acceptance
window, and fails closed at a bounded global capacity. Payloads are at most
256 KiB, metadata at most 8 KiB, and destinations come from the explicit registry.

Forwarding is still unavailable. Successful responses explicitly say
`forwarded: false`; setting `OPENSESAME_CALLBACK_FORWARDING` refuses startup.
The old OAuth acknowledgement also refuses instead of claiming a code was
delivered. Future forwarding must add a durable delivery/effect state machine;
an accepted replay claim alone is not proof of downstream delivery.

Focused tests cover real router requests, destination/method/body/delivery/time
swaps, missing and duplicate headers, oversized bodies, concurrent admission,
digest mismatch, and a second database instance after restart. Callback tests,
storage replay tests, and scoped Clippy passed. No external service was attacked.
