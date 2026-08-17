# HashiCorp Vault — provider / prior art

> Competitive reference for **dynamic secrets, transit, and PKI** backends.
> OpenSesame adopts **OpenBao** as the preferred open provider
> ([REUSE.md](../../REUSE.md)); Vault remains the industry prior art operators
> compare against.

**Stance: provider / prior art** — not a head-on product clone. Host may talk
to Vault/OpenBao-shaped backends; OpenSesame itself is the authorization fabric
in front of agents.

## Overview

[HashiCorp Vault](https://www.vaultproject.io/) (and community fork
[OpenBao](https://openbao.org/)) is the classic secrets engine: KV stores,
dynamic database/cloud credentials, transit encryption, PKI, SSH OTP, identity
methods, and policies. Enterprises run Vault as the system of record for
machine secrets and crypto services.

| Dimension | Vault / OpenBao |
|-----------|-----------------|
| Category | Secrets engine / crypto services |
| Trust model | Unseal keys, policies, auth methods |
| Sync | Cluster HA; many auth and secrets engines |
| Agent story | Vault Agent / Agent Injector; still often reveals to sidecar |
| License | BSL (Vault); OpenBao MPL-2.0 (preferred reuse) |

## Feature surface

- Auth methods (AppRole, JWT/OIDC, Kubernetes, cloud IAM, …).
- Secrets engines: KV v2, databases, cloud IAM, PKI, transit, SSH.
- Policies (HCL/ACL), namespaces (Enterprise), audit devices.
- Vault Agent / templates for injection into workloads.
- CLI `vault` / HTTP API; Terraform providers.

## Differentiators (why operators still pick Vault)

- Deepest dynamic-secrets and transit feature set in the industry.
- Existing enterprise ops muscle memory and compliance stories.
- OpenBao preserves an open-source path for the same mental model.

## Differentiators (why OpenSesame is not “another Vault”)

- Product topology is Host + Identity + client planes, not a secrets engine UI.
- Agent contract is ConnectionRef (capability), not lease-and-read secret paths.
- Human ceremony store and git sealed store sit beside authority — Vault is
  machine-first.

## OpenSesame mapping

| Vault concept | OpenSesame |
|---------------|------------|
| KV / dynamic secret | Provider-backed connection; OpenBao preferred |
| Transit / encrypt | Encryption capability connectors (WebCrypto, KMS, …) |
| Policy / ACL | AuthZEN / OpenFGA + connection grants |
| Vault Agent inject | Rejected as primary agent API — no secret dump |
| Catalog | Providers `vault`, `openbao` |

Related: [REUSE.md](../../REUSE.md) Authority row, provider crates
`opensesame-provider-openbao`.
