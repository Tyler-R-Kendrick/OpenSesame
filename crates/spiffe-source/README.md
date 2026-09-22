# opensesame-spiffe-source

SPIFFE X.509 Workload API identity source for the native (host/authority)
plane. It turns the stream of X509-SVID snapshots a local Workload API emits
into atomically activated transport generations, and withdraws them the moment
the source says so or their bounds run out.

## What it does

* **Endpoint** — connects only to the unix socket named by
  `OPENSESAME_SPIFFE_ENDPOINT_SOCKET` or by a `NativeIdentitySpec::Spiffe`
  the runtime already holds. `SpiffeSourceConfig` cannot be deserialized and
  refuses `unix:`/`tcp:`/`http:` URIs and relative paths; a socket path never
  arrives through a request, a browser setting, a connection object or a
  certificate extension.
* **Selection** — exactly the configured `spiffe_id`, or nothing. The
  Workload API's "first returned" SVID and the operator `hint` are never a
  privilege decision. Zero matches is an authoritative withdrawal; two matches
  is refused as ambiguous.
* **Profile** (`svid_profile`) — one canonical URI SAN in the expected trust
  domain with a non-root path; `cA=false`; critical key usage with
  `digitalSignature` and neither `keyCertSign` nor `cRLSign`; an EKU, when
  present, carrying both `serverAuth` and `clientAuth` and the one the TLS role
  needs; no unknown critical extension; valid now. A signing certificate is
  never a caller. The module is pure, so TLS verifiers can run it after chain
  verification.
* **Bundles** (`bundles`) — one map keyed by trust domain. A peer is verified
  against the bundle of the domain **its own** SVID names, then against the
  exact allowed-peer set. There is no union of every domain's anchors, so one
  domain's bundle can never vouch for another domain's SVID, and a domain
  removed from a snapshot stops being trusted at the next generation.
* **Snapshots** — every message replaces the prior state. A missing SVID or
  bundle withdraws at once (`identity_missing` / `trust_unknown`); a message
  whose SVID fails the profile, or that the generation manager refuses, is a
  malformed update that leaves the previous generation usable only until its
  own `not_after`.
* **Outage** — on a stream error or disconnect the current generation is kept
  until `min(not_after, outage_since + max_stale)` and then withdrawn with
  `evidence_expired`; reconnects use bounded, jittered exponential backoff.
  There is no alternate identity input: this source has no PEM, managed
  certificate, or shared operator identity to fall back to.
* **Rotation** — a new key under the same SPIFFE ID is a new generation with
  the same canonical identity; bindings resolve by SPIFFE ID, so rotation
  never changes who the workload is.

## Isolation boundary — read this before promising anything

The X.509 Workload API **returns private-key material to the process**. The
key delivered here is held in process memory (zeroized on drop) and is
`Custody::WorkloadApiDelivered`: it is not hardware-bound, not
non-exportable, and not protected from anything that can read this process's
memory or call the same socket.

Attestation is per **workload selector set**, not per process or per agent:
every process that reaches the same socket under the same selectors (same
unix uid/gid/path, same container, same Kubernetes pod) receives the **same
SVID and the same private key**. Two subagents sharing a uid are one identity
to SPIFFE and can impersonate each other freely. Per-workload isolation is
real only where the platform isolates workloads (distinct uids, distinct pods)
and the registration entries are cut that way; this crate reports the
granularity it was given and invents none. A source configured for
`spiffe://td/a` cannot satisfy a binding for `spiffe://td/b`
(`tests/isolation_binding.rs`), but that is exact-match selection, not
cryptographic separation between siblings.

## Tests

* `cargo +1.88.0 test -p opensesame-spiffe-source` — pure profile/bundle/config
  tests, plus `tests/synthetic_workload_api.rs`: a deterministic in-process
  fake Workload API (`fake` module, `fake-workload-api` feature) driven by a
  script of snapshots, errors and disconnects. This is the unit oracle for
  selection, replacement, withdrawal, malformed updates, outage bounds,
  reconnects and rotation. It is not evidence of SPIRE compatibility.
* `OPENSESAME_MTLS_FIXTURES=1 cargo +1.88.0 test -p opensesame-spiffe-source
  -- --ignored --nocapture` — `tests/spire_reference.rs`: a real
  `spire-server` + `spire-agent` (v1.12.6, linux-amd64 musl, sha256-pinned)
  with join-token node attestation and the `unix` workload attestor, an entry
  for `spiffe://example.test/opensesame/gateway` under the current uid; proves
  the source fetches that SVID, then deletes the entry and proves withdrawal.
  Loopback only, everything in tempdirs, processes killed on drop.

SDK: `spiffe` 0.16.1 (tonic 0.14.6, prost 0.14.4, x509-parser 0.18.1). The
fake's server stubs are generated from `proto/workload_x509.proto`
(`proto/README.md`).
