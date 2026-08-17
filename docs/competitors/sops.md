# SOPS — adjacent (encrypted config in git)

> Competitive reference for **encrypting structured config files in git**
> (YAML/JSON/env). Adjacent to OpenSesame’s sealed-store tree and age-backed
> ciphertext — different unit of storage (files vs hierarchical secret paths).

**Stance: adjacent / prior art** for git-ops secret files. Operators often
compare “SOPS + age/KMS” vs `pass` / OpenSesame sealed store.

## Overview

[SOPS](https://github.com/getsops/sops) (Secrets OPerationS) encrypts values
inside structured documents while leaving keys readable. Backends include age,
PGP, AWS KMS, GCP KMS, Azure Key Vault, and HashiCorp Vault. Popular in
Kubernetes/GitOps (encrypted manifests in repo; decrypt at apply time).

| Dimension | SOPS |
|-----------|------|
| Category | File-oriented secrets encryption for git |
| Trust model | Recipients / KMS keys listed in file metadata |
| Sync | Git of partially encrypted documents |
| Agent story | Decrypt into CI/agent filesystem — still reveal risk |
| License | MPL-2.0 |

## Feature surface

- Encrypt/decrypt YAML, JSON, ENV, INI, binary.
- Per-value encryption; key names stay clear for diffs/reviews.
- `.sops.yaml` creation rules for path → key mapping.
- CLI `sops` edit / rotate; editor integration.
- Native age and cloud KMS backends.

## Differentiators (why operators still pick SOPS)

- GitOps-native: encrypted manifests reviewable as YAML with clear keys.
- Battle-tested in Kubernetes secret pipelines.
- Multi-recipient / multi-KMS without a password-store tree shape.

## Differentiators (why OpenSesame sealed store differs)

- Hierarchical **secret paths** (`Folder/name`) and `opensesame pass` verbs —
  `pass`-shaped, not document-shaped.
- Human Pages vault + agent ConnectionRef product, not only decrypt-at-apply.
- Capability connectors bind encryption KMS and git history as product settings.

## OpenSesame mapping

| SOPS concept | OpenSesame |
|--------------|------------|
| Encrypted YAML values | Sealed-store path files (`.osseal` / `.age` / `.gpg`) |
| age / KMS recipients | Encryption capability connectors + sealed-store recipients |
| `sops decrypt` in CI | Rejected as agent API — ConnectionRef invoke |
| GitOps file review | Optional — store git history via history capability (GitHub default) |

Related: [age.md](age.md), [pass.md](pass.md),
[ADR 0037](../adr/0037-git-sealed-store.md).
