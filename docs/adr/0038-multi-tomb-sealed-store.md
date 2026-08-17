# ADR 0038: Multi-tomb sealed-store roots

## Status

Accepted

## Context

ADR 0037 defined a single store root resolution chain
(`OPENSESAME_STORE_DIR` → `PASSWORD_STORE_DIR` → `~/.password-store`). Operators
also want Tomb-like separation of ciphertext and key material, and multiple
named stores in different locations ([Tomb](https://dyne.org/tomb/),
pass-tomb).

## Decision

1. Add a **tomb registry** (`OPENSESAME_TOMBS_CONFIG` or
   `$XDG_CONFIG_HOME/opensesame/tombs.json`) listing named tombs with `store`,
   `key`, optional `volume`, and `backend` (`portable` | `linux-tomb`).
2. When a tomb is **active** (or `--tomb` is passed), sealed-store CLI verbs
   resolve that tomb’s `store`/`key` instead of the ADR 0037 single-root chain.
3. Explicit `--path` still wins for one-off ops.
4. Linux Tomb open/close is optional and never uses `sudo` from OpenSesame.
5. ADR 0005 unchanged: no agent reveal.

## Consequences

- Multiple distributed sealed stores are first-class.
- Single-root workflows remain: empty registry falls back to ADR 0037.
- PRODUCT and `opensesame pass tomb|open|close` document the new verbs.

## Related

- [ADR 0037](0037-git-sealed-store.md)
- [Design](../superpowers/specs/2026-08-16-tombs-pass-otp-update-design.md)
