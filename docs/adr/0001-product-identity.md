# ADR 0001: Product identity and naming

## Status
Accepted

## Context
Greenfield repository named OpenSesame under MIT. Implementation prompt uses vault/Vault Fabric/vaultd placeholders.

## Decision
- Product name: **OpenSesame**
- CLI: `opensesame`
- WIT package prefix: `opensesame:`
- Env vars: `OPENSESAME_*`
- Do not rename to Vault Fabric

## Consequences
Docs and APIs use OpenSesame branding. Prompt placeholders are mapped, not copied.
