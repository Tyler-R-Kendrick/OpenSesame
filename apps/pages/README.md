# @opensesame/pages

The OpenSesame vault client — an installable PWA served from GitHub Pages.

It is a real end-to-end-encrypted vault, not a viewer over a remote one. The master password
derives the key that decrypts every item; nothing is uploaded, and nothing else can open it.

## Four audiences, one encrypted store

| Section | Who | What it does |
| --- | --- | --- |
| **Vault** | humans | Logins, passkeys, cards, agent secrets, secure notes. Generator, TOTP, folders, favorites, trash, password health. |
| **Agents** | agents | Secrets exposed as scoped grants bounded by a capability ceiling — never as plaintext. Live task inspection against the Host API. |
| **Sites** | websites | Origin-derived public clients for static sites: register, rotate, revoke, and copy the integration snippet. |
| **Authority** | developers | Principal session, device/CLI authorization, ownership claims, protocol profiles, offline ceremony outbox. |

## Cryptography

- Master password → PBKDF2-SHA256, 600,000 iterations (OWASP 2023 floor) → master key.
- Master key wraps a random 256-bit vault key with AES-GCM. Changing the master password
  re-wraps that key; items are never re-encrypted.
- The item collection is sealed with AES-256-GCM under the vault key and written to OPFS as
  ciphertext. A fresh 96-bit nonce per write; the GCM tag detects tampering and doubles as the
  password check.
- Keys are non-extractable `CryptoKey` handles held in memory for the unlocked session only.
  Locking drops them. Nothing vault-related touches `localStorage` or `sessionStorage`.
- TOTP codes are computed in-page from the stored seed (RFC 6238, verified against the
  specification's own test vectors).
- The password health report runs entirely locally and never contacts a breach service.

There is no recovery path. That is a property, not an omission.

## Running it

```bash
pnpm --filter @opensesame/pages dev        # http://localhost:5180
pnpm --filter @opensesame/pages test       # vault core: crypto, TOTP, generator, health
pnpm --filter @opensesame/pages typecheck
pnpm --filter @opensesame/pages build
```

The Identity and Host planes are remote and configured in **Settings**; static hosting cannot
run either. Every section degrades to an honest disconnected state rather than pretending.

Sample data is opt-in from Settings, badged in the UI, and removable in one action.
