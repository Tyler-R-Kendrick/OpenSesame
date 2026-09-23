# Optional mTLS and workload identity

Reference configuration for the native planes' transport security
([ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md)). Nothing on
this page applies to the static PWA: `apps/pages` boots, unlocks and runs with
no certificate, no environment variable and no backend, and a misconfigured
remote target here breaks that one target and nothing else.

Status at the time of writing (2026-09-22): the Identity listener, the
Rust transport crate, the SPIFFE source, the RFC 9440 parsers, the Caddy
reference and the Pages status panel are in the tree; the Host transport
runtime, worker profile, NATS client options, native callout bridge, OpenBao
certificate login and `ops/nats/` were not yet landed when this page was
reconciled. The ADR's Evidence section and
[docs/validation/mtls-implementation.md](../validation/mtls-implementation.md)
say which of the sections below is executed, not this page.

Two profiles exist. **Local compatibility** is the deployment you already have
and is unchanged by this work. **Secure networked** is what you configure, hop
by hop, when two services stop sharing a machine. Neither is a fallback for
the other: a hop configured `mtls_required` that cannot load its material does
not start, and a hop left on `existing_local` stays on `existing_local`.

## Variables

Every native TLS consumer reads the same variable names under its own prefix
`P`. The prefixes are `OPENSESAME_TLS` (Host secure listener),
`OPENSESAME_MAPPING_TLS` (Host → Identity client), `OPENSESAME_NATS_TLS`
(task-bus client), `OPENSESAME_WORKER_TLS` (worker listener),
`OPENSESAME_CALLOUT_TLS` (auth bridge → Host client) and
`OPENSESAME_CONNECTOR_TLS` (default upstream trust for a private HTTPS
integration). The loader is `opensesame_transport_security::env`. Identity
(Node, `apps/control-plane/src/transport/config.ts`) reads a smaller,
PEM-only set of `OPENSESAME_TLS_*` names described under
[Host → Identity mapping](#host--identity-mapping).

| Variable | Meaning | When it is wrong |
|---|---|---|
| `P_IDENTITY_SOURCE` | `pem` \| `managed` \| `spiffe`. Absent means this consumer presents no identity. | Unknown value: `malformed_configuration`, refuse to start. Absent on an `mtls_required` client: `identity_missing`. |
| `P_CERT_FILE`, `P_KEY_FILE` | PEM chain (leaf first) and PKCS#8 key for `pem`. | Unreadable, CA-as-leaf, key/chain mismatch or expired at load: `key_pair_mismatch` / `identity_missing`; refuse to start. |
| `P_MANAGED_CERTIFICATE_ID` | Id of an ADR 0075 managed certificate for `managed`. | Not in custody, wrong organization or purpose, or no sealing key: `identity_missing`; refuse to start. |
| `P_SPIFFE_ID` | The exact X.509-SVID to select for `spiffe`. Never "first returned". | SVID absent from the Workload API snapshot: `identity_missing` (the service is unavailable, the PWA is not). |
| `P_TRUST_FILE` | PEM bundle used to verify the **peer** — server trust for a client, client CA for a listener. | Unparseable or empty: `trust_unknown`; refuse to start. |
| `P_TRUST_KIND` | `webpki_dns` \| `private_root` \| `spiffe_trust_domain`. | Missing when `P_TRUST_FILE` or `P_TRUST_DOMAIN` is set: `malformed_configuration`. |
| `P_TRUST_DOMAIN` | Trust domain for `spiffe_trust_domain`; the bundle for that domain and only that domain is used. | A peer SVID from another domain: `trust_unknown`, never a union of domains. |
| `P_SERVER_NAME` / `P_SERVER_SPIFFE_ID` | Client-side expected server identity. Exactly one. | Both or neither: `malformed_configuration`. Mismatch at connect: handshake refused before any credential or body is sent. |
| `P_MIN_VERSION` | `1.3` (default) or `1.2`. | Anything else: `malformed_configuration`. TLS 1.2 uses rustls's safe defaults only. |
| `P_CRL_FILE` | Optional CRL PEM checked against the peer's chain. | Unparseable: `trust_unknown`; refuse to start. Stale CRLs are your responsibility — a CRL is only as fresh as its file. |

Common, un-prefixed:

| Variable | Meaning | When it is wrong |
|---|---|---|
| `OPENSESAME_SPIFFE_ENDPOINT_SOCKET` | Unix socket of the Workload API. Deployment-plane only; no API body or tenant form may name one. | Unreachable: a `spiffe` consumer keeps its last valid generation until that generation's own `not_after` or the freshness bound, then `identity_missing`. |
| `OPENSESAME_TLS_LISTEN` | Address of the Host secure listener. The plain listener keeps serving on `--listen`. | Bind failure: `main` returns `Err`. |
| `OPENSESAME_TLS_POLICY` | `server_tls` \| `mtls_required` \| `trusted_ingress` for that listener. | `existing_local` here is refused (`policy_downgrade_refused`); a missing client CA under `mtls_required`: `trust_unknown`. |
| `OPENSESAME_SERVICE_BINDINGS_FILE` | JSON `ServiceBindingSet`. Overrides the stored `host_kv` key `transport.service_bindings`; the override is visible in status. | Invalid ids, duplicate ids, empty `allowed_operations`, wildcard or CN selectors: `malformed_configuration`; refuse to start. |
| `OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE` | Bundle used to re-validate the forwarded originating-client chain on a `trusted_ingress` listener. | Absent under `trusted_ingress`: refuse to start. Re-validation constrains acceptance; it cannot recreate the original handshake. |
| `OPENSESAME_WORKER_LISTEN` | Worker bind address (existing). | — |
| `OPENSESAME_WORKER_TRANSPORT` | `existing_local` \| `mtls_required`. | `mtls_required` without `OPENSESAME_WORKER_TLS_*` and `OPENSESAME_WORKER_BINDINGS_FILE`: the worker exits. In that profile `OPENSESAME_OPERATOR_TOKEN` is not consulted. |
| `OPENSESAME_WORKER_BINDINGS_FILE` | Bindings the worker admits (purpose `worker_client`). | Same rules as the Host bindings file. |
| `OPENSESAME_MAPPING_AUTH` | `shared_secret` \| `mtls` on both Host and Identity. | Both a token and a certificate configured without this variable: startup error on both sides. `mtls` without `OPENSESAME_MAPPING_TLS_*` (Host) or a bound mapping principal (Identity): refuse to start. |
| `OPENSESAME_NATS_CALLOUT_AUTH` | `shared_secret` \| `mtls`. `shared_secret` is accepted only on the plain listener (`existing_local`). | `mtls` without a `nats_auth_bridge` binding: every callout is denied. |
| `OPENSESAME_NATS_AUTH` | `none` \| `nkey` \| `creds`, with `OPENSESAME_NATS_NKEY_SEED_FILE` / `OPENSESAME_NATS_CREDS_FILE`. Authorization credentials, separate from the TLS identity. | Missing file: connect refused; no anonymous fallback. |
| `OPENSESAME_NATS_REQUIRE_TLS` | `1` refuses any plaintext server, including one learned from INFO on reconnect. | Unset on a networked deployment: the client will accept whatever the server offers. Set it. |
| `OPENSESAME_NATS_TLS_FIRST` | `1` performs the TLS handshake before the INFO line where server and client both support it. | Server without `tls.handshake_first`: connect fails; do not remove the flag, fix the server. |

The Host's existing knobs keep their meaning: `OPENSESAME_API_URL` /
`OPENSESAME_IDENTITY_URL`, `OPENSESAME_MAPPING_PRIVATE_ENDPOINT`,
`OPENSESAME_MAPPING_RESOLVE_TOKEN` (only under `shared_secret`),
`OPENSESAME_NATS_CALLOUT_SECRET` (only under `shared_secret`),
`OPENSESAME_NATS_CALLOUT_ISSUERS`, `NATS_URL`, `OPENSESAME_TASKBUS`.

## Profile: local compatibility (unchanged)

Nothing to set. The Host serves plaintext on `--listen`, the daemon is reached
over its Unix socket with kernel peer credentials or the operator token, the
worker listens on loopback with `OPENSESAME_WORKER_TOKEN`, mapping uses
`OPENSESAME_MAPPING_RESOLVE_TOKEN`, the callout bridge presents
`OPENSESAME_NATS_CALLOUT_SECRET`, and the task bus is `memory` or a loopback
NATS. Every one of those is the `existing_local` policy. Status reports
`desired: existing_local`, `credential: unconfigured`,
`enforcement: unverified`, and that is the truthful reading of it.

## Profile: secure networked

Configure each hop you actually cross a network on. The examples use `pem`
files placed by your deployment tooling; substitute `managed` or `spiffe` per
hop as described under [Identity sources](#identity-sources).

### Host secure listener

```bash
export OPENSESAME_TLS_LISTEN=0.0.0.0:8443        # any address; plain --listen stays loopback
export OPENSESAME_TLS_POLICY=mtls_required
export OPENSESAME_TLS_IDENTITY_SOURCE=pem
export OPENSESAME_TLS_CERT_FILE=/etc/opensesame/host.chain.pem
export OPENSESAME_TLS_KEY_FILE=/etc/opensesame/host.key.pem
export OPENSESAME_TLS_TRUST_FILE=/etc/opensesame/service-ca.pem   # client CA
export OPENSESAME_TLS_TRUST_KIND=private_root
export OPENSESAME_SERVICE_BINDINGS_FILE=/etc/opensesame/bindings.json
```

The plain listener still exists for the daemon, the CLI and loopback operator
use. A service purpose configured `mtls_required` that arrives on it is
answered `403 listener_policy_mismatch`; the plain listener is not an
equivalent path to the same operation.

A bindings file:

```json
{
  "revision": 1,
  "bindings": [
    {
      "id": "nats-bridge-1", "revision": 1, "enabled": true, "revoked": false,
      "scope": { "deployment": null },
      "trust_profile": { "name": "service-ca" },
      "peer": { "dns_name": "nats-auth-bridge.svc.example" },
      "service_principal": "svc:nats-auth-bridge",
      "purpose": "nats_auth_bridge",
      "allowed_operations": ["nats.callout.decide"],
      "allowed_audiences": [],
      "not_after": null,
      "denied_thumbprints": []
    }
  ]
}
```

Selectors are `spiffe_id`, `dns_name`, `uri_san` or
`leaf_thumbprint_sha256`, exact. There is no wildcard, CN, email or IP form,
and a file that tries one is refused whole. Exactly one live binding must
match a peer for a purpose; two is `ambiguous_binding`, none is
`peer_not_bound`. Both are denials.

### Worker

```bash
export OPENSESAME_WORKER_LISTEN=0.0.0.0:8790
export OPENSESAME_WORKER_TRANSPORT=mtls_required
export OPENSESAME_WORKER_TLS_IDENTITY_SOURCE=pem
export OPENSESAME_WORKER_TLS_CERT_FILE=/etc/opensesame/worker.chain.pem
export OPENSESAME_WORKER_TLS_KEY_FILE=/etc/opensesame/worker.key.pem
export OPENSESAME_WORKER_TLS_TRUST_FILE=/etc/opensesame/service-ca.pem
export OPENSESAME_WORKER_TLS_TRUST_KIND=private_root
export OPENSESAME_WORKER_BINDINGS_FILE=/etc/opensesame/worker-bindings.json
```

The worker's bindings name the calling service's identity with purpose
`worker_client` and operations `worker.providers.list` and
`worker.health.ready`. Nothing in the tree dials the worker's HTTP endpoints
today; the listener is secured so that whatever an operator does point at it
is admitted by binding, not by a shared token. In this
profile the worker never reads `OPENSESAME_OPERATOR_TOKEN`; provider
allowlists and personal-only refusals apply after admission exactly as
before. Public liveness stays a minimal unauthenticated response; readiness
runs no provider probe before the caller is admitted.

### Host → Identity mapping

Host:

```bash
export OPENSESAME_API_URL=https://identity.example/
export OPENSESAME_MAPPING_AUTH=mtls
export OPENSESAME_MAPPING_TLS_IDENTITY_SOURCE=pem
export OPENSESAME_MAPPING_TLS_CERT_FILE=/etc/opensesame/host.chain.pem
export OPENSESAME_MAPPING_TLS_KEY_FILE=/etc/opensesame/host.key.pem
export OPENSESAME_MAPPING_TLS_TRUST_FILE=/etc/opensesame/identity-ca.pem
export OPENSESAME_MAPPING_TLS_TRUST_KIND=private_root
export OPENSESAME_MAPPING_TLS_SERVER_NAME=identity.example
```

Identity (its listener is PEM-only; there is no `managed` or `spiffe` source
on the Node plane, and its trust variable is named for what it is — the client
CA):

```bash
export OPENSESAME_MAPPING_AUTH=mtls
export OPENSESAME_TLS_LISTEN=0.0.0.0:8789
export OPENSESAME_TLS_POLICY=mtls_required
export OPENSESAME_TLS_CERT_FILE=/etc/opensesame/identity.chain.pem
export OPENSESAME_TLS_KEY_FILE=/etc/opensesame/identity.key.pem
export OPENSESAME_TLS_CLIENT_CA_FILE=/etc/opensesame/service-ca.pem     # CA certificates only
export OPENSESAME_TLS_CLIENT_TRUST_PROFILE=service-ca                    # the trust_profile name bindings use (default client_ca)
export OPENSESAME_TLS_MIN_VERSION=1.3
export OPENSESAME_SERVICE_BINDINGS_FILE=/etc/opensesame/identity-bindings.json
# optional: only when the TLS listener is reachable at a different public URL than the issuer;
# then, and only then, discovery advertises mtls_endpoint_aliases for it
export OPENSESAME_TLS_PUBLIC_URL=https://identity-mtls.example
```

Identity's startup rules: `OPENSESAME_TLS_LISTEN` requires `OPENSESAME_TLS_POLICY`,
`_CERT_FILE` and `_KEY_FILE`; `mtls_required` / `trusted_ingress` require
`OPENSESAME_TLS_CLIENT_CA_FILE` holding only CA certificates; the key must
match the leaf and the leaf must not be a CA, or the boot is refused with the
same `key_pair_mismatch` / `trust_unknown` codes the Host uses.
`OPENSESAME_MAPPING_AUTH` is inferred as `mtls` when a client-authenticating
listener with a bindings file is configured and no
`OPENSESAME_MAPPING_RESOLVE_TOKEN` is set, and as `shared_secret` otherwise;
when both a token and such a listener are present it must be set explicitly
or Identity refuses to start.

Everything in [mapping-resolve.md](mapping-resolve.md) still holds: HTTPS or
explicit loopback, no path prefix, DNS bounded and pinned, no proxy, no
redirects, two-second connect and five-second request deadlines, 8 KiB
responses, issuer and subject echoed back and checked. The certificate rides
inside those fences; it does not loosen them. Under `mtls` the Identity side
does not require `OPENSESAME_MAPPING_RESOLVE_TOKEN` to boot, and the Host side
never falls back to the callout secret or the operator token. The Identity
binding admits the Host principal for `principals.mapping.resolve` and nothing
else — not user administration, not trust, not operator routes.

### NATS

Client (Host, worker, bridge — each with its own identity and its own NKey or
credentials file):

```bash
export NATS_URL=tls://nats.example:4222
export OPENSESAME_TASKBUS=nats
export OPENSESAME_NATS_REQUIRE_TLS=1
export OPENSESAME_NATS_TLS_FIRST=1
export OPENSESAME_NATS_TLS_IDENTITY_SOURCE=pem
export OPENSESAME_NATS_TLS_CERT_FILE=/etc/opensesame/host.chain.pem
export OPENSESAME_NATS_TLS_KEY_FILE=/etc/opensesame/host.key.pem
export OPENSESAME_NATS_TLS_TRUST_FILE=/etc/opensesame/nats-ca.pem
export OPENSESAME_NATS_TLS_TRUST_KIND=private_root
export OPENSESAME_NATS_TLS_SERVER_NAME=nats.example
export OPENSESAME_NATS_AUTH=nkey
export OPENSESAME_NATS_NKEY_SEED_FILE=/etc/opensesame/host.nk
```

Server: the reference configurations live in `ops/nats/`. Two client-admission
profiles are shipped and they are not interchangeable:

- **Profile A — admission plus existing authorization** (`tls { verify: true
  }`): the server requires a client certificate from `nats-ca.pem`; *who* the
  connection is remains the NKey/JWT or the auth callout's decision. This is
  the default and the only profile the bridge assumes.
- **Profile B — certificate-to-user mapping** (`verify_and_map: true`): the
  server maps the certificate's SAN/DN to a NATS user. It is opt-in, needs its
  own explicit user entries in the server config that correspond one-to-one to
  operator bindings, and has its own tests. The server's built-in email/DN
  mapping must never be used to reach an OpenSesame principal.

Client mTLS covers **client connections only**. Route, gateway, leaf-node and
WebSocket listeners have separate `tls` blocks, and each topology advertised
here has its own configuration and its own test in `ops/nats/`; a topology
that is not in that directory is not supported by this document. The
server-to-server topology that ships is named there, with the command that
proves it.

The auth callout is native: `opensesame-nats-auth-bridge` subscribes to
`$SYS.REQ.USER.AUTH` in the auth account, verifies the request JWT's signature,
kind, time window and server context, and then asks the Host to decide over
`OPENSESAME_CALLOUT_TLS_*` as a bound `nats_auth_bridge` peer. The Host
verifies the user's upstream token itself — issuer, audience, signature,
expiry — and does not take the bridge's word for `issuer`/`subject`. The
`opensesame.callout.>` subject prefix is an internal namespace unrelated to
the protocol. The bridge's auth-account credentials must grant exactly the
subscribe/publish needed to receive and answer callouts. Set
`OPENSESAME_NATS_CALLOUT_AUTH=mtls` on the Host; `shared_secret` is accepted
only on the plain listener and only for `existing_local` deployments.

### OpenBao certificate authentication

Upstream mTLS is a property of a connection, not of the deployment: a
ConnectionRef whose connection names a transport identity reference and a
trust reference gets a TLS client scoped to that tenant, connection,
destination authority, credential generation and trust generation, inside the
same egress allowlist, no-redirect and response-cap fences as every other
brokered call. OpenBao's `auth/cert` login is the concrete consumer:

- the connection names the mount (`auth/cert`), the role, and the identity
  and trust references; it never carries a key, a path or a socket;
- the role's `allowed_common_names` / `allowed_uri_sans` on the OpenBao side
  and the binding on ours both have to agree before a login is attempted;
- the resulting OpenBao token is cached per connection and executor, expires
  on its own TTL, and is revoked with OpenBao's revoke endpoint. Revoking the
  certificate does not revoke a token already issued.

`OPENSESAME_CONNECTOR_TLS_TRUST_*` supplies the default trust for a private
HTTPS integration that has no connection-level trust reference. It never
supplies an identity.

Token and AppRole authentication remain explicit modes on the connection.
None of the three is a fallback for another.

### Identity sources

`pem` is above. For a Host-held key:

```bash
export OPENSESAME_TLS_IDENTITY_SOURCE=managed
export OPENSESAME_TLS_MANAGED_CERTIFICATE_ID=cert_01J...
```

The certificate must have been issued with `managed: true` (ADR 0075) in the
Host's own organization for a transport purpose; the Host opens the sealed key
at load and at every renewal. Custody is `host_sealed_exportable_to_host`: the
key is exportable to the Host process by construction and to an owner, admin
or operator through `GET /api/v1/certs/{id}/key`. It is not hardware-bound.
Renewal keeps ADR 0075's lead clamp; a renewed leaf becomes a new generation
only after it passes the same validation a file would.

For a SPIFFE Workload API:

```bash
export OPENSESAME_SPIFFE_ENDPOINT_SOCKET=/run/spire/sockets/agent.sock
export OPENSESAME_TLS_IDENTITY_SOURCE=spiffe
export OPENSESAME_TLS_SPIFFE_ID=spiffe://example.org/opensesame/host
export OPENSESAME_TLS_TRUST_KIND=spiffe_trust_domain
export OPENSESAME_TLS_TRUST_DOMAIN=example.org
```

Custody is `workload_api_delivered`: the agent hands the private key to the
process. Every process that can open that socket under the same attestation
gets the same SVID, so the isolation unit is the process, not a subagent or a
task inside it. SPIRE is one issuer that speaks this API; it is optional, and
the source is validated against a real SPIRE agent by the interop suite when
`OPENSESAME_MTLS_FIXTURES=1` and the fixture is present. Each Workload API
snapshot replaces the previous one whole: an SVID or bundle that disappears
from the stream stops authorizing immediately, and an outage keeps the last
generation only within its own validity.

### Trusted ingress (browser-facing)

A browser cannot be made to present a vault key; it can present a certificate
its OS or profile already holds, provisioned by something other than
OpenSesame. The supported shape is two TLS hops:

```text
browser ──(TLS, client cert optional/required per hostname)──▶ ingress ──(mTLS, bound peer)──▶ origin
```

`ops/ingress/Caddyfile` (Caddy 2.11.4, pinned in `ops/ingress/caddy.version`)
is the reference. It terminates the browser hop with
`client_auth { mode require_and_verify }` against the originating trust
bundle, discards whatever `Client-Cert` the client sent and sets it to the
leaf the proxy itself verified, **deletes** `Client-Cert-Chain` rather than
forwarding it (Caddy has no placeholder for the chain, so the origin
re-validates the leaf alone against the originating trust bundle), and dials
the origin over its own mTLS connection with `tls_client_auth`,
`tls_trust_pool` and `tls_server_name`. Its site address is a bare port on
purpose: a hostname would become an SNI matcher and Caddy would add a
fallback policy without client authentication for any other SNI. Its
variables are `OPENSESAME_INGRESS_BIND`, `OPENSESAME_INGRESS_PORT`,
`OPENSESAME_INGRESS_CERT` / `_KEY` (hop 1 server identity),
`OPENSESAME_ORIGINATING_TRUST`, `OPENSESAME_ORIGIN_ADDR`,
`OPENSESAME_ORIGIN_TRUST`, `OPENSESAME_ORIGIN_NAME`,
`OPENSESAME_INGRESS_CLIENT_CERT` / `_KEY` (hop 2 client identity) and
`OPENSESAME_INGRESS_HEALTH_PORT` (a separate plaintext listener answering
`/healthz` for the proxy process only — a path cannot be exempted from a
handshake, so the exception is a different listener). All are required;
nothing defaults to an address. The origin:

```bash
export OPENSESAME_TLS_POLICY=trusted_ingress
export OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE=/etc/opensesame/browser-ca.pem
# plus OPENSESAME_TLS_* identity and the ingress CA as OPENSESAME_TLS_TRUST_FILE
```

accepts those fields only when the immediate peer is a binding with purpose
`trusted_ingress`, only on that listener, and attaches the originating
identity to that request rather than to the pooled connection. Re-validating
the forwarded chain against `OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE`
constrains what is accepted; it does not re-prove possession — the ingress
did that, and the evidence source is labelled `trusted_ingress_assertion` for
exactly that reason. A direct request to the origin's address, an alternate
hostname, IPv6 or another port with those headers is refused
(`forwarded_evidence_unverified`), because no bound ingress sent it.

Certificate policy is per hostname, decided at the handshake. Do not try to
require a certificate on one path: there is no reliable renegotiation, least
of all under HTTP/2. Origin checks, CSRF protection, cookie attributes, CORS
and cache isolation stay in force — a browser certificate is ambient
authentication, not a substitute for any of them.

Playwright's `clientCertificates` option proves that the harness can present a
certificate to the reference stack. It proves nothing about a user's OS
certificate selection or provisioning on Windows, macOS, iOS or Android,
which this work does not test.

## Root approval and trust rollover

Trust anchors are deployment decisions. `PUT
/api/v1/operator/transport/trust` (deployment operator credential only — an
organization's owner or admin session gets `403`; ≤ 64 KiB,
`deny_unknown_fields`) installs, replaces or removes a bundle for a named
profile and writes an audit event. The same holds for the service-binding set
(`GET`/`PUT /api/v1/operator/transport/bindings`), the enforcement probe
(`POST /api/v1/operator/transport/verify`) and revocation *by thumbprint*
(`POST /api/v1/operator/transport/certificates/revoke` with `thumbprint`);
an organization's configurators keep revocation of their own certificates by
`certificate_id`, issuance, and the read-only status, trust, facts and
renewal views. The facts and renewal views are organization-scoped for a
session: a target whose certificate another organization holds answers
`404`, and the renewal queue lists only the caller's organization's
entries; the deployment operator sees every target and the whole queue.

A trust write is validated whole (every anchor builds, the document fits in
64 KiB) and stored with a compare-and-set against the *stored* revision
before it is activated, so a refused write — `400` for an oversized or
unusable set, `500` when the store refuses — leaves the serving anchors
exactly as they were, and two gateway processes holding the same revision
cannot both win (the loser gets `409 stale_revision`). If activation fails
after the store accepted the write, the previous profiles are stored again
under the next revision, so no process is left serving a set the store does
not hold. Every gateway process re-reads the stored trust set every 15 s
(the bindings `REFRESH_INTERVAL`) and at boot before it serves, activating a
newer revision — a removed anchor stops being trusted on the other replicas
within that bound, not at their next restart — and never moving back to an
older one. A trust write never re-activates a withdrawn generation and
is refused (`generation_stale`) if the serving generation changed while it
was being built. A bundle is never fetched or imported
because a certificate, CSR, URL or manifest suggested it.

Rollover is an explicit overlap: install the new root beside the old under the
same profile, rotate every peer's identity to the new root, confirm through
status that no observed authentication still chains to the old root, then
remove it. Each step is a new trust generation. There is no automatic
"recover by trusting a different authority" path; an identity that no longer
chains is a refusal.

## Rotation

- **Files:** replace both files, then signal the process (SIGHUP on the Host
  and worker). The candidate is validated whole — key matches leaf, chain
  builds, leaf not expired — and swapped atomically as a new credential
  generation. A bad candidate is reported (`reload_failed` with its code) and
  the previous generation keeps serving inside its own validity only.
- **Managed:** ADR 0075 renewal produces the successor; the transport runtime
  observes `lifecycle.renewal.succeeded` and loads it as a new generation with
  the same validation. Renewal success is recorded separately from
  installation success.
- **SPIFFE:** the Workload API stream drives generations; no other renewal
  logic runs on those identities.

A new generation invalidates pooled client connections authenticated under the
old one. Status shows `runtime.loaded.generation` so you can see which one is
live. A rotated certificate keeps the service's principal, bindings, quotas
and audit lineage: the binding matches by name selector, and only a
`leaf_thumbprint_sha256` selector needs updating.

## Revocation, with the bound each layer actually enforces

| Layer | Mechanism | Takes effect |
|---|---|---|
| New handshakes | The revoke verb writes the thumbprint to the durable revoked-leaf denylist (`host_kv` `transport.revoked_leaves`), then to `denied_thumbprints` on every stored binding (binding revision bump, CAS retried on a lost race); or remove the root; optionally `P_CRL_FILE` | The next connection attempt in the process that took the write; other gateway processes sharing the store adopt the denylist and the new binding revision within 15 s (`REFRESH_INTERVAL`) or on their next binding read or write. The denylist is read before a restarted gateway serves (an unreadable denylist stops boot) and is consulted for every binding, including one created after the revocation. If either durable write cannot be applied the verb answers with an error (`409 stale_revision` after bounded retries, `409 denylist_full`, `409 denylist_quota`, `500 storage_error`), not `200` — the leaf is already refused in the process that took the call, and a denylist that refuses the entry still lets the binding write, the facts and the notice run first; repeat the revocation, which is idempotent. The denylist holds at most 4,096 live entries: each records its revoker and the leaf's `not_after`, entries more than 24 h past `not_after` are pruned in the same conditional write, one organization holds at most 256, and tenants together never take the last 1,024, so a tenant cannot crowd out the operator. |
| Clients behind a trusted ingress | The same revoked-leaf hook is applied to the forwarded originating leaf, and a certificate-bound token naming a revoked leaf is refused (`evidence_revoked`) | The next forwarded request. |
| Existing native HTTP connections | Every protected request re-resolves the binding and rechecks `denied_thumbprints`, the trust and credential generations, and `usable_until` (`authenticated_at + min(usable_for, certificate remaining)`) | The next protected request on that connection, and unconditionally when `usable_until` passes. |
| NATS sessions | The callout response carries an authorization expiry the **server** enforces by disconnecting; the client's own timer is not relied on | The expiry issued at admission; shorten it in the callout policy if you need a tighter bound. A reissued decision on reconnect goes through admission again. |
| OpenBao tokens | The token's TTL, or `auth/token/revoke` | The token's own lifetime. Certificate revocation leaves it valid. |
| OAuth access tokens | Token lifetime; RFC 7009 revocation on Identity. A certificate-bound token's `cnf` names the old leaf, so a rotated certificate cannot use it and a new token must be acquired | The token's own lifetime. |
| Browser application cache and local vault | None from here. Cached code keeps running; the vault opens with its local protectors | Never, by remote action. |

Do not read a database status change or a green status field as revocation.
The bound is the row above, per layer, and nothing here erases anything from a
device.

## Outage behavior

- **Trust or identity file unreadable at start:** the consumer refuses to
  start. No downgrade.
- **Workload API unreachable:** the last valid generation keeps serving until
  its own `not_after` or the freshness bound; `credential` reports
  `configured` with the generation and `runtime` reports the last load.
  When it expires the service is `identity_missing` and unavailable. The PWA
  is unaffected.
- **Identity unreachable from the Host (mapping):** authentication of callers
  that need mapping fails closed, as it does today.
- **NATS unreachable:** the task bus reconnects only to servers that satisfy
  the same identity policy; a plaintext or wrong-name server offered on
  reconnect is refused and the process does not switch to the memory bus.
- **Ingress unreachable:** browser-facing traffic stops; the origin does not
  open a direct browser listener to compensate.
- **Trust generation removed while connections are open:** those connections
  are denied on their next protected request (`generation_stale`).

## Diagnostics

`GET /api/v1/operator/transport/status` (configurator-gated) returns one
`TransportStatusView` per target. Read the dimensions separately:

| Field | Values | Reading |
|---|---|---|
| `desired` | `existing_local` / `server_tls` / `mtls_required` / `trusted_ingress` | What you asked for. Says nothing about what is running. |
| `credential` | `unconfigured`, `configured { custody, generation, not_after, kind }`, `expired`, `revoked`, `external_provisioning_required`, `unsupported_in_browser` | Whether usable material exists and whose custody it is in. |
| `runtime` | `not_loaded`, `loaded { generation, loaded_at }`, `reload_failed { generation, code }` | Whether the process actually installed that material. |
| `observed` | `null` or `{ at, observer, target, generation, peer }` | The last peer authentication seen. Proof that a certificate was accepted, nothing more. |
| `enforcement` | `unverified`, `verified { at, target, generation, accepted_with_certificate, rejected_without_certificate, fresh_until }`, `stale { verified_at, generation, current_generation }` | Whether the target was shown to reject callers without a certificate, under which generation, and until when that evidence counts. |
| `capabilities` | per-source `supported` / `unsupported` / `external_provisioning_required`, plus `client_presents_certificate` and `server_enforces_certificate` | What this runtime can do at all. `browser_vault_key_injection` is always `unsupported`. |

`POST /api/v1/operator/transport/verify` (deployment operator only) is the only thing that moves
`enforcement` to `verified`. It sends `GET /health/live` to the named target
twice — with the configured client identity and with none — and records both
results against the generation in force. Only the pair counts: an accepted
certificate proves acceptance, a rejected bare connection proves enforcement.
The probe targets are the deployment's own configured peers; the route takes
no host, URL or path from the caller, performs no business operation and signs
nothing on request.

Error codes (`TransportError::code()`), stable and non-secret:

| Code | Meaning | Usual cause |
|---|---|---|
| `identity_missing` | No identity is configured or loadable for this consumer | Unset source, missing SVID, custody refused |
| `key_pair_mismatch` | Certificate and key do not match | Rotated one file but not the other |
| `trust_unknown` | The peer's chain does not reach a bundle for its profile or domain | Wrong CA file, foreign trust domain, stale bundle |
| `peer_not_bound` | Authenticated, but no binding matches profile, selector and purpose | Missing binding, selector typo, wrong purpose |
| `peer_disallowed` | Bound, but not for this operation, audience or scope | Operation not in `allowed_operations` |
| `ambiguous_binding` | More than one live binding matches | Overlapping entries; disable one |
| `evidence_expired` | Past `usable_until` or the certificate window | Long-lived connection; certificate expired |
| `evidence_revoked` | Leaf thumbprint in `denied_thumbprints` or CRL | Revocation working as intended |
| `generation_stale` | Evidence was produced under a superseded generation | Rotation or trust change since the handshake |
| `source_unsupported` | This platform cannot supply that source | `spiffe` in the browser, `managed` without a sealing key |
| `forwarded_evidence_unverified` | RFC 9440 fields arrived from something other than a bound ingress on the `trusted_ingress` listener | Direct request, wrong listener, unbound proxy |
| `proof_mismatch` | `cnf.x5t#S256` (or DPoP `jkt`) does not match the presented evidence | Token minted with another certificate |
| `listener_policy_mismatch` | The purpose is `mtls_required` but the request came over the plain listener | Client dialed the wrong port |
| `binding_disabled` | The matching binding is disabled, revoked or outside its window | Operator action |
| `enforcement_unsupported` | The receiving side cannot enforce the requested policy | Topology not shipped; refuse rather than pretend |
| `policy_downgrade_refused` | A required policy would have been weakened | `existing_local` on a TLS listener, reconnect to plaintext |
| `malformed_configuration` | Anything unparseable, with a non-secret detail | Typos, wildcard selectors, both server-name forms |

## Commands

```bash
pnpm test:mtls               # scripts/mtls-test.sh — fast native + TS suites, no fixtures;
                             #   includes scripts/mtls-static-imports.mjs (no native TLS in the bundle)
pnpm test:mtls:integration   # scripts/mtls-integration-test.sh — real nats-server, OpenBao,
                             #   SPIRE and the Caddy ingress from pinned fixtures
pnpm test:mtls:browser       # scripts/mtls-browser-test.mjs — Playwright clientCertificates
                             #   against the ingress reference, plus the static app with none
pnpm test:mtls:fixtures      # scripts/mtls-fixtures.sh fetch all && verify — pinned binaries to
                             #   .cache/mtls-fixtures/<tool>-<version>/, archive and binary sha256
                             #   checked before use; linux-amd64 only (exit 3 elsewhere)
bash scripts/mtls-fixtures.sh path <tool>   # nats-server | nats-server-2.10 | openbao | spire-server
                                            #   | spire-agent | caddy — prints the verified binary path
```

Test material (CAs, leaves, keys) is generated per run in a temporary
directory and deleted; no private key is committed. A crate or suite named in
`scripts/mtls-required-packages.txt` that is missing, selects zero tests, or
leaves every test ignored turns the run red; a fixture that cannot be fetched,
verified or started does the same. Nothing skips to green. Each run writes a
sanitized manifest and logs under `artifacts/mtls/runs/<suite>-<timestamp>-<pid>/`
with the tested tree identifier, resolved versions, scenario ids, commands and
exit codes; private keys, bearer tokens, JWTs, NKey seeds and TLS key logs are
scrubbed before anything is written or hashed. The narrative record is
[docs/validation/mtls-implementation.md](../validation/mtls-implementation.md).
