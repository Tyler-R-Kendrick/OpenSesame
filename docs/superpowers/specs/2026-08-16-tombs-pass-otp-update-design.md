# Tombs, pass-otp, and pass-update

**Date:** 2026-08-16  
**Status:** Approved  
**Scope:** Multi-tomb sealed-store registry (portable + optional Linux Tomb),
`opensesame pass otp` (pass-otp parity), `opensesame pass update` + Pages vault
update actions; ADR 0005 / 0037 preserved

## Problem

Operators comparing OpenSesame to the Unix `pass` ecosystem expect three
extension-shaped capabilities we lack or only partially cover:

1. **[Tomb](https://dyne.org/tomb/) / [pass-tomb](https://github.com/roddhjav/pass-tomb)** —
   ciphertext volume separate from key material; open/close lifecycle; multiple
   distributed stores. Today we resolve a **single** store root
   (`OPENSESAME_STORE_DIR` → `PASSWORD_STORE_DIR` → `~/.password-store`) with
   key material co-located (`.opensesame-key`).
2. **[pass-otp](https://github.com/pass-extension/pass-otp)** — OTP tokens in
   Key URI Format (`otpauth://…`), code generation, append/insert/uri/validate.
   Pages vault already computes TOTP for login items; the sealed-store CLI has
   **no** OTP verbs and no trailer round-trip helpers.
3. **[pass-update](https://github.com/roddhjav/pass-update)** — rotate secrets
   while preserving trailers/metadata; path/directory targets; generate or
   provide. We have `pass generate` (insert-only) and in-editor generate in
   Pages, but no update/rotate flow.

Linux Tomb (`dm-crypt`/`LUKS`) requires root and is not portable to Pages or
non-Linux hosts. We still want Tomb’s *ideas* everywhere, plus a thin adapter
when the `tomb` binary exists.

## Goals

1. **Portable multi-tomb product model (CLI-first)** — named registry of sealed
   stores with separable key URIs; open/close; switch active tomb.
2. **Optional Linux Tomb adapter** — when `tomb` is on `PATH`, dig/forge/lock/
   open/close can back a registry entry; never required for core workflows.
3. **pass-otp storage both ways** — (1) trailer-compatible `otpauth://` lines
   like pass-otp; (2) structured OTP field on `.osseal` / vault items with
   lossless round-trip to trailer form for classic trees.
4. **`opensesame pass otp …` by default** — not an optional extension; no
   dependency on `oathtool` / `qrencode` (native Rust + existing Pages QR where
   useful).
5. **`opensesame pass update …` by default** — pass-update-shaped CLI; Pages
   vault gets a **single-item** “Update password/secret” action (same UX for
   login, secret, and other secret-bearing kinds). Bulk/folder update stays
   CLI-only in v1.
6. **ADR 0005** — agents never gain `show` / `otp code` / reveal; ConnectionRef
   only.

## Non-goals (v1)

- Reimplementing full Tomb steganography / bury-key-in-image UX
- Requiring root or `cryptsetup` for portable tombs
- Bulk folder update in the Pages UI
- HOTP as a primary path (parse/validate may accept `otpauth://hotp/…` but
  code generation focuses on TOTP; HOTP counter bump can follow)
- Cloud sync protocols beyond existing git / history connectors
- Changing top-level `opensesame init` (`.env.schema` only)

## Decision summary

| Topic | Choice |
|-------|--------|
| Tombs | Portable multi-tomb registry + open/close; Linux `tomb` adapter optional |
| OTP on disk | pass-otp trailer lines **and** structured field; always round-trip |
| OTP CLI | First-class `opensesame pass otp` |
| OTP crypto | Native RFC 6238 (align with Pages `totp.ts`); no `oathtool` |
| Update CLI | First-class `opensesame pass update` (pass-update options subset) |
| Update Pages | Single-item action on password/secret-bearing vault items |
| Agents | No OTP/update/show reveal tools |

## Architecture

```
┌──────────────────┐     registry      ┌─────────────────────────┐
│ Pages vault(s)   │◄─── name/list ───►│ ~/.config/opensesame/   │
│ OPFS + optional  │                   │ tombs.json              │
│ multi-root       │                   └───────────┬─────────────┘
└────────┬─────────┘                               │
         │ store-sync                              │ active / --tomb
         ▼                                         ▼
┌──────────────────────────────────────────────────────────────┐
│ sealed-store engine                                          │
│  Entry { secret, trailer, otp?: OtpUri }                     │
│  render ↔ parse: first line + otpauth trailer (+ structured) │
│  open session → ItemDataKey until close                      │
└───────────────┬───────────────────────────┬──────────────────┘
                │                           │
                ▼                           ▼
        portable key URI            optional: `tomb` binary
        (.opensesame-key path)      (LUKS volume → mount path)
```

## 1. Tombs

### Registry

Default path: `OPENSESAME_TOMBS_CONFIG` → else
`$XDG_CONFIG_HOME/opensesame/tombs.json` → else
`~/.config/opensesame/tombs.json`.

```json
{
  "version": 1,
  "active": "personal",
  "tombs": [
    {
      "name": "personal",
      "store": "~/tombs/personal/store",
      "key": "~/keys/personal.opensesame-key",
      "backend": "portable"
    },
    {
      "name": "work-luks",
      "store": "~/.password-store",
      "key": "~/.password.key.tomb",
      "volume": "~/.password.tomb",
      "backend": "linux-tomb"
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `name` | Stable id used by CLI/UI |
| `store` | Ciphertext root (sealed-store tree) |
| `key` | Key material path/URI (passphrase-wrapped key **or** Linux tomb key) |
| `volume` | Optional; Linux Tomb file when `backend` is `linux-tomb` |
| `backend` | `portable` (default) or `linux-tomb` |

### Open / close

- **Closed:** `pass show|insert|otp|update|…` fail with a clear “open a tomb”
  message (except `pass tomb …`, `pass ls` may list registry only).
- **Open:** unlock key → hold `ItemDataKey` in process memory for the CLI
  session (or a short-lived agent-local session file under `XDG_RUNTIME_DIR`
  with restrictive perms — prefer memory-only for v1; document that each
  `opensesame pass` invocation re-prompts unless `OPENSESAME_STORE_PASSWORD`
  is set, matching today).
- **Active tomb:** `pass use <name>` sets registry `active`; `--tomb <name>`
  overrides per command.

v1 does **not** require a long-lived daemon to keep a tomb “mounted.” Open means
“this process may unlock and operate on that root.” For Linux Tomb, open/close
additionally call `tomb open` / `tomb close` so the mount appears/disappears.

### CLI verbs

| Verb | Role |
|------|------|
| `pass tomb list` | List tombs + active marker |
| `pass tomb add` | Register portable (or linux-tomb) entry |
| `pass tomb rm` | Unregister (does not delete ciphertext) |
| `pass tomb use <name>` | Set active |
| `pass open [name]` | Linux: `tomb open` if needed; mark session target |
| `pass close [name]` | Linux: `tomb close`; clear active mount state |
| Existing `pass *` | Operate on active / `--tomb` store root |

Root resolution when a tomb is active: use that tomb’s `store` (and `key`)
instead of the global `OPENSESAME_STORE_DIR` chain. Env overrides still win
when explicitly set for one-off ops.

### Pages

- Settings (or Vault switcher): list registered tombs / local vault roots;
  switch active human vault.
- First portable tomb can be bootstrapped from the current single OPFS vault
  (migration: “This device” becomes the default tomb name).
- Distributed = multiple registry entries pointing at different paths/remotes
  (git history connector remains per-tomb as today).

### Linux adapter

- Detect `tomb` executable; if missing, `backend: linux-tomb` entries error
  with install hint.
- Map pass-tomb-ish env names for familiarity:
  `PASSWORD_STORE_TOMB_FILE`, `PASSWORD_STORE_TOMB_KEY` when importing.
- Never invoke `sudo` from OpenSesame (workspace rule); document that the user
  must already be permitted to run `tomb` as themselves.

## 2. OTP (pass-otp + structured)

### Entry model

Extend sealed-store `Entry`:

```rust
pub struct Entry {
    pub secret: String,       // first line
    pub trailer: String,      // freeform remainder (may include otpauth)
    pub otp: Option<OtpUri>,  // structured view; always sync’d with trailer
}
```

- **Parse:** scan trailer lines for `otpauth://…`; first valid URI → `otp`.
- **Render:** if `otp` is set, ensure exactly one `otpauth://` line in trailer
  (replace existing otpauth lines); preserve other trailer lines.
- **`.osseal` JSON envelope (optional field):** may persist `otp` explicitly;
  decrypt path still fills `Entry` so `.gpg`/`.age` plaintext form stays
  pass-otp compatible.

Pages vault: keep `item.totp` (seed or URI). **store-sync** maps
`totp` ↔ sealed-store `otp` / trailer.

### CLI

| Verb | Role |
|------|------|
| `pass otp [code] [-c] <name>` | Print TOTP (optional clipboard, clear after ~45s when possible) |
| `pass otp insert [-f] [-e] [name]` | Prompt/stdin URI; name from URI label if omitted |
| `pass otp append [-f] [-e] <name>` | Append/replace URI on existing entry |
| `pass otp uri [-c] [-q] <name>` | Show URI; optional clip / QR (terminal or path) |
| `pass otp validate <uri>` | Exit 0/1 |

Implementation: Rust RFC 6238 in `sealed-store` (or small `opensesame-otp`
crate shared with future Wasm); align algorithms/digits/period with Pages
`totp.ts` tests (RFC vectors).

### Pages

- Keep live TOTP on login detail; ensure secret/agent-secret kinds can store
  OTP the same way when relevant.
- No agent reveal of OTP codes.

## 3. Update (pass-update)

### Semantics

- Default: update **first line only** (password/secret); preserve trailer + OTP.
- `--multiline` / `-m`: replace entire plaintext body (advanced).
- Targets: path, directory (all entries under prefix), optional globs.
- Modes: generate (default length / `--length` / `--auto-length` /
  `--no-symbols`), `--provide` (prompt), `--force` (skip confirm).
- `--include` / `--exclude` regex on **current secret** (first line), matching
  pass-update.
- Interactive default: show old secret, confirm, then write (TTY); `--force`
  skips confirm.
- `--clip`: copy new secret when done (best-effort).
- `--edit`: open `$EDITOR` on plaintext body (CLI only; optional v1.1 if
  schedule slips).

### CLI

```text
opensesame pass update [options] <pass-names...>
```

### Pages

On ItemDetail / ItemEditor for kinds with a primary secret field (login
password, secret value, etc.):

- Action: **Update password** / **Update secret**
- Flow: Generate (reuse existing generator) or Enter manually → confirm →
  write field; bump `passwordChangedAt` where applicable; preserve TOTP/notes/
  username.
- No bulk folder update in v1.

## Security

- OTP secrets and updated passwords are human-plane only; no MCP/agent tools
  that print codes or new secrets.
- Clipboard clear timers best-effort (same constraints as Pages today).
- Tomb registry files must not contain raw private keys — only paths/URIs.
- Linux Tomb adapter inherits Tomb’s threat model; document physical
  key/volume separation as the recommended posture.

## Compatibility

| External | OpenSesame |
|----------|------------|
| `~/.password-store` + pass-otp trailer | Read/write via Entry parse/render |
| pass-tomb env paths | Import into registry as `linux-tomb` |
| Single-root ADR 0037 | Still valid as “one active tomb”; multi via registry |
| Pages `item.totp` | Maps to structured OTP + trailer |

## Competitors / docs to update

- `docs/competitors/pass.md` — note otp/update/tomb parity
- New `docs/competitors/tomb.md` (craft bar / adjacent)
- ADR follow-up or amendment to 0037 for multi-tomb root resolution
- PRODUCT.md capabilities bullets

## Implementation order (suggested)

1. Entry OTP parse/render + Rust TOTP + `pass otp` verbs + tests  
2. `pass update` core (single path, then directory) + tests  
3. Tomb registry + active root resolution + portable add/list/use  
4. Linux Tomb adapter (feature-detect)  
5. Pages: OTP store-sync hardening; Update action; tomb/vault switcher  

## Open questions (non-blocking)

- Long-lived “open” session file vs per-invocation unlock only (lean:
  per-invocation + env password, same as today).
- HOTP counter persistence location if/when HOTP is prioritized.
- Whether `--edit` ships in the first CLI cut or immediately after.
