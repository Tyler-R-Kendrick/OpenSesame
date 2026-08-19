# ADR 0045 — Hosted ceremony pages and delegated auth processors

Status: Proposed
Date: 2026-08-19
Amends: ADR 0044 (decision 10, claim-ceremony host)

## Context

Every anon/guest auth and issuance ceremony we have — accept a claim,
approve a device code, start a guest session, and (per ADR 0044) claim a
connection delegation — is a link handed to somebody who is *not* an
OpenSesame user yet, or not signed in where the link lands. Today those
ceremonies live inside authenticated product apps: the console carries
`/claim` and `/device` behind its nav chrome, the PWA carries the guest
button, and Pages carries a third device-approve implementation. A link
into a product app is the wrong artifact to share externally: it drags
the whole app's surface along, it is not designed to be handed to a
stranger on a phone, and it cannot be embedded in someone else's site.

Payment processors solved this exact shape problem. Stripe ships
**Payment Links** (a shareable URL that *is* the transaction), **Checkout**
(a hosted, minimal, mobile-first page on a dedicated origin that does one
ceremony and ends), and **Elements / embedded checkout** (the same
ceremony embedded in a third party's page, isolated in an iframe on the
processor's origin so the host page never touches the sensitive
material). The parties are registered: a merchant account authorizes
which origins may embed. We want the same three-tier shape for auth
ceremonies, with registered embedders we call **delegated auth
processors**.

In-repo prior art already covers most of the mechanics:

- `apps/pages/src/screens/BrokerAuthorize.tsx` is a working standalone,
  gate-free ceremony page (ADR 0034), with `site-broker.ts` providing an
  origin allowlist (`DomainRule`, specificity-scored), per-origin consent
  storage, and `deliverToRp` (postMessage to an exact `targetOrigin`,
  fragment fallback). `apps/pages/public/auth.js` is a shipped
  dependency-free third-party drop-in (popup + postMessage with the
  origin/type/state triple filter). ADR 0034 explicitly deferred "a
  hosted deployment concern" — this ADR is that concern.
- The console `ClaimPage` established the ceremony security properties:
  fragment `#token=` transport scrubbed via `history.replaceState`,
  tab-scoped claim stash, single-present in-flight fence, superseded-load
  fencing, and principal re-read immediately before completion.
- The repo is deliberately frame-hostile everywhere: `X-Frame-Options:
  DENY` in `crates/host-core` and the control plane, `frame-ancestors
  'none'` on the claim verify page, and Pages refuses to render framed.
- `ClientAdmissionModeSchema` already includes `origin_profile`
  (`packages/contracts/src/oauth-clients.ts`) — an admission mode with no
  consumer, shaped for exactly this registration.

## Decision

1. **A standalone app, `apps/ceremonies`, hosts every anon/guest ceremony
   endpoint.** One route per scenario, each a complete shareable artifact
   with no product-app chrome: `/claim` (accept an `osc_clm_` claim),
   `/guest` (provisional principal issuance), `/device` (user-code
   approval), `/delegate` (ADR 0044 `osc_dlg_` delegation claim; page
   ships as a stub until that backend lands). Pages are mobile-first,
   accessible (labelled fields, `<output>` live regions,
   `autocomplete="one-time-code"`), and minimal — the analogue of a
   hosted card-entry form, not an app. This **supersedes-in-part ADR 0044
   decision 10**: the ceremony host moves from the console to this app.
   Every security property of that decision ports verbatim — fragment
   transport + scrub, claim stash, single-spend fences, principal re-read
   before completion, frame refusal — only the surface changes, and the
   Pages-origin exclusion rationale (ADR 0034's token-possession
   analysis) still rules out hosting ceremonies on the static vault
   origin. The console keeps its authenticated pages as management UI
   (mint/list/revoke, burned-offer surfacing) and as signed-in
   conveniences.
2. **Frame-hostility stays the default.** The ceremonies app refuses to
   render inside a frame client-side (the Pages `framed()` guard), and
   any future header-capable host serves it `frame-ancestors 'none'` /
   `X-Frame-Options: DENY`. Embedding is never ambient — it is decision 3
   or nothing.
3. **Delegated auth processors are registered embedders** (design only in
   this slice). A processor is an `oauth_clients` row with
   `admission_mode = 'origin_profile'` plus a net-new `allowed_origins`
   column (exact origins; validated with the same closed-world semantics
   as `site-broker.ts` `DomainRule`). An embed route (`/embed/<ceremony>`
   with a `processor` parameter) is served with `frame-ancestors`
   assembled per-processor at serve time from `allowed_origins` — which
   requires a header-capable host and is therefore follow-up work, not
   this scaffold. Registration is owner-fenced and assurance-gated like
   every other OAuth-client mutation; provisional principals cannot
   register processors.
4. **Embedded ceremonies speak the ADR 0034 message protocol.** A
   success/error union type with a mandatory `state` echo, delivered by
   `postMessage` to an exact `targetOrigin` (never `"*"`), with the
   receiving snippet filtering on origin, type, and state exactly as
   `auth.js` does. Completion messages carry **status only, never
   tokens** — the ceremony's outputs (a session, a delegation) live on
   our origin; the host page learns that the ceremony ended and how.
   Where third-party storage partitioning blocks the authenticated step
   inside a frame, the embed opens the hosted page as a popup (the
   `auth.js` pattern) and the frame becomes a launcher — the same
   degradation Stripe's embedded checkout performs.
5. **Every page is a skin over an existing JSON API, so agents never need
   the pixels.** `/claim` fronts `POST /v1/claims/present`,
   `GET /v1/claims/:id`, `POST /v1/claims/:id/complete`; `/guest` fronts
   `POST /v1/principals/provisional`; `/device` fronts
   `POST /v1/device/approve`; `/delegate` will front the ADR 0044 claim
   endpoint. Page inputs are machine-derivable from the URL (`#token=`,
   `?user_code=`) so an agent handed a ceremony link can extract the
   material and call the API directly. Discovery: `auth.md` and the agent
   card advertise the ceremonies origin; follow-up work makes
   `apps/control-plane/src/routes/discovery.ts` consume the
   `packages/agent-protocols` renderers (which already have
   `claimPath`/`devicePath` knobs) instead of inlining strings.
6. **Serving**: dev on port 5181 alongside the other Vite apps; the dev
   CORS defaults of the control plane admit it. Hosted deployment is
   deliberately deferred (this repo ships no CI); until then the
   control-plane's server-rendered, state-blind
   `GET /v1/claims/:id/verify` page remains the zero-JS landing fallback
   that claim creation already advertises as `verificationUri`.

## Consequences

- Ceremony links become shareable artifacts with a stable, minimal
  surface — the product apps stop being the thing you hand to a stranger.
  The console's `/claim` and `/device` pages remain for signed-in users;
  duplicated ceremony code should consolidate toward the ceremonies app
  over time (the device-approve flow currently exists three times).
- The Stripe analogy gives the roadmap its vocabulary: offer/claim link ≈
  Payment Link (exists once ADR 0044 lands), hosted ceremony page ≈
  Checkout (this ADR's scaffold), embedded ceremony ≈ Elements (follow-up:
  `ceremonies.js` drop-in + partition-aware popup fallback), processor
  registration ≈ merchant account (follow-up: `allowed_origins` schema +
  per-processor `frame-ancestors` serving), outbox events ≈ webhooks
  (already the projection mechanism in ADR 0044).
- Guest-first ceremonies get real: the `/claim` page offers "continue as
  guest" (a provisional principal minted in place) before completion,
  which the console never did — the identity-plane machinery (provisional
  bearers authenticate, identity upgrade preserves the principal id)
  already supports it end to end.
- A second copy of the design tokens ships (per the PR #141
  unify-by-copy convention); extracting a shared `packages/ui` remains
  future work and is not made worse by this app.
- The embed tier widens the attack surface when it lands: clickjacking on
  ceremony buttons is why frame-hostility is the default and why
  `frame-ancestors` is assembled per registered processor rather than
  configured by the embedding page. The failure mode of a mis-registered
  origin is a refused frame, never a silently embeddable ceremony.
