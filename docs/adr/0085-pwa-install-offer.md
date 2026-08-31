# ADR 0085 — The install offer is a section of the one setup screen, withheld where it is not real

Status: Accepted
Date: 2026-08-31
Supplements: ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md)),
ADR 0077 ([first-run setup ceremony](0077-first-run-setup-ceremony.md)),
ADR 0078 ([an external IdP is the identity service](0078-external-idp-is-the-identity-service.md))

## Context

`apps/pages` has been a genuinely installable PWA since it shipped — service
worker, manifest, offline shell, `vite-plugin-pwa` with `registerType:
"autoUpdate"`. Nothing in the app ever said so. The only ways to install it
were the icon Chromium tucks into the address bar and three taps into Safari's
Share sheet: both are browser chrome rather than ours, neither is
discoverable, and neither gives the app a chance to say why anyone would want
to.

That matters more here than it does for most web apps, for a reason particular
to a vault. Vault items live on the device, in OPFS (`lib/kv.ts`), and a
browser is entitled to evict a tab's storage when the device runs short of
room. An installed app is not treated that way: Chromium grants persistent
storage to installed sites without prompting, and iOS exempts a home-screen web
app from the seven-day eviction it applies to ordinary sites. So the offer is
not a growth nudge — it is the difference between a vault the browser may clear
and one it will not.

The browser API is awkward in three ways that shape everything below:

1. **`beforeinstallprompt` is Chromium's alone**, not standardised, and
   Safari has no equivalent — no API lets a page open Safari's install UI.
2. **The event is single-use and arrives late.** Chromium fires it once, after
   it decides the page is eligible, which is routinely after first paint; and
   once `prompt()` has been called the event is spent.
3. **`prompt()` needs a transient user activation.** It only opens from a real
   gesture, so it can only ever hang off a button the person pressed.

## Decision

### 1. A section on the one screen — not a step, and not a banner

ADR 0078 collapsed setup to **one screen and one question**: who signs people
in, with no stepper, no counter, no skip and no back. Installing does not
reopen that. It is not a second question — it has no wrong answer, it is not
asked before the one that matters, and it does not gate the commit. So it is a
section beneath the ways-in allowlist, in the same `ways__head` voice as "Add a
provider" and "Or an OpenSesame identity service", above the same terminal
`.go`.

Two alternatives were drawn in `docs/design/pwa-install/` and rejected:

- **A dismissible strip above the ceremony** is the amber notice ADR 0077
  deleted, wearing a friendlier hat: a block of colour above the question the
  reader came to answer. An offer that follows you around is a nag, and the
  reader learns to dismiss it unread.
- **Its own step** was the first cut of this change, drawn against the
  two-step ceremony that ADR 0078 then removed. Re-adding a stepper to carry
  one optional offer would undo that decision to buy a heading.

The section is last on the screen because the question comes first, and
because installing is the thing you do once you have decided to keep the
deployment.

### 2. The section is withheld where the browser will not install

`useInstall()` carries one `visible` flag, `InstallOffer` renders nothing
without it, and `KeepIt` withholds the heading on the same value — one answer
from one store, so a heading can never end up standing over a body that
decided to render nothing. This is ADR 0077's own rule applied
again: Unlock is withheld rather than greyed while there is no sealed vault,
because a disabled control still asserts the action exists. A heading standing
over an empty space to explain what your browser will not do is a report the
reader cannot act on.

Because the browser decides late, the section is derived from a hook on every
render rather than captured at mount: it appears the moment Chromium hands over
an offer, below the content the reader is looking at, so nothing above it
moves.

### 3. Five states, and only two of them are an offer

`lib/install.ts` is the single module that touches either browser API:

| State | What it means | What the app shows |
|---|---|---|
| `installed` | running standalone, or `appinstalled` fired | an ok-toned report, no action |
| `prompt` | `beforeinstallprompt` captured | the `.found` card and its in-card action |
| `manual` | iOS/iPadOS — no API exists | the three taps, in the OS's own words |
| `dismissed` | the dialog was opened and no install came of it | one line; the browser's own menu is now the only road |
| `unavailable` | anything else | nothing at all |

`dismissed` exists so the card does not simply vanish when someone says no —
the offer gone with no way back reads as the app having taken the refusal
badly. It is also the one place the app points at browser chrome, because
after a spent event it genuinely is the only way left. It deliberately covers
"declined" and "we could not read the answer" alike, which is why its copy
asserts neither.

### 4. The claim the card makes, the code keeps

The card says an installed app keeps its storage, so the app asks for it —
wherever it observes itself installed, not only on the one road that goes
through our own button. `ensurePersistence()` asks at most once per page load,
never when storage is already persistent, and **never before the browser itself
confirms the install**: Chromium grants it silently to an installed site and
refuses a plain tab, so asking early would burn the single attempt on a refusal
and the retry that would have succeeded would never happen.

The gate is therefore `appinstalled`-or-already-standalone, and deliberately
**not** `installState() === "installed"`. That distinction is the whole of it:
`promptInstall` records the accept synchronously, so the app's own state turns
`installed` a beat before the browser has installed anything. Gating on the
app's state instead of the browser's confirmation looks correct and silently
spends the attempt at exactly the wrong moment — which is how this landed
broken once already, through the card's effect rather than through
`promptInstall`.

Three call sites cover the roads that exist: the `appinstalled` handler
(fire-and-forget, so a storage permission can never hold up the surface),
`main.tsx` after the first render when the page is already standalone (a later
launch of the installed app fires no event and may never mount the card at all
— and asking before first paint would raise a bare permission dialog over a
blank page in browsers that prompt), and the card's own effect for anything
else. The request is a shared in-flight promise rather than a boolean latch, so
a second caller arriving mid-request gets the real answer instead of "somebody
else asked" — which would render "not kept" over a live grant. The installed
card reports what the store actually holds, not what was requested.

Best-effort throughout: a browser without the API, or one that says no, leaves
the vault working exactly as it did.

`promptInstall()` also records the install itself rather than waiting for
`appinstalled`, which is not guaranteed on every platform — without that the
surface would collapse to `unavailable` at the moment the install succeeded.

Every path out of it leaves the surface usable. A spent event or an answer we
could not read lands in `dismissed`, whose copy deliberately asserts nothing
about what happened: telling somebody who has just installed the app that
nothing was installed is the worse error. A `NotAllowedError` is different —
Chromium raises it when it cannot trace the call to a transient user
activation, and does *not* consume the event — so the captured event is kept
and the button stays live, because sending the reader to the browser's own menu
when a second press would have worked is a road that did not need closing.

### 5. One component, two homes

`components/InstallOffer.tsx` renders the ceremony's section and the Settings →
General panel. Setup runs once and can be walked past; Settings is where the
offer lives for good, for the reader who ignored it or opened the deployment on
a second device. The same withholding rule governs the panel, so it is absent
on a browser with nothing to offer.

### 6. It is never an agent surface

`app.install` is registered in `packages/capability-registry` and excluded from
WebMCP citing this ADR. The exclusion is mechanical, not squeamish: the install
dialog opens only inside a transient user activation, so there is no gesture an
agent can supply — and installing an app onto someone's device is a decision
that belongs to whoever owns the device.

## Consequences

- The one-question screen gains a second section that is not the question.
  Accepted, and bounded: it asks nothing, it does not gate the commit, and it
  is absent entirely on a browser that cannot install — which is the only way
  it could have become clutter.
- `apps/pwa`, the thin client shell, ships a manifest but no service worker, so
  browsers do not consider it installable and it gets none of this. Making it
  installable is a separate change.
- Chromium's own mini-infobar is suppressed (`preventDefault`), so on a browser
  where our surface fails to render there is no fallback promotion. The
  address-bar icon remains.
- Nothing about installing reaches `setup.v1`. The record answers one question
  (ADR 0078); whether the app is installed is a property of the device, which
  the browser already knows and reports through `display-mode`.
