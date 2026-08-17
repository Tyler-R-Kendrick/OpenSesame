# Competitors

Competitive references for OpenSesame. These capture **adjacent and head-on
products** that operators already compare us to, so product, CLI, sealed-store,
and connector decisions stay honest about parity and deliberate gaps.

| Competitor | Stance | What it is | Doc |
|------------|--------|------------|-----|
| **`pass` (password-store)** | **Direct** — human CLI sealed store | Unix GPG/`~/.password-store` CLI; hierarchical encrypted secrets in git | [`pass.md`](pass.md) |
| Tomb | Adjacent / inspiration | Linux dm-crypt volume + key separation; motivates multi-tomb registry | [`tomb.md`](tomb.md) |
| Infisical | Craft bar (agents) | Agent/secret delivery (`infisical run`, Agent Proxy) | [`infisical.md`](infisical.md) |
| Bitwarden | Craft bar (human UI habits) | Password-manager UX (+ Secrets Manager SKU); never brand marks | [`bitwarden.md`](bitwarden.md) |
| Doppler | Adjacent / craft bar | Cloud secrets platform + env injection CLI | [`doppler.md`](doppler.md) |
| HashiCorp Vault / OpenBao | Provider / prior art | Dynamic secrets, transit, PKI | [`hashicorp-vault.md`](hashicorp-vault.md) |
| fnox | Peer / compatibility | Multi-provider secrets CLI; Host catalog Fnox parity | [`fnox.md`](fnox.md) |
| SOPS | Adjacent | Encrypted structured config in git (GitOps) | [`sops.md`](sops.md) |
| age | Primitive / prior art | Modern file encryption format used by SOPS/fnox/sealed-store | [`age.md`](age.md) |
| Vercel Connect | Adjacent / borrow-source | Short-lived connector tokens for apps/agents on Vercel | [`vercel-connect.md`](vercel-connect.md) |
| Oomol Open Connector | Adjacent | OSS agent SaaS gateway (Actions + MCP; credentials stay behind gateway) | [`oomol-open-connector.md`](oomol-open-connector.md) |
| Nango | Study | Embedded OAuth/API integrations + Functions/MCP | [`nango.md`](nango.md) |
| Vaultwarden | Study | Self-hosted Bitwarden-compatible server | — (see [REUSE.md](../../REUSE.md), [bitwarden.md](bitwarden.md)) |
| Varlock | Peer / compatibility | `.env.schema` + credential proxy | — (see [REUSE.md](../../REUSE.md)) |

**Direct** means operators choosing a git-native CLI secret store will evaluate
OpenSesame’s sealed-store verbs against that product on the same machine.
**Craft bar** means we match habits or agent workflows without cloning brand or
becoming that product category.
**Provider / prior art** means we integrate or study the engine; we are not
rebuilding it as the product.
**Adjacent** means overlapping connector/secrets/git-ops surface without being
the same category.

Pattern for new entries: add `docs/competitors/<slug>.md` with overview →
feature surface → differentiators → OpenSesame mapping, then link it from this
table.

## Sources and fair use

Third-party reference captures for competitive analysis. Upstream docs and
repos remain the property of their owners. Excerpts are limited to factual CLI
and on-disk surface needed for comparison. See [REUSE.md](../../REUSE.md) for
license stance on studied projects.
