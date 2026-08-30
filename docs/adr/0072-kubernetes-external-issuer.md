# ADR 0072 — Kubernetes cert-manager external issuer

Status: Accepted
Date: 2026-08-30
Supplements: ADR 0017 (host/client topology), ADR 0048 §5 (dependency budget),
ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md)),
ADR 0066 (Certificate Manager domain model),
ADR 0068 (enrollment protocol servers)
Plan: [docs/superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md](../superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md)

## Context

cert-manager is how certificates get into Kubernetes. A workload asks for a
`Certificate`, cert-manager creates a `CertificateRequest`, an issuer fulfills
it, and the result lands in a `Secret` the pod mounts. Any CA that wants to
serve Kubernetes has to appear as an issuer in that loop.

ADR 0068 already gives OpenSesame one way in: cert-manager's built-in ACME
issuer can point at an OpenSesame ACME directory with no OpenSesame-specific
software in the cluster at all. That path is real and is the right default for
many clusters. It is also constrained by what ACME can express — DNS
identifiers, a challenge, a CSR — which is a subset of what a
`CertificateRequest` carries and of what ADR 0066's profile model can constrain.

For clusters that want profile-scoped issuance, URI SANs for SPIFFE identities,
application-scoped audit, or the approval workflows, the loop needs an external
issuer: a controller in the cluster that watches `CertificateRequest`s addressed
to it and fulfills them against the OpenSesame API.

## Decision

### 1. `apps/k8s-issuer`: a kube-rs controller, written in Rust

The external issuer is a new binary `opensesame-k8s-issuer` in the forthcoming
`apps/k8s-issuer`, built on `kube-rs` and `k8s-openapi`, with deployment
manifests under `apps/k8s-issuer/deploy/` and a README.

The alternative — and it is the conventional choice — was **Go**, using
`controller-runtime` and cert-manager's own `sample-external-issuer` scaffold.
Go has the mature Kubernetes ecosystem, better generated-client tooling, and
more prior art for exactly this component. It was still rejected:

- **It would be the first Go in this repository.** A third toolchain means a
  third linter, a third formatter, a third dependency-audit story, a third
  cache in CI, and a third set of version pins to keep current — against
  `pnpm audit:*` and `cargo +1.88.0` gates that today cover everything. That
  cost is permanent and is paid by every contributor, not just the ones
  touching this binary.
- **The API client already exists in Rust.** The controller's non-Kubernetes
  half is "authenticate with a machine identity, POST a CSR to
  `/api/v1/certmgr/apps/{id}/certificates`, read back a chain". In Rust it
  shares the request and response types with the gateway that serves them, so a
  contract change is a compile error rather than a runtime mismatch discovered
  in a cluster. In Go it would be a hand-maintained second client.
- **`kube-rs` is sufficient for this controller.** Custom resource derivation,
  a watch-and-reconcile runtime, owner references, status subresources, and a
  fake client for testing are all present. The places Go's ecosystem is clearly
  ahead — webhook conversion, complex multi-CRD lifecycle, generated deep-copy
  for large APIs — are not places this controller goes.

The honest cost: fewer Kubernetes-Rust practitioners than Kubernetes-Go ones, so
contributions to this binary draw from a smaller pool, and cert-manager's own
scaffolding and integration-test harness are unavailable to us. We accept that
in exchange for not fragmenting the build.

Gate: `cargo +1.88.0 build -p opensesame-k8s-issuer`

### 2. CRDs `Issuer` and `ClusterIssuer` in group `certmgr.opensesame.dev`

Two custom resources, following cert-manager's own namespaced/cluster-scoped
convention so the mental model transfers:

- **`Issuer`** (namespaced) — usable by `Certificate` resources in its namespace.
- **`ClusterIssuer`** (cluster-scoped) — usable cluster-wide.

Both carry the same spec: the OpenSesame API base URL, the application id, the
profile id, and a reference to a `Secret` holding the machine-identity
credential. Both expose a `status` with `Ready` conditions, so
`kubectl describe issuer` explains a misconfiguration rather than leaving the
operator to read controller logs.

The group is `certmgr.opensesame.dev` — our own, not a subgroup of
`cert-manager.io`. Squatting in another project's API group would collide with
their versioning and is not ours to do.

A `Certificate` selects one by the standard `issuerRef` with
`group: certmgr.opensesame.dev`, which is the mechanism cert-manager already
provides for external issuers. No cert-manager fork, no admission webhook, no
patch.

Gate: `cargo +1.88.0 test -p opensesame-k8s-issuer`

### 3. Reconciling `CertificateRequest`s against the API-enrollment route

The controller watches cert-manager `CertificateRequest` resources whose
`issuerRef` names one of our issuers, and for each one:

1. resolves the referenced `Issuer`/`ClusterIssuer` and refuses if it is not
   `Ready`;
2. checks the request is **approved** — cert-manager's approval condition is
   honored, so a cluster's existing approval policy still governs;
3. reads the machine-identity credential from the referenced `Secret`;
4. POSTs the request's CSR to
   `POST /api/v1/certmgr/apps/{id}/certificates` (ADR 0066 §1) in CSR mode;
5. writes the issued certificate to `status.certificate` and the issuing chain
   to `status.ca`, then sets the `Ready` condition.

The CSR is passed through **unmodified**. The controller does not parse it,
rewrite subjects, or add SANs — including URI SANs, which is how SPIFFE
identities survive the round trip. The gateway's profile policy (ADR 0066 §2) is
the single place a request is constrained; a controller that also filtered would
create a second, divergent policy nobody could see from the OpenSesame side.

**Only the private key never travels.** cert-manager generates the key in the
cluster and keeps it there; only the CSR leaves and only a certificate comes
back. There is no managed-key mode for this path, deliberately: a Kubernetes
issuer that shipped private keys into the cluster over the API would give up the
one custody property this integration gets for free.

Failures set a `Ready=False` condition with a reason and requeue with backoff.
A denied or policy-violating request is terminal, not retried — retrying a
request the policy rejects is a hot loop against the gateway.

Gate: `cargo +1.88.0 test -p opensesame-k8s-issuer`

### 4. Machine-identity authentication, and the CA chain in `ca.crt`

The controller authenticates as a **machine identity**, not as a user session.
Its credential is a universal machine-identity token, or an in-cluster token
where the deployment supports it, held in a `Secret` referenced by the issuer
spec rather than embedded in it — so it is rotatable with a `Secret` update and
never appears in `kubectl get issuer -o yaml`.

Its authorization is exactly application `operator` on the named application
(ADR 0066 §3): enough to request and renew certificates, not enough to edit
profiles, membership, enrollment configs or syncs. A compromised controller can
obtain certificates its profile permits; it cannot widen that profile.

The issuing chain is written to `status.ca`, which cert-manager copies into the
`ca.crt` key of the resulting `Secret`. This matters more than it looks: for a
`private_local` CA (ADR 0052-cert's trust class, which is what an internal
OpenSesame CA issues), workloads have no ambient trust for the root, and
`ca.crt` is how a pod obtains it to validate its peers. An issuer that populated
only `tls.crt` and `tls.key` would produce certificates nothing in the cluster
could verify.

Gate: `cargo +1.88.0 test -p opensesame-k8s-issuer`

### 5. Reconciliation is tested against a fake client; there is no live-cluster e2e

Reconcile logic is tested against `kube`'s fake client with recorded API
responses: happy path, unapproved request, not-ready issuer, missing secret,
gateway rejection, and requeue behavior.

There is **no live-cluster end-to-end test**. Standing up a real cluster with a
real cert-manager installation in CI is a dependency and a flake source out of
proportion to this component, and a `kind`-based test would still not be a real
cluster. Recorded as a limitation in `docs/validation/certificate-manager.md`:
the controller's interaction with a genuine cert-manager release is validated by
operator acceptance testing, not by our gate.

Gate: `cargo +1.88.0 test -p opensesame-k8s-issuer`

### 6. When to use the external issuer, and when to use the ACME server

Both paths stay supported. They are not redundant, and the README says which is
which:

| | ACME server (ADR 0068) | External issuer (this ADR) |
|---|---|---|
| Cluster install | none beyond cert-manager | CRDs + controller Deployment |
| Configured with | a directory URL + EAB secret | issuer CRD + machine-identity Secret |
| Identifiers | DNS names (ACME's model) | anything the CSR carries, incl. URI SANs |
| Scoping | per profile | per application **and** profile |
| Approvals | ACME account + EAB only | OpenSesame approval workflows apply |
| Audit granularity | ACME order events | application-scoped certmgr audit events |

**Prefer the ACME server** when the cluster wants DNS-named TLS certificates and
the operator does not want to install or upgrade another controller. It is the
zero-install path and it is genuinely the right answer for most clusters.

**Prefer the external issuer** when you need SPIFFE/URI SANs preserved,
application-scoped membership and audit, approval workflows in front of
issuance, or profile selection per `Certificate` rather than per directory URL.

Gate: `cargo +1.88.0 test -p opensesame-k8s-issuer`

## Consequences

- Kubernetes becomes a first-class consumer of OpenSesame-issued certificates,
  by two independent routes with different install costs.
- The workspace gains a Kubernetes controller in Rust. `kube` and `k8s-openapi`
  are substantial dependencies, pinned in the root `Cargo.toml`, scoped to this
  binary and excluded from the daemon under ADR 0048 §5.
- The controller is a machine identity with standing `operator` authority on an
  application. Its `Secret` is a credential to rotate and to scope narrowly; the
  deployment manifests default to a dedicated identity per issuer.
- No live-cluster validation. This is the largest untested seam in the
  certificate work and is recorded as such.
- CRD versioning is now our obligation: `v1alpha1` today, and any breaking spec
  change needs a conversion story or a new version, because installed CRs
  outlive controller upgrades.
