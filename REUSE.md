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
| Nango / Bitwarden / Vaultwarden / Infisical | Study only; no incompatible source copy — see [docs/competitors](docs/competitors/index.md) |
| KeePass / KeePassXC | **Study-only clean-room** (GPL). KDBX and keepassxc-protocol implemented from their public specs — see [docs/competitors/keepass.md](docs/competitors/keepass.md), [ADR 0052](docs/adr/0052-password-manager-ecosystem-bridging.md) §3 |
| Passbolt | **Study-only clean-room** (AGPL-3.0). API implemented from public docs/OpenAPI; KDBX export ingests today — see [docs/competitors/passbolt.md](docs/competitors/passbolt.md) |
| 1Password (clients / server / Connect) | Proprietary — serving its clients is impossible and not attempted; consume via `op` CLI, Connect REST (ops plane), and `.1pux` import — see [docs/competitors/1password.md](docs/competitors/1password.md) |
| `keepass` crate (Rust KDBX) | **Permissive dependency allowed** (MIT), pinned. Upstream KDBX4 *write* is experimental → writer constrained to KDBX 4.0 / AES-256 or ChaCha20 / Argon2id + cross-implementation conformance fixture |
| kdbxweb + hash-wasm (Pages KDBX) | **Permissive dependencies allowed** (MIT). hash-wasm supplies Argon2 to kdbxweb via `CryptoEngine.setArgon2Impl`; both lazily imported |
| `crypto_box` (RustCrypto NaCl box) | **Permissive dependency allowed** (MIT OR Apache-2.0) — keepassxc-protocol transport crypto, in `apps/pm-bridges` only |
| rpgp | **Permissive dependency allowed** (MIT OR Apache-2.0) — OpenPGP for the Passbolt consume-client |
| oo7 (Secret Service) | **MIT — fork/derive or depend, with `NOTICE` attribution** |
| rbw (Rust Bitwarden client) | **MIT — fork/derive with `NOTICE` attribution.** In maintenance mode: use as verified protocol knowledge, do **not** take it as a dependency |
| browserpass-native | **ISC — reference only.** Reimplement the JSON stdio protocol; do not vendor |
| FIDO CXF / CXP | Open specification (CXF Proposed Standard, Aug 2025). CXF import+export implemented; CXP/HPKE transport is roadmap ([ADR 0052](docs/adr/0052-password-manager-ecosystem-bridging.md) §4) |
| Doppler / fnox / SOPS / age | Adjacent or primitive — see [docs/competitors](docs/competitors/index.md) |
| Doppler sync / projects parity | Capability parity under ConnectionRef (ADR 0041); catalog provider `doppler` is SaaS connector only — not a clone |
| Vercel Connect / Oomol Open Connector | Adjacent connector gateways — see [docs/competitors](docs/competitors/index.md) |
| HashiCorp Vault | Prior art; prefer OpenBao provider — [docs/competitors/hashicorp-vault.md](docs/competitors/hashicorp-vault.md) |
| Unix `pass` (password-store) | **Direct competitor** for CLI git-sealed secrets — see [docs/competitors/pass.md](docs/competitors/pass.md) |

## Rejected

| Idea | Why |
|------|-----|
| Agent-facing SecretRef protocol | Narrow; implies extractable secret |
| Generic string-replacing egress gateway | Prompt-injection exfiltration |
| `secrets.get` guest import | Moves secret into WASM |
| Competing SUDP wire protocol in v0.1 | Implement properties first |

## License policy

CI must run `cargo deny check`. Notices in `NOTICE`.

Implementing a protocol or file format from its **public specification** is
not a derivative work of any implementation of it; copying source is. That
distinction is what makes the password-manager bridging work in
[ADR 0052](docs/adr/0052-password-manager-ecosystem-bridging.md) legal
against ecosystems whose reference implementations are GPL/AGPL
(vaultwarden AGPL-3.0, Bitwarden clients GPL-3.0, KeePassXC GPL, Passbolt
AGPL-3.0). Enforcement is mechanical on the Rust side: `deny.toml`'s
`[licenses].allow` is permissive-only (MIT, Apache-2.0, BSD-2/3-Clause,
ISC, MPL-2.0, Unicode, Zlib, CC0-1.0, OpenSSL, CDLA-Permissive-2.0) and
lists **no GPL or AGPL**, so a contaminating dependency fails
`cargo deny check` before it reaches review. The residual risk is a human
pasting source, which is why the study-only rows above are explicit.

Bitwarden's 2024 SDK licensing episode — `sdk-internal` made proprietary
under a field-of-use clause aimed at vaultwarden-class projects, resolved
that November by splitting into GPL-3.0 `sdk-internal` and
Bitwarden-License `sdk-secrets` — is why Bitwarden compatibility is one
adapter among several here and never the foundation of a strategy.
