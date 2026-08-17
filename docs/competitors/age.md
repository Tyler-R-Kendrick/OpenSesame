# age — primitive / prior art (encryption)

> Competitive reference for the **age encryption tool and format** used across
> SOPS, fnox, password-store forks, and OpenSesame sealed-store interop.

**Stance: primitive / prior art** — not a product competitor. age is a building
block OpenSesame reads/writes (`.age`) and offers as an encryption capability
connector option.

## Overview

[age](https://age-encryption.org/) is a simple, modern file encryption tool
(Go reference `age` / `rage` Rust impl). Recipients are age or SSH keys; small
header + ciphertext stream. Designed to replace ad-hoc GPG for “encrypt this
file to these people” without the OpenPGP web of trust.

| Dimension | age |
|-----------|-----|
| Category | File/stream encryption format + CLI |
| Trust model | Recipient public keys (age1… or SSH) |
| Sync | None — ciphertext moves via git/USB/etc. |
| Agent story | None — decrypt reveals plaintext to caller |
| License | BSD-style (reference implementations) |

## Feature surface

- `age -r` / `age -d` encrypt/decrypt; armor optional.
- Native SSH recipient support (common DX win).
- Plugin ecosystem (e.g. YubiKey, cloud KMS plugins in community).
- Library embeddings in SOPS, fnox, and many secret tools.

## Differentiators (why operators still pick raw age)

- Tiny, auditable, no daemon.
- SSH-key recipients — zero new key ceremony for many developers.
- De facto format for “encrypted blob in git.”

## Differentiators (why OpenSesame wraps rather than stops at age)

- Product needs vault UI, Host connectors, and agent-safe authority.
- Sealed store may prefer `.osseal` while still reading classic `.age`.
- Encryption **capability** can select WebCrypto, age, YubiKey, cloud KMS —
  age is one connector, not the whole product.

## OpenSesame mapping

| age concept | OpenSesame |
|-------------|------------|
| Recipient | Sealed-store / capability encryption recipient |
| `.age` file | Classic sealed-store ciphertext (interop) |
| `age` CLI | Optional; Host/Pages must not require it for core paths |
| Catalog | Provider / capability option `age` |

Related: [sops.md](sops.md), [fnox.md](fnox.md),
[ADR 0037](../adr/0037-git-sealed-store.md), Pages capability connectors
(encryption).
