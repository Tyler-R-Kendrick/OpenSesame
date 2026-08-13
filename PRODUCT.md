# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Vite + TypeScript SPA with vite-plugin-pwa, built to static assets for GitHub Pages (`apps/pages`). All vault cryptography runs in-page on WebCrypto; ciphertext persists to OPFS. No privilege elevation, no server-side vault.

## Users

- **Operators** use it as an authority console: Host connectors, agent grants, device login, site claims, receipts. This is the everyday job and the reason the Pages surface exists.
- **Agents** invoke through a ConnectionRef. They never read a secret out of the device store; they receive a scoped grant with a capability ceiling and the Host returns a receipt. There is no `getSecret()`.
- **Humans** keep logins, passkeys, cards, and notes on **this device** — a sealed store used to finish ceremonies, not a Bitwarden replacement.
- **Websites** use it as an auth broker. A static site with no backend gets "Sign in with OpenSesame" through an origin-derived public client and PKCE.

## Product Purpose

OpenSesame is a private authorization fabric for the agentic era. This surface is its **Pages client**: an authority console on static hosting, plus a sealed human store on the same device. Two stores. Host connectors never appear as plaintext here. GitHub Pages cannot host the Host or Identity APIs.

## Positioning

An Infisical-class authority console that also keeps a human store on the device. Craft bar: Infisical Agent Proxy / `infisical run` for agents; Bitwarden/1Password habits only for the local human store. Never their brand marks. Not a password-vault product.

## Brand commitments

- Two stores, one console. Host holds connectors; this device holds human items.
- Master password unwraps the device vault key. It is not stored. A reload asks for it again.
- Agents get ConnectionRefs and grants, never plaintext. There is no `getSecret()` affordance anywhere in the UI.
- Demonstration data is labeled SYNTHETIC and deletable, never seeded silently.
- The rail tells the truth about Host and Identity. "Online" is not a Host status.

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
