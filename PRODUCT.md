# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Vite + TypeScript SPA with vite-plugin-pwa, built to static assets for GitHub Pages (`apps/pages`). All vault cryptography runs in-page on WebCrypto; ciphertext persists to OPFS. No privilege elevation, no server-side vault.

## Users

- **Operators** use it as an authority console: Host connectors, agent grants, device login, site claims, receipts. This is the everyday job and the reason the Pages surface exists.
- **Agents** invoke through a ConnectionRef. They never read a secret out of the device store; they receive a scoped grant with a capability ceiling and the Host returns a receipt. There is no `getSecret()`.
- **Humans** keep logins, passkeys, cards, and notes on **this device** — a sealed store used to finish ceremonies, not a hosted vault service. We are not a Bitwarden replacement; we are a **bridge for Bitwarden-family clients and stores** and for the KeePass/KDBX, `pass`, and CXF ecosystems, so the tools a person already uses keep working ([ADR 0052](docs/adr/0052-password-manager-ecosystem-bridging.md)).
- **Websites** use it as an auth broker. A static site with no backend gets "Sign in with OpenSesame" through an origin-derived public client and PKCE.

## Product Purpose

OpenSesame is a private authorization fabric for the agentic era. This surface is its **Pages client**: an authority console on static hosting, plus a sealed human store on the same device. Two stores. Host connectors never appear as plaintext here. GitHub Pages cannot host the Host or Identity APIs.

## Positioning

An Infisical-class authority console that also keeps a human store on the device. Craft bar: Infisical Agent Proxy / `infisical run` for agents ([docs/competitors/infisical.md](docs/competitors/infisical.md)); Bitwarden/1Password habits only for the local human store ([docs/competitors/bitwarden.md](docs/competitors/bitwarden.md)). Never their brand marks. Not a password-vault product, and not a hosted Bitwarden *service* — instead a bridge for Bitwarden-family clients and stores, KeePass/KDBX databases, keepassxc-protocol and browserpass/gopass clients, and FIDO CXF, implemented from public specs on the human/device/ops plane only ([ADR 0052](docs/adr/0052-password-manager-ecosystem-bridging.md), [ADR 0053](docs/adr/0053-pm-bridge-binaries.md), [docs/competitors/keepass.md](docs/competitors/keepass.md), [docs/competitors/passbolt.md](docs/competitors/passbolt.md), [docs/competitors/1password.md](docs/competitors/1password.md)). Bridging never yields an agent-facing `getSecret()`. Direct CLI competitor for the git-sealed store path: Unix [`pass`](docs/competitors/pass.md) (`password-store`). Projects-first Host scope (default personal project, SyncTarget fan-out, durable secret changelog) delivers Doppler-capability parity without cloning Doppler or teaching agents `doppler run` ([docs/competitors/doppler.md](docs/competitors/doppler.md), ADR 0041). Durable Host/Identity events ride NATS JetStream behind TaskBus with Host auth callout and xkey E2EE payloads (ADR 0042). Connector/secrets peers: Doppler, Vault, fnox, SOPS, age, Vercel Connect, Oomol Open Connector, Nango — see [docs/competitors](docs/competitors/index.md).

## Brand commitments

- Two stores, one console. Host holds connectors; this device holds human items.
- Master password unwraps the device vault key. It is not stored. A reload asks for it again.
- Agents get ConnectionRefs and grants, never plaintext. There is no `getSecret()` affordance anywhere in the UI.
- Demonstration data is labeled SYNTHETIC and deletable, never seeded silently.
- The rail tells the truth about Host and Identity. "Online" is not a Host status.

## Capabilities (this surface)

- Create and unlock an E2EE vault: PBKDF2-SHA256 master key, AES-GCM wrapped vault key, sealed blob in OPFS
- Unlock with passkey (WebAuthn PRF), PIN, and/or master password; optional TOTP MFA after primary unwrap
- Vault items: login, passkey, card, secret, note, certificate — full create/edit/delete, folders, favorites, trash
- Certificates: enter names and lifetime; the Host generates the key/CSR and uses the sealed OpenSesame private CA by default, or a configured Let's Encrypt, ZeroSSL, or Cloudflare Origin CA connection without trust downgrade
- Password generator (characters and passphrase), strength estimation, password health report (weak, reused, old)
- TOTP codes generated in-page from stored seeds; store-bridge prefers pass-otp `otpauth://` trailer lines
- Update password / secret on a single vault item (generate or enter); notes and TOTP preserved
- Clipboard copy with automatic clear; auto-lock on idle and on tab hide
- Passkey unlock via WebAuthn PRF where the platform supports it (enroll in Settings)
- Agents: scoped secret grants with capability ceilings; live task inspection against the Host API
- Sites: origin-derived clients, application claim ceremony, integration snippet
- Authority: device/CLI authorization, ownership claims, protocol profile honesty, offline ceremony outbox
- Encrypted export and import; installable PWA
- Settings capability connectors: encryption key vault (default WebCrypto) and git history/persistence (default GitHub with OAuth)
- Host CLI sealed store: `opensesame pass otp` / `pass update` / multi-tomb registry (`pass tomb`, `open`/`close`) — see ADR 0038
- Org profiles on the signed-in principal (guest included): look up a tenant slug, then SSO or SAML. SAML is OIDC-brokered (ADR 0016); Identity verifies the assertion and attaches membership.

## Constraints

- No sudo.
- Cannot host the Rust Host API or the Identity control-plane on GitHub Pages; both are remote and configurable.
- Never expose private proof keys. Secrets are revealed only to the human who unlocked the vault, never to an agent.
- No localStorage or sessionStorage for vault material (XSS-exfiltrable; enforced by ast-grep).
- Vault key and master key live in memory only; never persisted.
- Demo/synthetic data must be labeled.
- ADR 0017 dual-plane separation preserved.
- Deploys publish from `main` via GitHub Pages' own Actions deployment (`.github/workflows/deploy-pages.yml`, GitHub-hosted runners only — no custom/self-hosted runners); `scripts/deploy-pages.sh` remains the manual fallback.

## Accessibility

Keyboard operable end to end; visible focus; status/alert roles; prefers-reduced-motion respected; reveal and copy controls announce state.
