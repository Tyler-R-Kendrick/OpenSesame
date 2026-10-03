# ADR 0151 — A connector page acts on the roads a device has, or is not drawn

- Status: Accepted
- Date: 2026-09-28
- Builds on: [ADR 0158](0158-settings-rows-act-or-are-absent.md) (a Settings
  row acts, or it is not drawn),
  [ADR 0128](0128-pages-without-host.md) (the PWA no longer speaks Host),
  [ADR 0090](0090-static-frontend-complete-without-backend.md) (a screen is
  gated on what it needs, and a deployment that asks nothing never reports a
  failure)

## Context

ADR 0158 named one defect it left open: the Better Auth, WorkOS and Auth0 tiles
under Settings › Capabilities "still create Host connections and give no
feedback on a device with no Host". Walking every tile in a real browser as a
guest on the static deployment, 48 connector tiles drew, and 14 of their pages
had something a person could do. The rest were Host forms:

- Twenty-seven tiles (password managers, cloud secret stores, wallets,
  Tailscale, Better Auth, Azure OpenAI, Bedrock, …) draw a `configuration` form
  whose Save is `createConnection` then `setConnectionConfiguration`. Both go
  through the Host; a key or a configuration has no Connect twin. Six more (four
  card rails, Doppler, Hugging Face) draw an API-key form that ends in
  `setConnectionCredential`, also Host-only.
- The Host road is closed in Pages: `hostLocalSessionEligible()` needs a
  configured Host and a live approved grant, and Pages opens no pairing
  ceremony (ADR 0128). So on every Pages build, Save could only fail. (A
  live grant is also not enough, as the amendment below records: the grants
  Pages can hold carry only sync or join capabilities.)
- It failed silently. The failure was reported, as a `StatusMark` at the top of
  the page whose sentence lives in its `aria-label` — a 14px ✗ a screen-height
  from the key that was pressed, saying "This browser has no approved grant for
  that action." — while `form.reset()` had already wiped what was typed, before
  the awaited call. The bell heard nothing.
- The same class showed elsewhere on the same pages: YubiKey, AWS KMS, Azure and
  Google KMS pages drew an empty *Connect* panel for a guest (their forms seal in
  an unlocked vault and draw nothing else), GitHub drew an OAuth-client form,
  an Authorize key that stayed disabled, and a token form, all Host-only, and
  Connect's *Create connector* form was drawn, whole, with a key disabled until
  a credential sealed in the panel above it.

## Decision

**What a connector can do on this device is decided once**
(`packages/app-core/src/lib/connect-roads.ts`), and every surface asks it:

- **local** — the browser does it alone: a git remote sealed on the device,
  GitHub's App registered from the browser, the vault-history switch, a key or
  configuration sealed in an unlocked vault;
- **connect** — Vercel Connect, once its credential is held: the page's own
  panels seal it, then create and authorize a connector;
- **host** — a configured Host with a live approved grant that carries
  `host.connections.write` (`hostRoadOpen`). A grant that only syncs
  (`host.sync.*`) or joins (`host.join`) is live and approved, and cannot create
  a connection or write a credential; it opens no connector form.

1. **A form that saves through a closed road is not drawn.** A key or a
   configuration form needs the Host road; an authorize form needs Connect or
   the Host. With neither, the form is absent, and so is the *Connect* panel
   that held only it. GitHub keeps *Create GitHub App*, which the browser does
   itself, and loses what needs a Host. Connect's *Create connector* is drawn
   once the credential above it is sealed.
2. **A tile is a link to a page, so it is drawn only where the page has
   something to do.** Password managers, Local storage and the Host-only rest
   are not drawn on a device with no Host (password-store stays: its vault-history
  switch acts); the sealed-vault key tiles
   (Encryption) are drawn for an unlocked vault and not for a guest or a locked
   one. A section with no switch and no tile is not drawn either — in the page,
   the rail and the phone's page index, which read the same rule
   (`featureDraws`).
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

`useHostConfigured()` (always false, ADR 0128) is not the predicate: it would
make the Host forms unreachable and untestable. The road is read from the same
session state `transport-status` reads.

## Consequences

- A guest on the static deployment sees 14 connector tiles where it saw 48, and
  each one acts. The Password managers, Local storage and Encryption subheaders
  are gone for a guest; Encryption returns, with its four tiles, once a vault is
  unlocked.
- Nothing on a Host-less device attempts a Host call from these pages, so
  nothing reports a failure that never happened (ADR 0090 §7).
- The Host forms remain, tested, for a deployment whose road is open. No Pages
  build opens it, so a failed Host save cannot be captured from a real build;
  the unit tests hold it, and the evidence records what it could not show.
- **The user-token keys follow the same rule.** On a Connect connector's token
  panel, *Authorize as you* is drawn only with an identity to authorize as and
  the right to manage the connector, and *Test user token* only when the page
  holds a relay to prove through (it does not in direct-token mode). They are
  disabled only while a request is in flight or the device is offline.
- **Setup's connector cards follow it too.** The MFA step's *Connect* icon key
  on a card is drawn only where `formRoad` finds a road (a configured Connect
  credential for a Connect-reachable connector, or an open Host road); a
  Host-only connector such as Bitwarden is a choice with no key.

## Amendment (2026-10-03): the Host road is capability-specific

`hostRoadOpen()` first read "any live approved grant" as an open Host road. A
browser pairing carries only the capabilities of its ceiling
(`browser-pairing.ts`: `host.sync.read|write`, or `host.join`), while creating a
connection and writing its credential need `host.connections.write`
(`crates/gateway/src/middleware/browser_user_routes.rs`). A tab holding a join
or sync grant therefore drew forms whose Save the Host would refuse. The road
is now open only when the live grant carries `host.connections.write`
(`packages/app-core/src/lib/host-grant.ts`, `hostGrantAllows`), and the grant
announces its changes (`subscribeBrowserGrant`: approved, renewed, ended, or
lapsed on its own expiry) so `useConnectorRoads` redraws and tiles and forms
appear and go with it. Today no Pages pairing ceiling carries that capability,
so the road stays closed in every Pages build; a ceiling that adds it opens the
forms with no further change here.

## Amendment (2026-10-03): a tile is a link to a route that exists

A connector page is a route the Connections capability registers (ADR 0153).
With Connections off, the default, every tile on Capabilities linked to a page
that was not there and opened blank. A tile is now drawn only while Connections
is running as well as only where its page has something to do, and a section
left with no switch and no tile is not drawn; the Connections switch is what
brings them in (`useConnectorTiles`).
