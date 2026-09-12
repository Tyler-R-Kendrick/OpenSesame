# ADR 0115 — The front door, and connectors by reference

- Status: Accepted
- Date: 2026-09-12
- Supplements: [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (sign-in is the first screen, and nothing gates it),
  [ADR 0114](0114-tabbed-setup-ceremony.md) (a tab per concern),
  [ADR 0061](0061-access-pam-plane-ceremonies.md) (Access is the PAM plane),
  [ADR 0079](0079-shared-sessions-and-scoped-grants.md) (joining a session)
- Does not change: [ADR 0005](0005-authority-handle-connectionref.md) (no
  agent ever holds a credential), [ADR 0032](0032-connection-broker-service-integrations.md)
  (the Host broker), REUSE.md (Nango is study only, never vendored)

## Context

A device nobody has set up opened on the sign-in form with two quiet links in
its foot: `Deployment setup` and `Join a session`. That was correct as a
matter of gating (ADR 0090: no operator's question may stand in front of
sign-in) and wrong as a matter of arrival. The decision a first visitor
actually brings is the one Teams and Zoom put on their front page — *am I
joining something, or starting my own?* — and the screen answered it in the
smallest type it had.

Setting up your own, meanwhile, was five tabs of choices and no shortcut. A
deployment that already ran its OAuth round trips somewhere — a Nango
environment, hosted or self-hosted — had to authorize every connector again
here, one Host ceremony at a time, and the result lived in Settings, not on
the PAM plane where a connector is bound to the people and agents allowed to
use it.

## Decision

### 1. The front door

On a device with **no vault and no setup record**, `UnlockScreen` renders
`FrontDoor` instead of the sign-in form: the wordmark at hero scale as the
`h1` — the same slot-reel every gate runs, once, as the screen's one authored
moment — a one-line lede, and two roads made large: **Join a session** and
**Set up your own**. Beneath them, whole and ungated, the sign-in panel:
the broker's brand marks, `Continue as guest` full-size, `Skip` in the
card's corner, and `Use without an account`. Nothing is in front of anything;
the roads are offers on the same card, not a gate before it.

The keyboard lands on the first road; Tab walks the second road, the skip,
the brand marks, guest and the local-only seal in document order. Where an
Identity API exists the identifier field keeps the caret it already took,
because typing is the one step there.

The front door retires itself. Finishing the ceremony — or skipping all of
it — writes the setup record, joining writes it too, and from then on the
sign-in form is the first screen with both roads back in its foot. A vault
on the device is the other way out: a returning device never sees the door.

`verify:static` and `verify:keyboard` prove the arrival on the production
origin: the door's roads, the broker's button, guest, Skip and the local seal
on the first screen, and the Tab order above with real key presses.

### 2. Connectors by reference — the `connectors` tab

Setup gains a second tab, **connectors**, between backups and ai. It asks
one thing: *which connectors are already authorized?* The answer is a
**Nango-compatible directory** — `https://api.nango.dev`, or an instance the
operator runs on `:3003` — and an environment key. `Sync connectors` reads
the directory's two listing routes (`GET /integrations`, `GET /connections`,
falling back to the older `/connection`) and keeps, per connection: the
integration, the connection id, the end user Nango recorded, and whether
Nango reports it healthy.

Rules that keep it honest:

- **Only listings are read.** `GET /connection/{id}` — the route that returns
  credentials — is never called. A token has no business in this page (ADR
  0005), and a listing row that carried one is dropped at the parser.
- **Nothing is vendored.** `lib/nango-directory.ts` reads the public wire
  shapes tolerantly, current and older forms alike, so anything that answers
  the same two routes is a directory too. No Nango package, no copied source
  (REUSE.md).
- **Three homes, by sensitivity.** The endpoint is configuration and sits in
  plaintext beside `setup.v1` (`connector-directory.v1`), because the
  ceremony runs before any vault exists and an address is not a secret. The
  key and the synced list are sealed in the tomb (`config/connector-directory`)
  once one is open. A sync run before that waits in memory and the first
  unlock seals it (`App` calls `sealPendingConnectorDirectory` on
  `unlocked`); a reload before then forgets the key, the endpoint survives,
  and Access › Connectors asks for the key again. Nothing sensitive is ever
  written in the clear to get around that.
- **https, or http on loopback.** The same scheme rule every other endpoint
  in this app holds to; `localhost:3003` is offered as a fill on a loopback
  tab only, never assumed (ADR 0090 §3).
- **The tab is skippable like every other,** and the form is the same
  component Access › Connectors uses, so the endpoint means one thing in
  both places.

### 3. Access › Connectors — the PAM binding

Access gains a **Connectors** tab between Sessions and Resources. It lists
the connectors this device knows — the directory's connections, and the
Host's brokered connections where a Host is configured — as terse rows: mark,
name, `integration · connection id`, source, health, and how many identities
are bound. **Bind** opens one form under one row: a person or agent from the
local directory (ADR 0102), a policy (`Use` or `Invoke`), a duration. A
binding **is a local share grant of kind `connection`** (ADR 0107's ledger,
the same one Identity shares write), so "who may use which connector, under
which policy, until when" has one answer wherever it is asked, and no second
authority model appears beside the first. **Revoke** ends a binding early.

The directory row above the list names where the connectors came from and
when; the command strip re-syncs with the sealed key, opens the endpoint for
editing, and reloads. With no directory synced the panel asks for one and
reports nothing else — a deployment that asks nothing may never report that
something failed (ADR 0090 §6).

### 4. Parity and support

Two client-local ceremonies join the capability registry,
`connectors.directory.sync` and `connectors.bind`, both excluded from WebMCP
with their reasons: the key is a credential a person types, and binding is
the PAM decision itself. Tutorial targets `setup.connectors` and
`access.connectors` and the goal `access.connectors` give the support agent
the words; the gate targets moved to `setup-catalog.ts` and their goals to
`setup-goals.ts` so the boot path has one file to read.

## Consequences

- `SetupScreen` has six tabs: backups, connectors, ai, identity, mfa, sync.
  `SetupRecord.skipped` may now contain `"connectors"`.
- `ACCESS_VIEWS` gains `connectors`; the rail subtree, WebMCP navigation
  destinations and the page tree follow from the one list.
- `UnlockScreen` grew a branch and lost two helpers to their own files
  (`StrengthMeter`, `useCountdown`); `AccessSection` lost its tab strip to
  `AccessTabs`. Both files are shorter than they were, and their baselines
  are tightened.
- The Nango stance in `docs/competitors/nango.md` is unchanged: adjacent,
  studied, and now read from — never depended on.
