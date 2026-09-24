# ADR 0140 — Pages hosts every ceremony

- Status: Accepted
- Date: 2026-09-24
- Supersedes: [ADR 0045](0045-hosted-ceremony-pages.md) decision 1 and its
  2026-08-19 amendment (ceremonies stay off the Pages origin)
- Amends: [ADR 0138](0138-self-issued-identity-one-native-host.md) (the
  table row that assembles `ceremonies` and `mobile-mfa` into a separate
  hosted deployment), the native-host implementation plan
- Builds on: [ADR 0086](0086-wallet-native-interaction-layer.md) (one
  interaction envelope), [ADR 0090](0090-static-frontend-complete-without-backend.md),
  [ADR 0130](0130-operator-controlled-capability-composition.md),
  [ADR 0136](0136-join-a-session-restored.md), [ADR 0139](0139-one-definition-every-target.md)

## Context

The products are the PWA, the native binary, the browser extension and
Android. Three web apps sat beside the PWA and did parts of its job:

- `apps/ceremonies` — hosted ceremony pages: claim, drop, device approval,
  the authorization inbox and review, notification routing, authenticator
  hand-off.
- `apps/mobile-mfa` — the phone half of a cross-device approval (`/i/<ref>`)
  and enrolment of Identity-account authenticators.
- `apps/console` — sign-in, claim, device approval, task access and
  organization sign-in settings.

Each ceremony existed two or three times: the claim ceremony in ceremonies
and console, device approval in ceremonies, console and Pages
(`app-core/lib/directory.ts`), and Pages did not import
`@opensesame/ceremony-kit` at all. Worse, the one ceremony Pages did carry
(a drop link, `/claim`) sits in the optional `sharing.drops` capability, so on
a default installation a recipient is told the feature is not available.

ADR 0045's amendment kept anonymous ceremonies off the Pages origin because
a link-reachable page parses attacker-supplied input before authentication,
and the Pages origin holds the vault. The concern is real; the answer was a
second origin and a second code base, which is what drifted.

## Decision

**Every ceremony a link can open is a route of the Pages app, backed by one
implementation in `@opensesame/ceremony-kit` (protocol) and
`@opensesame/app-core` (state), and the ceremonies, mobile-mfa and console
apps are deleted.** The concern ADR 0045 named is met inside the app:

1. **One always-on capability, `identity.ceremonies`,** carries every
   anonymous route: `/claim`, `/device`, `/i/:ref`, `/approve/:ref`,
   `/invoke/:kind`, and the `/guest` and `/delegate` aliases. It cannot be
   optional: these links arrive on devices that have approved nothing
   (ADR 0130 consent cannot precede the first visit).
2. **The routes never touch the vault.** They are `gate: "any"`, read no
   vault key, prompt no unlock, and write nothing to OPFS. A fragment
   (`#token=`, `#key=`) is captured at boot into memory and scrubbed from the
   address bar before any other code runs, as Join invites already are
   (`captureInviteFromPage`). Inputs are parsed only by ceremony-kit's
   bounded, shape-checked parsers (`interaction-url.ts`), which refuse
   anything but the canonical shape. The frame guard in `main.tsx` applies.
3. **One list of routes.** `spec/config/ceremony-routes.json` names each
   ceremony path and the legacy link schemes; ceremony-kit's builders, the
   Pages route contributions, the Identity API's link launcher, the
   `.well-known` associations and the Android manifest each have a drift test
   against it (ADR 0139).
4. **Links point at the deployment.** The Identity API's
   `OPENSESAME_CLIENT_APP_URL` is the single ceremony origin, the Pages
   deployment. A ceremony talks to the Identity API the deployment is
   configured with (`identityApi`); links carry no endpoint.
5. **Gating is per card (ADR 0090).** A ceremony card always shows its own
   fields; its commit key is enabled only when an Identity API is configured
   or the device-native host serves the route. Nothing sits in front of the
   front door, and no copy names a missing service.

Decisions recorded with the plan (`docs/implementation/ceremonies-into-pages/`):

| # | Decision |
|---|---|
| D1 | Ceremonies run on the Pages origin, under §2. ADR 0045's embed tier is deferred: per-processor `frame-ancestors` needs a host that sends headers. |
| D2 | The recipient side of a drop is part of `identity.ceremonies` (always-on); sending a drop stays in `sharing.drops`. |
| D3 | Approving a device sign-in moves out of `enterprise.directory-provisioning` into `identity.ceremonies`; one implementation, ceremony-kit `approveDevice`. |
| D4 | Console task access does not move: Pages no longer speaks the task bus (ADR 0128); `opensesame task inspect` and MCP `task_status` cover it. |
| D5 | `/delegate` is an alias into Join (ADR 0136); the dev-grade `/api/v1/session/local` mint is not carried over. |
| D6 | A claim bearer lives in tab-scoped `sessionStorage` so it survives a federated sign-in redirect, and is purged on lock and on completion; `queue.ts`'s memory-only rule is amended for this one kind. |
| D7 | `/i/:ref` and `/approve/:ref` open before unlock: they need an Identity session, not a vault. |
| D8 | A ceremony uses the deployment's configured Identity API. |
| D9 | Notification routing is Settings › Notifications, an optional `notifications.routing` capability in the Notifications feature, stored as files (ADR 0134). |
| D10 | Identity-account authenticators are rows in Settings › Security's one list (ADR 0091); `mfaAppUrl` is retired. |
| D11 | `.well-known` authenticator associations are served only by the Vercel deployment (host root); GitHub Pages under a path cannot serve them. |
| D12 | `/guest` is the Pages guest road, which also seals a guest vault. |
| D13 | Mobile MFA's paste-a-bearer-token field is dropped; Pages holds the Identity session. |

## Consequences

- One ceremony code path per flow; the link a person follows lands in the
  app they already have.
- The most link-exposed parsing now runs on the vault origin. The residual
  risk is bounded by §2: no vault read, fragment scrub before any other code,
  canonical-shape parsers, and the same ADR 0090 boot.
- Twelve stacked pull requests carry it (the plan's §5): models first, then
  routes, then the deletion.
