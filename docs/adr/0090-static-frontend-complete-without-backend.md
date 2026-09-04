# ADR 0090 — The static front end is complete without a backend

Status: Accepted
Date: 2026-09-01
Supersedes: ADR 0077 §1 and §4's gate ([first-run setup: the anonymous visitor is the operator](0077-first-run-setup-ceremony.md))
Supplements: ADR 0033 ([federated identity admission](0033-federated-identity-admission.md)),
ADR 0034 ([origin-brokered sign-in for static sites](0034-origin-brokered-static-site-signin.md)),
ADR 0078 ([an external IdP is the identity service](0078-external-idp-is-the-identity-service.md)),
ADR 0079 ([shared sessions and scoped grants](0079-shared-sessions-and-scoped-grants.md))

## Context

`apps/pages` is a static bundle on GitHub Pages. It is a **broker**: a page
with no server of its own that brokers connections to identity providers,
Hosts, daemons and connectors a person chooses to point it at. The shoo.dev
pattern (docs/architecture/federated-signin.md §0) is the whole reason it can
sign somebody in with Google: an origin-profile OIDC client, PKCE, CORS on
`POST /token`, and the provider leg run by the broker. None of that needs an
OpenSesame Identity API, a Host API, a daemon, or anything on localhost.

What production shipped instead, on every visit to
`https://tyler-r-kendrick.github.io/OpenSesame/` with nothing stored:

```text
This device is empty
  [Set up this device — Choose who signs people in]
  [Join a session — A link and a code]
```

No sign-in button. No guest button. The Google road and the guest road existed
and worked, but only on the far side of an operator's ceremony — `setupRequired`
returned true for any device with no vault and no session, and `UnlockScreen`
rendered `SetupScreen` in front of everything. ADR 0077 §1 ("the first visitor
to an unconfigured deployment is treated as its operator") and ADR 0079's join
fork stacked on top of it turned a working static app into a wall.

Beside that, three smaller ways the app assumed a backend or a local host:

1. A loopback tab (`pnpm dev`) defaulted Host, daemon and MFA endpoints to
   `127.0.0.1:187xx` addresses nothing had said were running, so a dev tab
   looked paired with services that did not exist.
2. `continueAsGuest` and `adoptFederatedIdentity` tried to mint or link a
   principal at an Identity API that was not configured, and pushed a bell
   notice reading "claim auth when Identity is reachable — No Identity API is
   configured." A finished sign-in on a no-backend deployment was reported as
   pending.
3. `index.html` linked its icon as `./icon.svg`, which resolves relative to
   the *route*: every deep link (`/OpenSesame/vault/health`) requested
   `/OpenSesame/vault/icon.svg` and logged a 404.

## Decision

### 1. Sign-in is the first screen, and nothing gates it

An empty device opens on the sign-in form: the compiled-in broker's button
(Google via Shoo), `Continue as guest`, `Skip`, and `Use without an account`.
`setupRequired` is deleted. There is no state of this app in which a person
must answer an operator's question before they can sign in, continue as a
guest, or seal a local vault.

### 2. Setup and join are ceremonies a person opens on purpose

Both survive whole. `Deployment setup` and `Join a session` sit in the foot of
the sign-in form beside the deployment's name, and `SetupScreen` takes a
`road` (`"setup" | "join"`) instead of presenting a fork. Backing out of either
records nothing. The one thing that still opens a ceremony unasked is an
**invite link**: an address bar carrying a claim invite opens the join road
directly, because the link *is* the request (ADR 0079 §7).

ADR 0077 §4's `setup.v1` record survives as the record that an operator
answered — never as a gate. `setupSeams` has no `setupRequired`; a test pins
that.

### 3. No local host is ever assumed

`lib/settings.ts` has one set of defaults for every origin: empty. A local host
is a capability somebody configures — `pages-dev.sh` bakes `VITE_HOST_API` and
`VITE_IDENTITY_API`, a deploy writes `os-runtime-config.json`, an operator
fills Settings → Endpoints or pairs a daemon — and the shipped `127.0.0.1`
addresses remain *suggestions* a loopback tab may offer in a pairing field.
The old loopback/remote split (`localDefaults` / `remoteDefaults`) is gone.

### 4. A sign-in with no identity service is complete, not pending

`guest-auth.ts` reads `identityBase()` first. With no Identity API, a guest is
a local vault and nothing is claimed; a federated sign-in opens the same
ephemeral vault and returns a new outcome, `{ kind: "local" }` — signed in on
this device, with no principal to attach to. No bell notice names a service
that does not exist. Where an Identity API *is* configured, every claim, link
and deferral behaves exactly as ADR 0033 §4 describes.

### 5. Assets resolve from the base path

`index.html` links its icon as `%BASE_URL%icon.svg`, which Vite resolves at
build time, so a deep link no longer requests an icon under its own route.

### 6. Inside the app, a missing backend reads as optional, never as broken

Walking the deployed app as a guest showed the same assumption in four more
places, each fixed the same way — say once, quietly, what a Host would add,
and ask nothing of a Host that is not there:

- **Access** rendered a red "No Identity API is configured" alert on every
  one of its five tabs. Each tab a Host actually serves — grants, requests,
  policies — now shows the `No Host connected` note in place of its panel,
  and asks the Host nothing. See §7: the first cut of this gated the whole
  section, which was wrong.
- **Settings → Connectivity** labelled Host, Identity and this machine
  `Required` and summarised a fresh deployment as `3 need setup`. All three
  are `Optional`; `needsAttention` counts one thing only — an endpoint that is
  *configured and not answering* — and the chip reads `Nothing needs setup`
  (the connectivity bar likewise). A connector's `required` flag had no true
  case left after that, so it is gone rather than left as a field that lies.
- **Sync targets** tried to list targets from a Host that did not exist and
  reported the refusal in red. With no Host it explains and stops.
- **The embedded catalog** started the turso wasm worker on a page that is
  not cross-origin isolated — every first load of a static host, before the
  service worker adds COOP/COEP and reloads — and the worker's
  `SharedArrayBuffer` hand-off was an uncaught `DataCloneError`. It now asks
  `crossOriginIsolated` first and falls back to the in-memory catalog.

And the shell prompt names the person the broker signed in
(`Test Person@guest:/`), not `guest`, when there is no Identity API to mint a
principal — the broker's assertion is the identity.

### 7. A screen is gated on what it actually needs, never on "a backend"

§6's first cut gated the whole Access section on a Host, and that reintroduced
the bug this ADR exists to remove. Two of its five tabs are not the Host's:

- **Resources** is where the Sites live. Its OAuth clients and their sign-in
  events are **Identity-plane** (`/v1/oauth/clients`, `/v1/audit/events`); its
  integration snippets, domain rules and consents are **local to the browser**
  — `site-broker.ts` touches nothing but `localStorage`, and the static-site
  snippet it writes carries the header `OpenSesame static-site auth
  (declarative; no backend)`. The secrets group beside them is the local vault.
  A Host gate hid a feature that advertises needing no backend.
- **Sessions** carries the Identity-plane receipts trail below its Host task
  list. Only the task list is the Host's.

So the rule is not "does this deployment have a backend" but "what does this
panel need, and is that here": `useHostConfigured()` is asked per panel, and
the two mixed panels gate only their own Host half. A group with no Host is
absent the way a group with nothing in it is absent — never a heading over an
error.

The note itself is one component, `NoHostNote`. The first cut wrote it twice
by hand in two voices and left `ConnectedPanel` still saying "Connections could
not be read." on a deployment that had asked nothing of anything — a report of
a failure that never happened, which is the same lie in the opposite direction.

`verify:static` walks every tab of a tabbed section, not only the one it opens
on, and fails on failure-shaped copy (`could not be`, `failed to`, `went
wrong`, `unreachable`) anywhere in the walk — not merely on `role="alert"`,
which is how a quiet hint slipped past the first cut.

## Consequences

- The first screen of a fresh production deployment is a working sign-in with
  Google and a working guest road, verified end to end against the production
  origin in Playwright (first screen, guest into the app and through every
  section, Google authorize request, mocked Shoo token + `session/check`
  return leg landing unlocked, deep-link asset resolution) with zero page
  errors, zero console errors and zero requests to a loopback address. That
  proof is checked in as `apps/pages/scripts/verify-static-origin.mjs`
  (`pnpm --filter @opensesame/pages verify:static`) and is the gate for any
  change on the boot or sign-in path.
- `SetupScreen`'s "This device is empty" fork, the `setup.choose` tutorial
  target and the `setupRequired` gate are removed. `setup.join` moves to the
  sign-in screen (`/unlock`); the `setup.first_run` capability's PWA surface is
  `lib/setup.ts:completeSetup`.
- Existing installs are untouched: a device with a vault or an answered record
  never saw the fork and sees nothing new but the `Join a session` link.
- The guest rule in AGENTS.md §5 gains its natural corollary: a guest or a
  broker sign-in must never be placed behind a deployment ceremony either.
