# ADR 0162 — Device-mode receipts, inbox and local notifications

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR 0160](0160-the-device-identity-plane-is-declared.md) (the
  device is the Identity plane; this ADR is the `audit` and `requests`
  families it left for later),
  [ADR 0084](0084-external-authorization-notifications.md) (where a person is
  told is not what it takes to approve),
  [ADR 0111](0111-browser-local-access-requests.md) (the sealed local request
  and its passkey-bound decision),
  [ADR 0015](0015-audit-vs-diagnostic-logging.md) (the audit trail and its
  allowlist, which receipts follow),
  [ADR 0130](0130-operator-controlled-capability-composition.md),
  [ADR 0134](0134-item-type-marketplaces-and-settings-files.md),
  [ADR 0149](0149-nothing-stored-in-the-clear.md),
  [ADR 0157](0157-logs-and-events-carry-no-secrets.md),
  [ADR 0158](0158-settings-rows-act-or-are-absent.md)
- Updates: ADR 0160 §1 and §3 (the `notifications` row: the device serves no
  such family), and its Receipts consequence (no held session on the device)

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

A receipt is an event in a sealed file of its own (`config/device-receipts`,
`lib/device-receipts-store.ts`), apart from the Access audit
(`config/access-audit`, ADR 0015). That is deliberate. The Access audit also
holds the standing connector revocations a person made, which `ensureConnectorShares`
and the GitHub card read so that a grant they took away stays away. It keeps
the shape and the event names every build has written, so an older build (a
stale tab through a service-worker update, a rollback, a second tab) still
reads it, and a receipt can neither crowd one of those revocations out of its
cap nor make an older reader call the file corrupt. A build that reads the
Access audit tolerates an event name it does not know, keeps it in place when
it rewrites the file, and never hands it to logic that does not know what it
means; and where the audit cannot be read at all, those two readers answer as
if the grant had been revoked and issue nothing (fail closed), where they once
answered as if there were no history. Fourteen event names, written by one table
(`RECEIPT_KINDS`) and nowhere else:

| Event | When | Outcome |
| --- | --- | --- |
| `access.request.created` | a local access request is raised | succeeded |
| `access.request.approved` / `.denied` | its passkey-bound decision settles | succeeded / denied |
| `access.request.withdrawn` | a custodian withdraws it, or the window that raised it ends first | succeeded |
| `access.sign_in.granted` | an application redeems its code and holds a grant | succeeded |
| `access.sign_in.denied` | the person presses Deny in the consent window | denied |
| `access.sign_in.revoked` | the grant ends: the application ended it, or the person did in Access › Sessions | succeeded |
| `access.session.revoked` | a session is ended, by its holder signing out or by a custodian | succeeded |
| `access.siop.approved` / `.denied` | a Self-Issued sign-in is approved or refused | succeeded / denied |
| `access.drop.opened` | a drop's claim is presented | succeeded |
| `access.live.granted` | the owner lets a guest into a live session | succeeded |
| `access.share.granted` / `.revoked` | a person grants or revokes a local share | succeeded |

- **Newest first, never edited, sealed, bounded.** Receipts are ordered by when
  each was decided, wherever it was held in the meantime, and none is edited:
  one that waited through a failed write takes the place its time gives it, not
  the front. The file is sealed under the vault (ADR 0149) and keeps the newest
  256. A receipt that ages out is gone; this is a trail the person reads, not
  an archive.
- **Gone with the vault.** The trail, its pending list, the audit of connector
  grants and the notification preference are all in the list of files wiped
  when a vault is destroyed (`tombSessionKeys`), because the key that sealed
  them is gone with it. A guest that ends, or a vault deleted and made again in
  the same tomb, therefore starts with a trail it can read and record to; left
  behind, the old ciphertext would make the new vault's trail unreadable and
  every standing connector grant withheld as if revoked.
- **Value-blind.** An event names ids and a closed enum: the application (its
  id is the event's target), the local principal, the approver, the
  organization and the request id (`authReqId`). A drop names its claim id, a
  live grant names the session and the guest's request id, and a share names
  the share, the principal and the resource — never the resource's label. Never
  a scope, a reason, a callback address, a state, a nonce, a code, a bearer, a
  link, a guest's name, a grant id or a credential. The audit's allowlist drops
  any other key (ADR 0015) and the tests assert what the metadata may and may
  not hold. Names are looked up from the same sealed
  directory when a receipt is *shown*, so a renamed application reads under
  its new name and the ledger holds no free text.
- **After the decision, never in its way, and not silently late.** A receipt
  is written once the decision it records has committed (one written before
  would be false if the tab died in between), and a failure to write it never
  undoes or blocks that decision: a person who approved something must not be
  told they did not because a ledger was full. A receipt that could not be
  written is held, in memory and in a small sealed pending list
  (`config/device-receipts-pending`), and is written ahead of the next
  receipt, when the trail is next read, and when the vault is next opened (an
  unlock effect of Access and of Browser-local IAM, so it runs whichever of the
  two is in the plan). What waits in memory is bounded to what the trail itself
  could hold, newest kept. The audit route says how many still wait, not
  counting any already written to the trail, and Receipts draws a warning mark
  ("N receipts not written yet") until none do. A decision that was *refused*
  (a stale request, a locked vault, a failed redemption) is not a receipt. The
  guarantee is worded to what is true: a receipt is never false, it is
  appended and never edited, and one that is late is never silent once it is
  known. What no outbox short of sharing the decision's own file could close
  is a tab that dies between the decision's commit and the first attempt to
  write it, milliseconds later; there the receipt is simply absent.
- **A trail this build cannot read is replaced.** A trail that is damaged,
  sealed under a key the vault no longer has, too large, or in a format this
  build does not know could never take another receipt, and every one after it
  would wait for ever. It is replaced by a trail that begins with one marker,
  "Receipts were replaced" (`access.receipts.reset`), and what was waiting is
  written behind it; the bytes nothing could read are gone. A file that is out
  of reach, a locked vault or a full disk, is not this: that is retried, and
  nothing is replaced.
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
  not announced to this tab's other-tab listeners. The hint is coalesced where
  it arrives (`local-iam-events.ts`): heard once at once, and once more at the
  end of a 200 ms window if more came inside it, however many. Every panel that
  re-reads on it (the inbox count, Receipts and the names it shows, the
  requests list, the watcher) inherits that one bound, so a script on this
  origin posting in a loop cannot make them read as fast as it can post.
- **A sign-in's consent window is not queued here.** An application sign-in
  holds a message port to the relying party's window, which no other tab can
  answer, and the person is already in front of it. It is decided in its own
  window and recorded as receipts (`sign_in.granted`, `sign_in.denied`,
  `sign_in.revoked`); it is not a row. From the moment that window raises its
  request to the moment it is decided, the request is *in flight*
  (`isSignInInFlight`): the inbox does not list it, the count does not include
  it, the watcher does not ring for it, and Access › Requests does not offer it
  for a decision that would only make the window's own fail. If the window
  ends first (a malformed message, a closed popup, a refused passkey) it
  withdraws what it raised, and that withdrawal is a receipt. When the vault
  locks the window cannot withdraw anything, since a locked vault cannot be
  written: the request is left to lapse, at most five minutes, and is listed
  nowhere in the meantime. A Deny pressed after the window has begun refusing,
  or an approval attempted while a refusal is being written, is turned away,
  so one window gives one answer. This is a limit of that ceremony, not an oversight, and a design
  that queued it would make the approval depend on a second tab the relying
  party cannot see.
- **A caller bound to no vault reads none.** A session minted with no vault
  behind it, or whose key could not be read, is bound to no tomb (ADR 0160
  §5) and is answered 403 on both routes, never handed whichever vault happens
  to be open; no bearer at all is 401.

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

**No `notifications` family on the device.** ADR 0160 expected local
notifications to register it. They do not: nothing in Pages asks the plane for
a notification channel listing, so a route that answered one would be a row in
a table for its own sake. The device's channels are this capability's own, set
in its own panel and file, and `identityServes("notifications")` stays false.
The registry still lets a capability register the family the day a panel reads
it.

**Defaults, and what a failure may not turn on.** A vault that has never
chosen gets the bell and the tab's mark, which ring only inside a page the
person already has open. The system doorbell is never a default, even where
the browser already holds the permission: it is added by the person's press of
the panel's key, which is also the one place permission is asked. Reading
fails toward quiet: a preference file this build cannot read is the bell
alone, and the watcher keeps the last preference it read rather than fall back
to anything wider when the next read fails. The watcher also keeps what it has
announced when an inbox read fails, so the next good read does not ring the
same request again; it survives a delivery that throws; and it reads one at a
time, folding any number of triggers that arrive meanwhile into one more read,
so a script on this origin posting to the channel cannot queue a backlog. A
read that fails is tried again after 1, 2, 4 and 8 seconds and then not until
something changes, each good read starting the count over; the inbox count on
the Requests tab does the same, and only its newest read counts, so a read that
was overtaken sets neither a count nor a timer.

**Where the capability is offered.** Personal and Family offer only the local
functions of ADR 0153 and none of Identity, Connections, Access or Browser-local
IAM, so they offer neither `identity.local-iam` nor, which depends on it,
`notifications.local`; Homelab, Organization and Custom offer every optional
capability and so offer both. That is intended: a device with nothing that
raises a request has nothing to be told about, and a preset that wants it adds
IAM first. `presets.test.ts` pins that `notifications.local` is offered exactly
where `identity.local-iam` is.

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
- Receipts are their own file, capped at 256 apart from the Access audit, so a
  busy device ages receipts out without touching a connector revocation, and an
  older build reads the audit exactly as before.
- `local-access-requests.ts`, `local-authorization.ts`, `local-grant-admin.ts`
  and `local-sessions.ts` each record a receipt after their decision, after the
  lock is released; the first two were at the module budget and the request
  summary moved to `local-request-summary.ts` to stay under it.
- A Pages build with `notifications.local` approved adds the module, the panel
  and the watcher as lazy chunks; the bootstrap does not import it, and a build
  that leaves it out contains none of it.
- ADR 0160's `notifications` row reads "never" on the device, and its
  consequence that Receipts needs a held session now holds only against a
  remote plane: on the device Receipts reads the vault's own trail and needs no
  session.
- The two readers of the Access audit that decide whether to issue a standing
  connector grant now fail closed. A device whose audit cannot be read is
  issued no standing connector grant until it can be, where it used to be
  issued all of them, including the ones its person had revoked.
- A person who has turned on lock-on-hide locks a backgrounded vault, and a
  locked vault has no watcher, no mark and no notification: nothing rings for
  a vault nobody has open. That is the lock doing its job, not a gap.
- Before and after, from two real builds, at phone and desktop width:
  [`docs/evidence/2026-10-04-device-inbox/`](../evidence/2026-10-04-device-inbox/README.md).

## Verification

- `device-receipts.test.ts` pins the fourteen kinds, what a receipt may name, that
  the Access audit is never touched (byte for byte), that a receipt which could
  not be written is held, counted, sealed, survives a reload and is written
  once, and that nothing waits in memory for a shut vault.
  `sharing-receipts.test.ts` and `live/grant-receipt.test.ts` pin that a drop
  open, a live grant and a person's share name ids only.
  The receipt cases in
  `local-access-requests.receipts.test.ts`, `local-authorization.receipts.test.ts`
  (an application's revoke and the person's, and a session ended),
  `local-grant-admin.test.ts`, `siop-authority.test.ts` and
  `local-issuer-channel.test.ts` pin what each decision writes.
- `device-receipts.failure.test.ts` pins the order a held receipt is written in,
  that one already in the trail is not counted as waiting, that what waits is
  bounded, and that a trail this build cannot read (damaged, newer format,
  sealed under another key) is replaced by a marker and the next receipt is
  written, while one that is only out of reach is not. `vault/tomb-wipe.test.ts`
  and the delete-and-recreate case in `local-access-bootstrap.test.ts` pin that
  a destroyed vault's files go with it and the next vault in its tomb reads,
  records and is granted its connectors.
- `local-access-audit.test.ts` pins that an event name this build does not know
  is kept in place and never returned; `local-access-bootstrap.test.ts` and
  `github-installation-access.test.ts` pin that an unreadable trail issues no
  standing grant.
- `device-inbox.test.ts`, `device-identity-inbox.test.ts` and
  `local-issuer-channel.signin.test.ts` pin the inbox rows, that the plane
  answers a caller bound to no vault 403, that a sign-in in its own window is
  neither listed nor counted and is withdrawn when the window ends, and that
  Deny pressed twice is one receipt and an approval is refused while a refusal
  is being written. `use-once.test.ts` pins the same for the
  Self-Issued page.
- `local-iam-events.test.ts` pins the cross-tab hint and that a flood of it is
  heard at most once now and once at the end of the window.
- `lib/local-notifications/*.test.ts` pin the places, the narrowing, the
  default preference (no system doorbell), the preference's refusals, the
  notice's contract and the watcher's rules (who is rung, when, what takes the
  marks down, what a failure does not do, that a flood is one read, and that a
  failed read is retried a bounded number of times, later each time, in
  `watch.retry.test.ts`; `use-inbox.test.tsx` pins the same for the count and
  that an overtaken read leaves no timer).
  `modules/notifications.local/runtime.test.tsx` pins the capability's absence
  from the `minimal-local` and `family-local` plans and that it asks the plane
  for nothing; `presets.test.ts` pins where the presets offer it.
- `verify:device-inbox` drives a backend-less vault at desktop and phone
  width, keyboard only: a request raised, shown in the inbox and on the tab,
  approved with the passkey, its receipt in Sessions, an application signed in
  and revoked, then ended by the person in Access › Sessions, a refusal, a
  notification firing in a second tab and none in the tab in front, nothing
  asking for the notification permission at load, focus landing where the bell
  and a notification click send the person, and a locked vault answering 423
  and showing nothing.
- `verify:static`, `verify:mobile`, `verify:local-iam`, `verify:siop`,
  `verify:device-identity` and `verify:keyboard` run unchanged beside it;
  `verify:device-inbox` is its own CI job, so the bundle job's timeout is
  untouched, and it is required through the Bundle budgets check.
