# ADR 0151 — A connector page acts on the roads a device has, or is not drawn

- Status: Accepted
- Date: 2026-09-28
- Amended: 2026-10-03 (twice: the Host road is capability-specific, then
  deleted; a tile never links to a page nothing routes)
- Builds on: [ADR 0158](0158-settings-rows-act-or-are-absent.md) (a Settings
  row acts, or it is not drawn),
  [ADR 0128](0128-pages-without-host.md) (the PWA no longer speaks Host),
  [ADR 0090](0090-static-frontend-complete-without-backend.md) (a screen is
  gated on what it needs, and a deployment that asks nothing never reports a
  failure),
  [ADR 0153](0153-minimal-pwa-optional-sections.md) (Connections is an
  optional section)

## Context

ADR 0158 named one defect it left open: the Better Auth, WorkOS and Auth0 tiles
under Settings › Capabilities "still create Host connections and give no
feedback on a device with no Host". Walking every tile in a real browser as a
guest on the static deployment, 48 connector tiles drew, and 14 of their pages
had something a person could do. The rest were Host forms:

- Twenty-seven tiles (password managers, cloud secret stores, wallets,
  Tailscale, Better Auth, Azure OpenAI, Bedrock, …) draw a `configuration` form
  whose Save is `createConnection` then `setConnectionConfiguration`. Six more
  (four card rails, Doppler, Hugging Face) draw an API-key form that ends in
  `setConnectionCredential`.
- The Host road is closed in Pages: Pages opens no pairing ceremony for it
  (ADR 0128), so on every Pages build a form that saved through a Host could
  only fail.
- It failed silently. The failure was reported, as a `StatusMark` at the top of
  the page whose sentence lives in its `aria-label` — a 14px ✗ a screen-height
  from the key that was pressed — while `form.reset()` had already wiped what
  was typed, before the awaited call. The bell heard nothing.
- The same class showed elsewhere on the same pages: YubiKey, AWS KMS, Azure and
  Google KMS pages drew an empty *Connect* panel for a guest (their forms seal in
  an unlocked vault and draw nothing else), GitHub drew an OAuth-client form,
  an Authorize key that stayed disabled, and a token form, all Host-only, and
  Connect's *Create connector* form was drawn, whole, with a key disabled until
  a credential sealed in the panel above it.

## Decision

**What a connector can do on this device is decided once**
(`packages/app-core/src/lib/connect-roads.ts`), and every surface asks it. There
are two roads, and the browser opens both by itself:

- **local** — the browser does it alone: a git remote sealed on the device,
  GitHub's App registered from the browser, the vault-history switch, and a key
  or a configuration sealed on this device under the at-rest key (ADR 0149)
  — a *device connector*, kept beside Connect's and the remotes' in the one
  connections list (`packages/app-core/src/lib/device-connectors.ts`);
- **connect** — Vercel Connect, once its credential is held: the page's own
  panels seal it, then create and authorize a connector.

There is no third road (see the 2026-10-03 amendments): nothing in Pages saves,
authorizes or lists a connector through a Host.

1. **A form that saves through a closed road is not drawn.** A key or a
   configuration form seals on the device; an authorize form needs Connect.
   With neither, the form is absent, and so is the *Connect* panel that held
   only it. GitHub keeps *Create GitHub App*, which the browser does itself.
   Connect's *Create connector* is drawn once the credential above it is
   sealed.
2. **A tile is a link to a page, so it is drawn only where the page has
   something to do.** The vault-sealed key tiles (Encryption) are drawn for an
   unlocked vault and not for a guest or a locked one. A section with no switch
   and no tile is not drawn either — in the page, the rail and the phone's page
   index, which read the same rule (`featureDraws`).
3. **A page reached anyway says so.** A deep link to a connector with nothing to
   do on this device draws its header, with the mark "Not available here" in
   place of "Not enabled", which nothing there could enable.
4. **A save is all or nothing to the person.** What they typed stays until the
   whole save has worked. A connection made by a try that then failed is kept for
   the next try and sealed into, not duplicated, and the page is not asked to
   reload until the save is done, because a reload swaps the form for the
   half-made connection's card and takes the typed values with it.
5. **A failure is said where it can be read.** The mark sits beside the key that
   was pressed, in the form's own row (`FormCommit`), and the sentence is also a
   bell notice, one per connector, cleared by a success and by leaving the page.
   The page-level failure mark is mirrored the same way (`useFlashNotice`), so a
   Connect or local action that fails is heard too.

## Consequences

- A guest on the static deployment draws only connectors that act, and nothing
  on a Host-less device attempts a Host call from these pages, so nothing
  reports a failure that never happened (ADR 0090 §7).
- **The user-token keys follow the same rule.** On a Connect connector's token
  panel, *Authorize as you* is drawn only with an identity to authorize as and
  the right to manage the connector, and *Test user token* only when the page
  holds a relay to prove through (it does not in direct-token mode). They are
  disabled only while a request is in flight or the device is offline.
- **Setup's connector cards follow it too.** The MFA step's *Connect* icon key
  on a card is drawn only where `formRoad` finds a road (a configured Connect
  credential for a Connect-reachable connector); a connector that only a Host
  could take, such as Bitwarden's server, is a choice with no key.

## Amendment (2026-10-03): the Host road is capability-specific

`hostRoadOpen()` first read "any live approved grant" as an open Host road. A
browser pairing carries only the capabilities of its ceiling
(`browser-pairing.ts`: `host.sync.read|write`, or `host.join`), while creating a
connection and writing its credential need `host.connections.write`
(`crates/gateway/src/middleware/browser_user_routes.rs`). A tab holding a join
or sync grant therefore drew forms whose Save the Host would refuse. The road
was made open only when the live grant carried `host.connections.write`, and the
grant announced its changes so tiles and forms appeared and went with it. That
left a road no Pages build could open, which the next amendment settles.

## Amendment (2026-10-03, second): the Host road is deleted

**Question.** After the first amendment, no Pages pairing ceiling carried
`host.connections.write`, so the Host road was closed in every build. Either a
pairing the owner consents to should be able to carry it (build the road), or
the architecture says it stays closed (delete everything that documents or
ships it).

**What the Host does.** The Host side is not the obstacle. A sync pairing, once
its person passes the passkey check, widens to the authenticated browser's
routes, `host.connections.write` among them
(`crates/gateway/src/routes/browser_pairings/ceiling.rs`, `verified_ceiling`);
only a join pairing is held to the join routes and nothing else (ADR 0136 §4).
So a verified sync grant can create a connection on a Host. The token the
browser holds names the ceiling it asked for (`host.sync.*`), not what
verification added, which is why a client-side read of the token's scope could
never open the road.

**What Pages may do.** Nothing in Pages starts a sync pairing. The only
pairing Pages begins is the join ceremony (ADR 0136), a bounded exception that
"never configures the app's Host", and ADR 0128 says in as many words that any
future Host-speaking surface in Pages must overturn it first. A connector form
that pairs a Host to write connections would be exactly that: a Host ceremony in
front of connector configuration, which ADR 0090 and the product rules forbid
(a browser-local connector action never asks the person to pair a Host, and
Pages copy never names one), and a new authority for a static front end that
holds no operator role.

**Decision.** The Host road stays closed, and it is removed rather than left
dormant. A road nothing can open is not documented, drawn, tested or kept:

- `hostRoadOpen`, `host-grant.ts` (`hostGrantAllows`,
  `HOST_CONNECTIONS_WRITE`) and the grant-change announcements
  (`browserGrantEpoch`, `subscribeBrowserGrant`, the expiry timer) are gone.
  `FormRoad` is `"connect" | "local"`; a named Host with a live grant opens
  neither, and a test holds that.
- `packages/app-core/src/lib/connections.ts` no longer speaks to a Host. A
  connection is made by Connect, sealed on the device, or a local git remote;
  every other call is refused with its reason (`ConnectionsError`,
  `unavailable`/`not_found`) and never sent. The Host-only operations —
  organisation OAuth clients, custom providers, discovery, refresh and policy
  changes, GitHub repository listing and creation through a Host connection —
  are deleted with their forms: the OAuth-client form and the personal-access-
  token form on GitHub's page (GitHub's own App registration and each forge's
  remote form remain), and the *Custom connector* link, which led to a page
  that said "Connector not found".
- The Host's own surfaces are unchanged: connections on a Host are managed with
  the Host's CLI and API, which are where an operator holds the authority to
  do it. Pages does not represent them, because it cannot act on them.

## Amendment (2026-10-03, third): a tile never links to a page nothing routes

The connector pages (`/settings/connections/<provider>`) are routed only while
`connectors.external` is active, that is, while the **Connections** switch is on
(ADR 0153: "unselected, the module is not loaded and the route is not
registered"). The tiles under Settings › Capabilities, and Access ›
Connectors' *Open in Connections* and *New connector*, drew and linked
regardless. Walked in a real browser with Connections off — the default, for a
guest and for an unlocked vault — all 43 tiles opened a blank page.

`connectRoadSeams.pagesOpen` (installed by `connectors.external` with its
routes, reset when it is disposed) says whether the pages exist, and the tile
rule reads it (`connectorTile`):

- **Connections on:** a tile links to its page where the page has something to
  do (`connectorActs`), as before.
- **Connections off:** a connector with only a page is not drawn. A git history
  road keeps its tile as its enable switch alone — the switch acts without a
  page — with no link, and without the "No repository yet" mark, which names
  something only that page could change. A section left with no switch and no
  tile is not drawn (`featureDraws`), so Password managers, Local storage,
  Cloud secret storage and Encryption are absent until Connections is switched
  on, which is the switch on the same page.
- **Access › Connectors** offers *Open in Connections* and *New connector* only
  while the pages are routed.

Two defects of the same class are fixed with it. Waiting for a Connect
authorization compared the popup's message origin with the **Host's** origin,
and `new URL("")` threw on every device with no Host named, so a Connect
authorization could not be awaited; it now trusts the app's own origin, which is
where Connect bounces the popup. And a saved connector's operation was posted
to `https://connectors.invalid/…` when its provider declares no address — a
request that could only fail, carrying the credential on its headers; with no
declared address nothing is sent (`featureRequestSeams.performed` still tells
the feature what it performed).
