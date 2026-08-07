# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Vite + TypeScript SPA with vite-plugin-pwa, built to static assets for GitHub Pages (`apps/pages`). Chosen because the brief requires GitHub Pages static hosting, offline PWA, and browser-only execution without privilege elevation.

## Users

- **Primary (inferred from brief + repo):** Operators and agent builders who need OpenSesame ceremonies and task-authority visibility from a browser, including offline / constrained environments.
- **Secondary:** Visitors evaluating the dual-plane host/client model who need an installable offline shell.

## Product Purpose

OpenSesame is a private authorization fabric for the agentic era. This GitHub Pages PWA is the **offline-first client shell**: sealed local store and ceremony queues work without network; configured Host/Identity APIs are used when online.

## Positioning

Offline-capable OpenSesame client with sealed persistence, protocol honesty (Bearer ≠ DPoP), and task-ceiling explainability — never `getSecret()` or raw credential export.

## Capabilities (this surface)

- App-shell offline cache (Service Worker)
- Sealed local store / sync cursor
- Online: health probes, device approve, claim present/complete, task inspect
- Offline: queue device/claim intents; labeled synthetic task demo
- Settings for Host / Identity base URLs
- Installable PWA

## Constraints

- No sudo.
- Cannot host Rust Host API or Identity control-plane on GitHub Pages.
- Never expose raw secrets or private proof keys.
- Demo/synthetic data must be labeled.
- ADR 0017 dual-plane separation preserved.

## Accessibility

Keyboard operable; visible focus; status/alert roles; prefers-reduced-motion respected.
