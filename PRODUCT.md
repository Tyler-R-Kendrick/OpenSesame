# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Vite + TypeScript SPA with vite-plugin-pwa, built to static assets for GitHub Pages (`apps/pages`). All vault cryptography runs in-page on WebCrypto; ciphertext persists to OPFS. No privilege elevation, no server-side vault.

## Users

- **Humans** use it as a password manager and passkey store: logins, TOTP, cards, secure notes, generator, password health. This is the everyday job and the reason the app exists.
- **Agents** use it as a secret store. They never read a secret out of the vault; they receive a scoped grant with a capability ceiling and invoke through the Host plane, which returns a receipt.
- **Websites** use it as an auth broker. A static site with no backend gets "Sign in with OpenSesame" through an origin-derived public client and PKCE.
- **Developers** use it as an authority. They claim an origin as their application, attach aliases, read task ceilings, and audit receipts.

## Product Purpose

OpenSesame is a private authorization fabric for the agentic era. This surface is its **vault client**: a real end-to-end-encrypted store that a human unlocks with a master password, an agent draws scoped authority from, a website authenticates against, and a developer governs. One encrypted store, four ways in.

## Positioning

A Bitwarden alternative whose vault holds the same things Bitwarden's does — and also holds authority, because the same person who owns the passwords owns the agents and the sites. Craft bar (user-pinned): Bitwarden and 1Password. Match their habits and their finish; never their brand marks or purple identity.

## Brand commitments

- The vault holds real secrets. Master password derives the key that decrypts them; nothing else does.
- Bitwarden/1Password information architecture and keyboard habits, executed at their craft level, in OpenSesame teal and navy.
- Agents get grants, never plaintext. There is no `getSecret()` affordance anywhere in the UI.
- Demonstration data is labeled and deletable, never seeded silently into a real vault.

## Capabilities (this surface)

- Create and unlock an E2EE vault: PBKDF2-SHA256 master key, AES-GCM wrapped vault key, sealed blob in OPFS
- Vault items: login, passkey, card, secret, note — full create/edit/delete, folders, favorites, trash
- Password generator (characters and passphrase), strength estimation, password health report (weak, reused, old)
- TOTP codes generated in-page from stored seeds
- Clipboard copy with automatic clear; auto-lock on idle and on tab hide
- Passkey unlock via WebAuthn PRF where the platform supports it
- Agents: scoped secret grants with capability ceilings; live task inspection against the Host API
- Sites: origin-derived clients, application claim ceremony, integration snippet
- Authority: device/CLI authorization, ownership claims, protocol profile honesty, offline ceremony outbox
- Encrypted export and import; installable PWA

## Constraints

- No sudo.
- Cannot host the Rust Host API or the Identity control-plane on GitHub Pages; both are remote and configurable.
- Never expose private proof keys. Secrets are revealed only to the human who unlocked the vault, never to an agent.
- No localStorage or sessionStorage for vault material (XSS-exfiltrable; enforced by ast-grep).
- Vault key and master key live in memory only; never persisted.
- Demo/synthetic data must be labeled.
- ADR 0017 dual-plane separation preserved.
- No custom GitHub Actions runners for deploy (use `scripts/deploy-pages.sh` / `gh`).

## Accessibility

Keyboard operable end to end; visible focus; status/alert roles; prefers-reduced-motion respected; reveal and copy controls announce state.
