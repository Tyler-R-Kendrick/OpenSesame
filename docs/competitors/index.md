# Competitors

Competitive references for OpenSesame. These capture **adjacent and head-on
products** that operators already compare us to, so product, CLI, sealed-store,
and connector decisions stay honest about parity and deliberate gaps.

| Competitor | Stance | What it is | Doc |
|------------|--------|------------|-----|
| **`pass` (password-store)** | **Direct** — human CLI sealed store | Unix GPG/`~/.password-store` CLI; hierarchical encrypted secrets in git | [`pass.md`](pass.md) |
| Tomb | Adjacent / inspiration | Linux dm-crypt volume + key separation; motivates multi-tomb registry | [`tomb.md`](tomb.md) |
| Infisical | Craft bar (agents) | Agent/secret delivery (`infisical run`, Agent Proxy) | [`infisical.md`](infisical.md) |
| Bitwarden | Study / client-bridge target ([ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md)) + craft bar (human UI habits) | Password-manager UX (+ Secrets Manager SKU); consume-client built, server compat roadmap-only; never brand marks | [`bitwarden.md`](bitwarden.md) |
| KeePass / KeePassXC | Study / client-bridge target ([ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md)) | Offline KDBX database + keepassxc-protocol browser integration; format and protocol implemented from public specs | [`keepass.md`](keepass.md) |
| Passbolt | Study / consume target ([ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md)) | Self-hosted team PM on per-user OpenPGP; KDBX export ingests today, native client is a stretch | [`passbolt.md`](passbolt.md) |
| 1Password | Craft bar (human UI habits) / consume target | `op` CLI, service accounts, `op://` refs, Connect REST, `.1pux`; CXF co-author. Serving its clients is impossible (proprietary) | [`1password.md`](1password.md) |
| Doppler | Adjacent / craft bar | Cloud secrets platform + env injection CLI; capability parity via Host projects / SyncTarget / changelog — not a clone; catalog `doppler` ≠ this feature set | [`doppler.md`](doppler.md) |
| HashiCorp Vault / OpenBao | Provider / prior art | Dynamic secrets, transit, PKI | [`hashicorp-vault.md`](hashicorp-vault.md) |
| fnox | Peer / compatibility | Multi-provider secrets CLI; Host catalog Fnox parity | [`fnox.md`](fnox.md) |
| SOPS | Adjacent | Encrypted structured config in git (GitOps) | [`sops.md`](sops.md) |
| age | Primitive / prior art | Modern file encryption format used by SOPS/fnox/sealed-store | [`age.md`](age.md) |
| Vercel Connect | Adjacent / borrow-source | Short-lived connector tokens for apps/agents on Vercel | [`vercel-connect.md`](vercel-connect.md) |
| Oomol Open Connector | Adjacent | OSS agent SaaS gateway (Actions + MCP; credentials stay behind gateway) | [`oomol-open-connector.md`](oomol-open-connector.md) |
| Nango | Study | Embedded OAuth/API integrations + Functions/MCP | [`nango.md`](nango.md) |
| Border0 + Tailscale (Tailscale PAM) | **Craft bar (Access screen)** — design parity target ([ADR 0054](../adr/0054-access-screen-pam.md)) | Privileged access management: sockets/services, policies, sessions + recordings, JIT approval flows, ZSP | [`border0-tailscale-pam.md`](border0-tailscale-pam.md) |
| Tailscale — Identity | **Craft bar (Identity screen)** — design parity target ([ADR 0060](../adr/0060-identity-screen-idp-brokering.md)) | IdP-bound tailnet: mandatory IdP signup ceremony, users/roles/states, service identities, groups, SCIM | [`tailscale-identity.md`](tailscale-identity.md) |
| Vaultwarden | Study / client-bridge prior art ([ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md)) | Self-hosted Bitwarden-compatible server; AGPL-3.0, clean-room study only | — (see [REUSE.md](../../REUSE.md), [bitwarden.md](bitwarden.md)) |
| Varlock | Peer / compatibility | `.env.schema` + credential proxy | — (see [REUSE.md](../../REUSE.md)) |
| Apple Passwords | Prior art ([ADR 0076](../adr/0076-autonomous-web-login-rotation.md)) / craft bar (deterministic tiers) | `/.well-known/change-password` + curated quirks corpus; deep-links the human, never rotates autonomously | [`apple-passwords.md`](apple-passwords.md) |

**Direct** means operators choosing a git-native CLI secret store will evaluate
OpenSesame’s sealed-store verbs against that product on the same machine.
**Craft bar** means we match habits or agent workflows without cloning brand or
becoming that product category.
**Provider / prior art** means we integrate or study the engine; we are not
rebuilding it as the product.
**Adjacent** means overlapping connector/secrets/git-ops surface without being
the same category.
**Client-bridge target** means we implement their file format or local
protocol from its **public specification** so their clients and stores keep
working — never by copying their source, which is GPL/AGPL and study-only
([ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md) §3,
[REUSE.md](../../REUSE.md)). Serving another vendor's clients is only ever
done on the human/device/ops plane under ADR 0052 §2; the agent plane still
has no `getSecret()`.
**Consume target** means their store can be plugged in as a brokered upstream
behind ConnectionRef + Intent, not that we reimplement their server.

Pattern for new entries: add `docs/competitors/<slug>.md` with overview →
feature surface → differentiators → OpenSesame mapping, then link it from this
table.

### Platform foundations (not a competitor page)

NATS JetStream is OpenSesame’s greenfield TaskBus (ADR 0002 / ADR 0042), not a
secrets-platform peer. Architecture:
[`docs/architecture/task-bus-nats.md`](../architecture/task-bus-nats.md).
Doppler’s sync/changelog habits map to Host SyncTarget + durable audit
([ADR 0041](../adr/0041-projects-sync-targets-and-secret-changelog.md)); do not
invent a fake “NATS competitor” row.

## Sources and fair use

Third-party reference captures for competitive analysis. Upstream docs and
repos remain the property of their owners. Excerpts are limited to factual CLI
and on-disk surface needed for comparison. See [REUSE.md](../../REUSE.md) for
license stance on studied projects.
