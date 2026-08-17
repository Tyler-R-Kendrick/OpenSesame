# Tomb — craft bar (volume encryption ideas)

> Competitive / ecosystem reference for OpenSesame multi-tomb sealed stores
> ([spec](../superpowers/specs/2026-08-16-tombs-pass-otp-update-design.md)).

**Stance: adjacent / inspiration** — not a Host plane competitor. Linux
[Tomb](https://dyne.org/tomb/) (dm-crypt/LUKS) motivates **key/volume
separation**, open/close lifecycle, and multiple distributed ciphertext
roots. OpenSesame ships a **portable** multi-tomb registry first; optional
`tomb` binary adapter when present.

## Mapping

| Tomb / pass-tomb | OpenSesame |
|------------------|------------|
| `.tomb` volume + key file | Registry entry: `store` + `key` (+ optional `volume`) |
| `tomb open` / `close` | `opensesame pass open` / `close` |
| `~/.password-store` inside tomb | Active tomb’s sealed-store root |
| pass-tomb | `opensesame pass tomb …` registry |

Agents never reveal tomb contents (ADR 0005).
