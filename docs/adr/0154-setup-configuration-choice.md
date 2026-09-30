# ADR 0154 — Setup starts with a configuration choice

- Status: Accepted
- Date: 2026-09-30
- Supplements: [ADR 0114](0114-tabbed-setup-ceremony.md),
  [ADR 0130](0130-operator-controlled-capability-composition.md) §5,
  [ADR 0153](0153-minimal-pwa-optional-sections.md)

## Context

The tabbed ceremony opens on capability selection. A fresh device already
runs the minimal PWA: vault, activity and settings, with no optional
capability approved. The sections a person usually wants on top of that —
Identity, Connections, Access and item types — are optional modules the
page fetches when they are approved (ADR 0130, ADR 0153). They are not
part of the minimal plan, and walking the whole ceremony is how someone
configures an installation by hand.

## Decision

1. When setup is opened with no `step` and no join, its first screen is
   three choices: Minimal, Default and Custom. A `step` or a join opens
   the tabbed ceremony directly.
2. Minimal commits an empty optional selection and finishes. That is the
   pages install: vault, activity and settings. Default commits Identity,
   Connections, Access and the item-type extensions, with delivery
   `prefetch: selected` and `offlineCache: selected-only`, and finishes.
   The loader then fetches and activates those modules. Ambient single
   sign-on is not in that set: it reloads the document and signs in
   silently, and stays available inside Custom.
3. Custom opens the existing tabbed ceremony, including that ceremony's
   own minimal road. Skip all stays on the choice screen. Skipping
   records that the ceremony was passed over; it does not commit Minimal.
4. Setup stays optional and is never a gate (ADR 0090).

## Consequences

- The static front-door walk sees the three choices and opens Custom
  before the capabilities tab.
- A refused commit leaves the person on the choice screen.
- `minimal-local` still approves zero optional capabilities. Default is
  a selection a person makes, not a change to that profile.
