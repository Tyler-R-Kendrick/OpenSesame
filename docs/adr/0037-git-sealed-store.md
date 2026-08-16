# ADR 0037: Git-native sealed store (`pass` parity)

## Status

Accepted

## Context

Operators want Unix `pass`-style workflows: hierarchical encrypted secrets in a
git repository, CLI CRUD, and interoperability with classic
`~/.password-store`. OpenSesame already has a Pages OPFS vault and a Host
ConnectionRef model (ADR 0005) that must never grow a public `getSecret()` for
agents. The Host CLI previously shelled out to the external `pass` binary for
`password-store` connections.

## Decision

1. Ship a native Rust crate `opensesame-sealed-store` that owns path CRUD, git
   auto-commit, and ciphertext formats (`.osseal`, `.gpg`, `.age`).
2. Reuse `opensesame-human-vault` AEAD primitives for `.osseal` content
   encryption; wrap a store VRK under a passphrase in `.opensesame-key`.
3. Expose human store verbs on the `opensesame` binary without a `pass`
   subcommand: `init --sealed-store`, `insert`, `generate`, `show`, `ls`,
   `find`, `cp`, `mv`, `rm`, `git`.
4. Resolve the store root as `OPENSESAME_STORE_DIR` → `PASSWORD_STORE_DIR` →
   `~/.password-store`.
5. Replace connector-host shell-out to `pass` with in-process sealed-store
   plans (`HumanProviderPlan::SealedStore`). Human `secret get/list` may unlock
   via `OPENSESAME_STORE_PASSWORD`; agent/MCP surfaces do not gain reveal tools.
6. Pages bridges vault items ↔ store paths through a Settings manifest
   import/export (`store-sync.ts`). Agents continue to bind store-backed
   connections through ConnectionRef → authorize → invoke → receipt only.

## Consequences

- Classic `password-store` trees remain readable; OpenSesame no longer depends
  on the `pass` binary.
- New OpenSesame writes prefer `.osseal` when OpenSesame recipients/key files
  are present.
- Operators can commit ciphertext to source control; plaintext manifests from
  Pages must not be committed.
- ADR 0005 invariants are preserved: no agent `getSecret()` / `show`.
