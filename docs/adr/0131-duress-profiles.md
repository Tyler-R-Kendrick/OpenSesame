# ADR 0131 — Duress profiles (browser-local optional protection)

## Status
Accepted

## Context
Owners need configurable responses to coercion without mandating a backend or promising personal safety.

## Decision
- Primary enforcement is the static PWA (`apps/pages`) offline after enrollment.
- Policy documents never contain codes/secrets; enrollment seals trigger slots separately.
- Restricted/decoy compartments use independently generated keys (INV-05).
- Alerts use an independently sealed package + outbox; delivery ≠ acknowledgement (INV-16).
- Local holds are application clocks only (INV-19). Local removal is application-scoped, not forensic erase (INV-23).
- Host/daemon/peer paths are optional independent authorities.

## Consequences
- Feature-off readers must refuse armed duress formats they cannot interpret.
- Historical offline copies with old keys remain a disclosed residual risk (INV-24).
