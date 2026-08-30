# ADR 0061 — Connector/hook architecture: Wasm-first community connectors

Status: Accepted
Date: 2026-08-30
Supplements: ADR 0005 (ConnectionRef), ADR 0032 §3 (catalog is data),
ADR 0039 (backup saga), ADR 0046 §11–12 (approval hooks, signed event
streams), ADR 0048 §5 (dependency quarantine), ADR 0052/0053 (PM bridging
and bridge binaries), ADR 0055 (provider registry)
Research: [docs/research/hooks-ecosystem.md](../research/hooks-ecosystem.md)

## Context

OpenSesame's brokered capabilities are first-party and hardcoded. The
backup actor speaks only GitHub (`apps/gateway/src/backup.rs`), attachment
replication speaks only Dropbox (`apps/gateway/src/routes/attachments.rs`),
certificate issuance is three providers behind closed `match` arms
(`apps/gateway/src/routes/certs.rs`), identity providers come from four
built-ins plus flat env config, and the cloud-secret-storage catalog rows
(`doppler`, `vault`, …) are `configuration`-mode placeholders the broker
refuses to execute. A user who wants a provider we did not ship has no path
but a patch to this repository.

Meanwhile the connector *contract* has existed since the WIT worlds landed:
`wit/connector/world.wit` gives guests `describe`/`invoke` over opaque
handles, imports exactly `host-http.authorized-request`, purpose-bound
`host-crypto.sign`, and `host-oauth.acquire`, and structurally cannot
express `secrets.get`. `crates/connector-host` has the `Connector` trait,
`HostRuntime`, `HostPolicy` (digest pinning, egress allowlist, SSRF fence),
and a stubbed `wasm_guest` module; `wasmtime = "33.0.0"` is pinned and
unused; `connectors/mock/connector.yaml` specifies a manifest nobody
parses; and `apps/gateway/src/routes/intents.rs` carries the literal
comment "When per-provider components land, this becomes the lookup."

The ecosystem research (linked above) surveyed nine hook ecosystems and
their incident record. The short version: in-process hooks with ambient
authority produce vulnerabilities proportional to ecosystem size forever
(WordPress: 91% of 11k+ annual vulns are plugins); config-files-as-code get
executed before trust (CVE-2025-59536); consent bound to a mutable name
gets rug-pulled (MCP, VS Code); and the systems that stayed safe share four
properties — zero ambient authority, broker-mediated I/O, digest-pinned
consent, and platform-fixed failure policy. Shopify Functions (no I/O,
deterministic, fuel-metered, fresh memory per run) is the production proof
that community code on a hot path can be safe.

This ADR decides how OpenSesame opens its brokered capabilities to
community connectors without opening a secret-exposure surface.

## Decision

### 1. Six capability families, one connector architecture

The brokered capabilities are organized as six **capability families**:
brokered-encryption backup/file storage, cloud secret storage, password
managers, local storage, identity, and certificates. Certificates becomes a
real category: `ProviderCategory::Certificate`
(`crates/domain/src/provider.rs`) and `Category::Certificates`
(`crates/connection-broker/src/catalog.rs`), with `letsencrypt`, `zerossl`,
and `cloudflare-origin-ca` recategorized out of `developer`. The Pages
capability registry (`apps/pages/src/lib/capabilities.ts`) lists all six
families. Gate: `cargo test -p opensesame-connection-broker` catalog tests
plus the Pages vitest suites; TypeScript `satisfies Record<…>` forces every
category site.

### 2. Extension tiers, in preference order

A community extension enters at the lowest tier that can express it:

- **Tier 1 — descriptors.** Inert data files the platform executes:
  identity provider descriptors, attachment-upload request shapes,
  certificate-issuer rows, catalog entries. No code.
- **Tier 2 — catalog-driven constrained HTTP.** Declared operations +
  egress, executed by `ConnectionBroker` with host-injected credentials.
  Already shipping (custom providers, ADR 0032/0055).
- **Tier 3 — Wasm components** under the rules of §3, for logic data
  cannot express.
- **Tier X — never pluggable**: raw credential receipt or return,
  private-CA key custody, trust-class assignment, identity token-exchange
  code, password-manager plaintext reads, arbitrary subprocess execution,
  authorization *grants* (community hooks deny or annotate, never allow —
  ADR 0046 §11's never-self-widening rule), independent network egress,
  and free-text injection into an agent's context.

### 3. The Wasm runtime: Shopify-Functions posture, default off

`crates/connector-host` gains a real component runtime behind a cargo
feature `wasm-connectors`, **default off**, with `apps/gateway` exposing a
pass-through feature. Rules, each load-bearing:

- Guests are components of the `opensesame:connector/connector@1.0.0`
  world. The linker binds exactly `host-http`, `host-crypto`, `host-oauth`
  — no WASI, no filesystem, no clock, no randomness, no ambient anything.
  A component importing anything else fails instantiation.
- **Fresh `Store` per invocation** — empty linear memory every run; no
  cross-invocation state.
- **Fuel metering + epoch deadline + memory cap + result-size cap**, all
  platform-set; the manifest cannot raise them.
- **Digest-pinned consent**: the component's sha256 must equal the manifest
  digest *and* appear in `HostPolicy::trusted_digests` (operator
  configuration). Verified at load and before every instantiation. A
  changed component is a different component.
- **Egress by intersection**: the host-http import re-checks every request
  against `HostPolicy` egress ∩ the manifest's `outbound.hosts`, through
  the existing `assert_destination_allowed`/`is_blocked_host` fence, then
  delegates to `ConnectionBroker` — the single credential-injection funnel.
  Credentials are injected host-side; response bodies are size-capped;
  redirects are responses, never chases.
- **Fail closed**: feature off, digest missing, manifest invalid, import
  set unexpected, fuel exhausted, deadline passed — every one is a typed
  refusal, never a fallback.

Gates: `scripts/daemon-deps-gate.sh` bans `wasmtime`/`cranelift-codegen`
from every daemon-adjacent tree (the runtime is a gateway concern;
ADR 0048 §5 stands); `scripts/battle-test.sh` runs the feature-gated test
suite; the connector-sdk WIT structural tests continue to refuse
`secrets.get`.

### 4. Manifests are inert, strictly-parsed data

`connectors/<id>/connector.yaml` (`apiVersion: opensesame.dev/v1alpha1`,
`kind: ConnectorDefinition`) is parsed by
`crates/connector-host/src/manifest.rs`: `deny_unknown_fields` on every
struct, digest syntax enforced (`sha256:` + 64 hex), `outbound.hosts`
exact-host and refused by the SSRF fence, closed enums for auth modes and
risk levels, and — structurally — no field capable of carrying credential
material (a unit test asserts the schema's field-name set against the
secret-shaped denylist, mirroring `assert_wit_forbids_secrets_get`).
Parsing a manifest never causes execution; registration happens only via
`HostRuntime` under §3's digest rules. Gate:
`fuzz/fuzz_targets/connector_yaml.rs` (repo rule: a fuzz target per
parser) plus the manifest rejection-table unit tests.

### 5. Provider→connector binding replaces the hardcoded lookup

`HostRuntime` maps `provider_id → connector_id` (`bind_provider`);
`apps/gateway/src/routes/intents.rs`'s `component_for_provider()` is
deleted in favor of the runtime lookup, preserving today's mock fallback
byte-for-byte when nothing is registered. Boot-time loading
(`with_manifest_dir`) scans an operator-configured directory
(`OPENSESAME_CONNECTOR_DIR`), and refuses boot on any invalid manifest,
unpinned digest (`OPENSESAME_CONNECTOR_TRUSTED_DIGESTS`), or load failure.
Gate: gateway route tests assert unknown providers still fail closed.

### 6. Per-family secret-exposure rules

- **Backup / file storage — ciphertext only.** Snapshot and attachment
  payloads are sealed before they reach any target
  (`attach_replication_units` exports ciphertext; the gateway holds no
  store key). Targets become pluggable behind a `SnapshotTarget` trait
  (`kind = github_app | connector`), the connector kind delivering via
  `ConnectionBroker::authorized_bytes`. Attachment upload shapes move into
  the catalog as Tier 1 descriptors whose URL host must lie inside the
  provider row's egress — a descriptor can never widen egress. Backup
  target `config` JSON is refused if it contains secret-shaped keys (the
  audit `DENY_KEY` pass, run at the route).
- **Cloud secret storage — credentials host-side.** Connectors see intents
  and digests; the broker injects credentials. Promoting catalog rows off
  `AuthMethod::Configuration` (real auth + egress per provider) is a
  prerequisite recorded in §8, not silently implied.
- **Certificates — trust semantics are platform-owned.** Issuer rows are
  Tier 1 descriptors in a registry
  (`apps/gateway/src/cert_issuers/registry.rs`); DNS-01 provisioners may be
  brokered catalog operations (`BrokeredDns01` over `authorized_json`). But
  `IssuerKind`, its `trust()` mapping to `TrustClass`, and private-CA key
  custody (`certificate_authorities.sealed_*`) never come from a manifest:
  a community connector may propose an issuer row; trust classification is
  assigned in platform code review (ADR 0052-cert's rule that trust
  semantics never change without consent stands).
- **Identity — descriptors, never code.** Community identity providers are
  descriptor files validated by the existing `assertProviderDescriptor`,
  appended to the static set; inline `clientSecret` is refused — files
  carry `clientSecretEnv` references resolved from the environment.
  `resolveTrustedIssuer` (the single trust fence, ADR 0055) is not
  modified: manifest descriptors join the "static" source, so the
  static → BYO → org order is preserved by construction. Token-exchange
  code stays platform-owned (ADR 0055 §3).
- **Password managers — the plane split is permanent.** ADR 0052 stands:
  plaintext reads are human-plane, never agent-facing, never in a guest.
  The community path splits in two: (a) an agent-safe metadata connector
  (list/`find_by_url`-shaped operations, no reveal) may ride the WIT world;
  (b) plaintext-handling adapters remain native bridge processes under
  ADR 0053's default-off feature-per-surface rules. Op names
  `pm.list`/`pm.find-by-url` are reserved for (a). Client-side, the Pages
  `ImportAdapter` (`apps/pages/src/lib/vault/import/types.ts`) is the
  supported community surface for PM imports — plaintext stays in the
  user's browser vault.
- **Local storage — pluggable only below the confinement funnel.** A
  future `ObjectStore` trait may exist only *under*
  `crates/sealed-store/src/path.rs`'s `confined_read`/`confined_write`/
  `confined_remove` (ciphertext-only by construction), never at the
  `StoreRoot` level where plaintext lives. `TombBackend`
  (`tomb_registry.rs`) is the enum a third backend extends.

### 7. Dispatcher enforces; hooks cannot forget

Authorization, egress, budgets, redaction, and audit all run in the
platform before or around the connector — never inside it. Every
registration, binding, and invocation lands in the hash-chained audit trail
with digest-shaped metadata only. Failure policy is fixed by the platform
per path: gating paths fail closed; observer paths are async,
outbox-delivered, and unable to influence decisions. A connector author
never chooses which they are.

### 8. Roadmap — deliberately not in this change

Recorded so their absence is a decision, not an oversight: OCI component
pulling and sigstore signature verification (`signaturesRequired` currently
means "digest must be operator-pinned"); promoting `doppler`/`vault`/etc.
off `AuthMethod::Configuration` (needs per-provider egress and credential
UX review); the PM metadata connector of §6; the local-storage
`ObjectStore`; additional `BrokeredDns01` provider rows (route53 first);
a DB-backed identity descriptor registry (file + env only for now); and a
`backup.commit` connector operation superseding the Tier 2 snapshot
target.

## Consequences

- A missing provider becomes something a user can add: as a descriptor or
  catalog row today, as a sandboxed component where logic is required —
  without any path to raw secrets, because the seams chosen are ciphertext-
  or metadata-only and credentials are injected host-side.
- `pnpm verify`'s full-feature Clippy pass now compiles wasmtime/cranelift
  (minutes added). Accepted: the gate design intentionally builds every
  feature.
- The gateway grows the only Wasm surface; the daemon provably gains
  nothing (`pnpm audit:daemon-deps` stays green and now also bans
  wasmtime).
- Trust decisions concentrate where they are reviewable: digests in
  operator config, issuer rows and trust classes in platform code,
  descriptors in diffable files. Rug-pulls require changing a pinned
  digest; name-squatting buys nothing.
- The closed `ExternalIdentityKind` union, `IssuerKind`, and the PM plane
  split remain hard fences; loosening any of them requires a new ADR, not
  a manifest.
