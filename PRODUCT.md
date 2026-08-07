# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Vite + TypeScript SPA with vite-plugin-pwa, built to static assets for GitHub Pages (`apps/pages`). Chosen for offline installable vault UX without privilege elevation.

## Users

- **Primary:** Humans who keep sealed authority material in a personal vault (connections, claims, device sessions, task grants) and need Bitwarden-class unlock → search → item habits.
- **Primary (peer):** Agents that consume the same vault through Host/Identity ceremonies — never via `getSecret()` or raw credential export.
- **Secondary:** Operators configuring Host/Identity API bases and flushing offline ceremony queues.

## Product Purpose

OpenSesame is a private authorization fabric for the agentic era. This GitHub Pages PWA is the **offline-first vault client**: unlock a sealed local store, browse typed vault items, run or queue ceremonies, and inspect task ceilings — usable by a human in the browser or by an agent through the same authority model.

## Positioning

A Bitwarden-class vault for **authority**, not passwords: sealed persistence, human and agent peers, protocol honesty (Bearer ≠ DPoP), task ceilings that only narrow. Craft bar (user-pinned): Bitwarden; companion bar assumed until confirmed: 1Password.

## Brand commitments

- Vault is the home surface (not a protocol dashboard).
- Feel and information architecture sit beside Bitwarden (and 1Password polish) without cloning Bitwarden brand marks or purple identity.
- Never expose raw secrets or private proof keys in the UI.

## Capabilities (this surface)

- Unlock / lock device session over sealed OPFS store
- Searchable vault item list (connection, task, claim, device, note)
- Agent peer view: same items, agent-oriented actions (inspect, queue ceremony)
- Online: health probes, device approve, claim present/complete, task inspect
- Offline: ceremony outbox; labeled synthetic demo items
- Settings for Host / Identity base URLs
- Installable PWA + service worker

## Constraints

- No sudo.
- Cannot host Rust Host API or Identity control-plane on GitHub Pages.
- Never expose raw secrets or private proof keys.
- Demo/synthetic data must be labeled.
- ADR 0017 dual-plane separation preserved.
- No custom GitHub Actions runners for deploy (use `scripts/deploy-pages.sh` / `gh`).

## Accessibility

Keyboard operable; visible focus; status/alert roles; prefers-reduced-motion respected.
