# ADR 0162 — Device-mode receipts, inbox and local notifications

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR 0160](0160-the-device-identity-plane-is-declared.md) (the
  device is the Identity plane; this ADR is the `audit`, `requests` and
  `notifications` families it left for later),
  [ADR 0084](0084-external-authorization-notifications.md) (where a person is
  told is not what it takes to approve),
  [ADR 0111](0111-browser-local-access-requests.md) (the sealed local request
  and its passkey-bound decision),
  [ADR 0015](0015-audit-vs-diagnostic-logging.md) (the audit trail and its
  allowlist, which the sealed Access audit follows),
  [ADR 0130](0130-operator-controlled-capability-composition.md),
  [ADR 0134](0134-item-type-marketplaces-and-settings-files.md),
  [ADR 0149](0149-nothing-stored-in-the-clear.md),
  [ADR 0157](0157-logs-and-events-carry-no-secrets.md),
  [ADR 0158](0158-settings-rows-act-or-are-absent.md)
- Updates: ADR 0160 §3 (the `notifications` row no longer reads "none yet")

## Context

ADR 0160 made the device the Identity plane with no Identity API and said
which families it serves. Three of them were still empty, and the product
showed it. Access › Sessions drew a Receipts panel that read `/v1/audit/events`
and the device answered `[]` for every vault, so a person who signed an
application in and revoked it saw "No receipts yet." A request raised for them
sat in Access › Requests with nothing to say it was there: no mark, nothing
when the tab was in the background. And Settings › Capabilities offered "Push
notifications" and "Notification routing", whose every road is an Identity
API's, to a device that had none, with a summary that names one.

The requirement is that Pages act as its own identity provider with no
external service. That has to include the parts a person uses day to day:
what was decided for them, what waits for them, and being told. This ADR
records what the device does for each, and what it will not.

## Decision

### 1. Receipts are the vault's own, appended when a decision is made

Access › Receipts reads `GET /v1/audit/events` through the Identity transport,
as it always did. On the device that route (the `audit` family, owned by
`identity.local-iam`, which is the one owner ADR 0160 §4 allows) now answers
the receipts this device wrote (`lib/device-receipts.ts`,
`lib/device-identity-inbox.ts`).

A receipt is not a second ledger. It is an event appended to the sealed Access
audit (`lib/local-access-audit.ts`, ADR 0015), the same file connector grants
already use. Nine event names are added to that file's frozen set, written by
one table (`RECEIPT_KINDS`) and nowhere else:

| Event | When | Outcome |
| --- | --- | --- |
| `access.request.created` | a local access request is raised | succeeded |
| `access.request.approved` / `.denied` | its passkey-bound decision settles | succeeded / denied |
| `access.request.withdrawn` | a custodian withdraws it | succeeded |
| `access.sign_in.granted` | an application redeems its code and holds a grant | succeeded |
| `access.sign_in.denied` | the person presses Deny in the consent window | denied |
| `access.sign_in.revoked` | the grant ends (the application or the person revoked it) | succeeded |
| `access.siop.approved` / `.denied` | a Self-Issued sign-in is approved or refused | succeeded / denied |

- **Append-only, sealed, bounded.** A newer event is written ahead of the
  older ones and none is edited. The file is sealed under the vault (ADR 0149)
  and keeps the newest 256 events, as it did, with the standing connector
  revocations it already protects. A receipt that ages out is gone; this is a
  trail the person reads, not an archive.
- **Value-blind.** An event names ids and a closed enum: the application (its
  id is the event's target), the local principal, the approver, the
  organization and the request id (`authReqId`). Never a scope, a reason, a
  callback address, a state, a nonce, a code, a grant id or a credential. The
  audit's allowlist drops any other key (ADR 0015) and the tests assert what
  the metadata may and may not hold. Names are looked up from the same sealed
  directory when a receipt is *shown*, so a renamed application reads under
  its new name and the ledger holds no free text.
- **After the decision, never in its way.** A receipt is written once the
  decision it records has committed, and a failure to write it never undoes
  or blocks that decision: a person who approved something must not be told
  they did not because a ledger was full. That one failure is the only thing
  `recordReceipt` swallows. A decision that was *refused* (a stale request, a
  locked vault, a failed redemption) is not a receipt.
- **No network, no server fact.** The panel reads the vault's trail while
  offline, says "Reading receipts…" rather than "Asking Identity…", and its
  failure sentence names no service. A remote plane keeps every word it had
  and still needs a network.
- **A receipt is the person's own.** `identity.local.receipts.read` is a
  `route:/access` PWA capability with no agent surface: the trail records which
  requests were refused, and an agent that could read it could learn what to
  route around (ADR 0065; the exclusion cites this ADR).

### 2. The inbox is what waits, shown where it is decided

What waits for a person is a sealed local access request (ADR 0111) that has
not been decided and has not lapsed. It was always decided in Access ›
Requests with the person's passkey bound to the request, the decision and the
approver, and it still is. `lib/device-inbox.ts` reads those records and
returns each as the closed contract `{ kind: "local-access", action: "review",
ref, expiresAt }` — no application, no scope, no reason, no callback. That is
the whole of what an inbox row, a count, a notification or the plane's
`GET /v1/authorization-requests` may say.

- **Read-only at the plane.** The device's `requests` family answers that list
  to its own session and refuses everything else: `POST` is 405 (a decision is
  a ceremony, not a route, so the plane cannot be talked into settling one) and
  a hosted request addressed by id is 404 (the device holds none).
- **A mark where it is decided.** The Requests tab of Access carries a warning
  glyph naming how many wait (a `StatusMark`, never a count in words), and it
  follows what changes it: a request raised or decided here or in another tab,
  the window returning to focus, and the moment the soonest one lapses. It is
  zero while the inbox cannot be read; a count the page cannot stand behind is
  not drawn.
- **Another tab is heard.** `notifyLocalIamChange` also posts a content-free
  hint on a same-origin `BroadcastChannel`; a receiving tab re-reads its own
  sealed records. The message is never read (any script on the origin can post
  one), so the worst it can do is one extra read. A change made in this tab is
  not announced to this tab's other-tab listeners.
- **A sign-in's consent window is not queued here.** An application sign-in
  holds a message port to the relying party's window, which no other tab can
  answer, and the person is already in front of it. It is decided in its own
  window and recorded as receipts (`sign_in.granted`, `sign_in.denied`,
  `sign_in.revoked`); it is not a row. This is a limit of that ceremony, not an
  oversight, and a design that queued it would make the approval depend on a
  second tab the relying party cannot see.

### 3. `notifications.local` tells the person, on this device, with no service

An optional capability, with its own Settings › Capabilities section ("Local
notifications"; ADR 0130's checklist: a descriptor with
`identity.notification.local.manage`, the module
`modules/notifications.local/runtime.ts`, classification and ownership rules,
the registry entry, and a profile fixture that proves its absence).
`minimal-local` resolves to zero optional capabilities, and the capability
depends on `identity.local-iam`: with it off there is nothing to be told.

A watcher runs per unlocked vault (an unlock effect) and reads the inbox when
something changes. It rings the places the person and the device allow:

- **In-app** — the bell in the tray: one status notice, "Request waiting" or
  "N requests waiting", with a key that opens Access › Requests. It follows
  the inbox and clears when none wait.
- **Tab title and badge** — `(N)` before the title, and the Badging API where
  the app is installed.
- **System** — a `Notification` for a request this tab had not seen, only when
  the tab is in the background and the change came from elsewhere. Never at
  start-up and never while the person is looking.

There is **no server, no push service and no egress**: a notification is the
browser's own, the document's own title, and a message between this origin's
tabs. The browser's `notifications` permission is asked for when, and only
when, its key in the panel is pressed.

**Routing is a local transport and obeys ADR 0084.** Policy and preference are
different questions. *Policy* is what this device allows: the in-app place
always; the tab's mark where there is a document; a system notification only
once the browser has granted permission. The *preference*
(`settings/capabilities/local-notifications.json`, sealed in the vault, a
closed schema with no field that could widen anything) is an ordered list of
places. `effectiveDestinations` is the preference narrowed to policy: it may
reorder and narrow what policy allows, it can never add a place policy refused,
and the in-app place is never turned off (a file that leaves it out is refused,
not quietly corrected). No place but the in-app ceremony may carry a decision:
the tab mark and the system notification are doorbells (`notify`), and a click
arrives at Access › Requests and decides nothing on the way. The assurance a
request needs is not an input anywhere in this path, so no preference can lower
it.

**A notice carries `{ kind, action, ref }` and its words are the same for
every request.** It never carries an application's name, a scope, a reason or
an address. What a click reads back it reads through the same closed parser,
and navigation always goes to the constant route, never to a field of the data.

**The `notifications` family.** ADR 0160 expected local notifications to
register it. They do, for one route: `GET /v1/notification-channels` answers
every channel kind with only `in_app` configured, so a panel written against
the Identity API's listing reads the device's truth. The routing document,
bindings and effective route are the Identity API's and are left unserved.

### 4. Device-mode copy says nothing it cannot do

With no Identity API named, Settings › Capabilities draws neither "Push
notifications" nor "Notification routing": each one's only road is an
Identity API's, so a switch for it changes nothing a person can see and its
summary would describe a service that is not there. That is ADR 0158's rule,
decided by what is configured rather than by what is built (`NEEDS_IDENTITY_API`
beside `NO_SURFACE`), and it has the same exception: a plan that already
approves one keeps its switch, so it can be turned off and is never stranded.
With an Identity API the section is drawn as it was, and the Push row (PR
#666's) is untouched.

The Settings › General Push row is *not* withdrawn for a device that holds a
push subscription: it is drawn there so the subscription can be ended, and its
"On" is a state the person can change. That is the only place "push" appears
with no Identity API, and only while the browser holds one.

## Non-goals

- **No push, relay or external channel on the device.** Slack, Teams,
  Telegram, SMS, a webhook and Web Push through a relay each need a server in
  the world (ADR 0160 §3). The device offers the in-app places only.
- **No decision from a notification**, from the plane, or from a preference.
- **No queued sign-in consent** (§2), no cross-device inbox, and no
  notification for a request raised on another device: the principal is not
  portable yet (ADR 0160 §5).
- **No signed receipts.** The trail is sealed and append-only on this device;
  it is not a proof to a third party. Nothing here is an OpenID Provider
  (ADR 0160 §10).
- **The system notification may not appear** where a browser will not
  construct one from a page (a phone's wants a service worker). The bell and
  the tab's mark still do; no fallback registers a push subscription.

## Consequences

- A device with no backend shows, in Access › Sessions, the sign-ins and
  decisions it actually made, named by application, and shows a request waiting
  on the Requests tab and the bell, in this tab or another.
- The Access audit file now holds decisions as well as connector grants, in one
  newest-first list capped at 256. A busy device ages receipts out sooner.
- `local-access-requests.ts` and `local-authorization.ts` each record a
  receipt after their decision; both were at the module budget and the
  request summary moved to `local-request-summary.ts` to stay under it.
- A Pages build with `notifications.local` approved adds the module, the panel
  and the watcher as lazy chunks; the bootstrap does not import it, and a build
  that leaves it out contains none of it.
- ADR 0160's `notifications` row is no longer "none yet", and its consequence
  that Receipts needs a held session now holds only against a remote plane: on
  the device Receipts reads the vault's own trail and needs no session.
- A person who has turned on lock-on-hide locks a backgrounded vault, and a
  locked vault has no watcher, no mark and no notification: nothing rings for
  a vault nobody has open. That is the lock doing its job, not a gap.
- Before and after, from two real builds, at phone and desktop width:
  [`docs/evidence/2026-10-04-device-inbox/`](../evidence/2026-10-04-device-inbox/README.md).

## Verification

- `device-receipts.test.ts`, `device-inbox.test.ts`,
  `device-identity-inbox.test.ts`, the receipt cases added to
  `local-access-requests.test.ts`, `local-authorization.test.ts`,
  `siop-authority.test.ts` and `local-issuer-channel.test.ts`, and
  `local-iam-events.test.ts` pin what each decision writes, what a receipt may
  name, what the plane answers and refuses, and the cross-tab hint.
- `lib/local-notifications/*.test.ts` pin the places, the narrowing, the
  preference's refusals, the notice's contract and the watcher's rules (who is
  rung, when, and what takes the marks down), and the module's tests pin its
  absence from `minimal-local`.
- `verify:device-inbox` drives a backend-less vault at desktop and phone
  width, keyboard only: a request raised, shown in the inbox and on the tab,
  approved with the passkey, its receipt in Sessions, an application signed in
  and revoked, a refusal, a notification firing in a second tab, and a locked
  vault answering 423 and showing nothing.
- `verify:static`, `verify:mobile`, `verify:local-iam`, `verify:siop`,
  `verify:device-identity` and `verify:keyboard` run unchanged beside it; `verify:device-inbox`
  is its own CI job, so the bundle job's timeout is untouched, and it is
  required through the Bundle budgets check.
