# Mapping credential transport

The Host mapping client previously reused the NATS callout secret when its own
credential was absent, followed redirects, and trusted unbounded response data.
The client now requires its dedicated credential and receives the already
resolved Gateway deployment classification. Networked development therefore
receives the same HTTPS requirement as production.

The endpoint is an exact canonical origin. DNS has a deadline and bounded
answer count; addresses are checked with the existing connector destination
policy and pinned into a proxy-free, redirect-disabled HTTP client. Private
HTTPS endpoints need explicit exact-endpoint operator configuration. Local HTTP
must resolve exclusively to loopback. TLS retains normal hostname verification.

The response is capped at 8 KiB and decoded into a mandatory flat mapping
record. Unknown or duplicate fields, invalid principals/assurance, and mismatched
issuer/subject are refused. Error responses are never included in local errors.
Neither success nor failure logs credential-bearing URLs or provider bodies.

Focused validation passed seven mapping tests, including owned loopback redirect
targets, oversized responses, identity mismatch, invalid JSON, a stalled server,
and secret-shaped provider errors. Scoped all-feature Gateway library Clippy
passed with warnings denied. The module was temporarily exposed through the
library for isolated validation because the concurrent Gateway binary migration
was not present in this worktree; that temporary exposure was removed. Integrated
startup/callout wiring and its validation are the integration steward's evidence,
not part of this isolated test claim.
