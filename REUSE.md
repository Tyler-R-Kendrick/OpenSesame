# REUSE — OpenSesame

Product license: **MIT** (see `LICENSE`).

## Adopted foundations

| Capability | Choice | Version / pin | License stance | Reason |
|------------|--------|---------------|----------------|--------|
| Agent-facing authority | **ConnectionRef + Intent** (not SecretRef) | ADR 0005 | n/a | Reference ≠ capability; SUDP-aligned custodian |
| SecretRef | Internal under connection broker only | ADR 0005 | n/a | Compatibility; never default agent API |
| Language (control plane) | Rust 2021 / toolchain 1.88 | `rust-toolchain.toml` | MIT/Apache deps via `deny.toml` | Security-sensitive daemon defaults |
| HTTP | Axum + Tower + Tokio + rustls | workspace Cargo.toml | Apache-2.0/MIT | Mature, audited ecosystem |
| DB (prod) | PostgreSQL + SQLx | SQLx 0.8.x | Apache-2.0/MIT | HA via CloudNativePG/Patroni |
| DB (local) | SQLite behind same traits | SQLx sqlite | public domain/blessing | Dev/test only; not HA |
| AuthZ relationships | OpenFGA | model in `policy/openfga` | Apache-2.0 | Relationship engine; AuthZEN adapter owned by us |
| Policy API | AuthZEN 1.0 | adapter in `crates/authz` | spec | Stable external contract |
| Authority | OpenBao as provider | provider crate | MPL-2.0 | Dynamic secrets/PKI/SSH/transit |
| Bundled IdP | Keycloak | Compose profile | Apache-2.0 | OIDC/SAML/LDAP/passkeys/device flow |
| Workload ID | SPIFFE/SPIRE | provider | Apache-2.0 | Secretless preferred |
| WASM | Wasmtime Component Model | WIT in `wit/` | Apache-2.0 | No secrets.get; authorized-http/sign |
| Developer config contract | **`@env-spec` / `.env.schema`** via `@env-spec/parser` | pin in `packages/env-spec-bridge` | MIT | Schema/value separation; anti-NIH |
| Prior art (study) | SUDP arXiv:2604.24920 | research | — | Custodian execution; not a wire protocol fork |
| Prior art (peer) | Varlock credential proxy / sandbox | docs | MIT | Placeholder+placement; do not fork MITM as primary |

## Evaluated / adapter-only

| Project | Stance |
|---------|--------|
| Varlock `run` / `proxy` | Compatibility peer; OpenSesame is authority broker underneath |
| Official `@varlock/*` OpenSesame plugin | Path A — deferred until third-party plugins allowed |
| 1Password `op://` SecretRef | Late-binding prior art — insufficient (materializes into process) |
| OpenClaw / agentgateway OAuth exchange | Gateway-injection prior art |
| Boundary / CyberArk Secretless | Credential injection prior art |
| Nango / Bitwarden / Vaultwarden / Infisical | Study only; no incompatible source copy |

## Rejected

| Idea | Why |
|------|-----|
| Agent-facing SecretRef protocol | Narrow; implies extractable secret |
| Generic string-replacing egress gateway | Prompt-injection exfiltration |
| `secrets.get` guest import | Moves secret into WASM |
| Competing SUDP wire protocol in v0.1 | Implement properties first |

## License policy

CI must run `cargo deny check`. Notices in `NOTICE`.
