# ADR 0136 — Join a session, restored and hardened

- Status: Accepted
- Date: 2026-09-24
- Amends: [ADR 0128](0128-pages-without-host.md) (Pages no longer speaks
  Host) with a second, bounded exception
- Restores: [ADR 0115](0115-front-door-and-connector-directory.md) §1's
  second road, [ADR 0090](0090-static-frontend-complete-without-backend.md)
  §2's invite link
- Builds on: [ADR 0044](0044-claimable-connection-delegation.md) (claimable
  delegation offers), [ADR 0079](0079-shared-sessions-and-scoped-grants.md)
  §7 (joining a public session), ADR 0048 §8 / browser pairing (DPoP-bound
  browser grants)

## Context

Joining is how a person gets into something somebody else runs: an owner
mints an invite (a bearer link plus an out-of-band code, ADR 0044), or runs a
session anyone may ask into (ADR 0079 §7). ADR 0115 put it on the front door
as one of two roads; ADR 0090 made an invite link open it directly.

ADR 0128 then removed every Host-speaking surface from the Pages PWA, and the
join ceremony (`screens/setup/JoinSession.tsx`, `lib/join-session.ts`) went
with it on 2026-09-20. The Host routes it called — delegation present and
claim, public-session discovery and join requests — are still there. A person
holding an invite had no way to accept it from the app, and the tutorial
registry still described a `setup.join` target nothing rendered.

Reviewing the removed ceremony before bringing it back found it would not
have been safe to restore as it was:

1. **A pasted link re-pointed the whole app.** The Host was inferred from the
   invite link's *origin* and written into `settings.hostApi` — on commit and
   as the person typed. Anybody who could get a link pasted could aim every
   later Host call, with its credentials, at a server they chose. (The origin
   was also simply wrong: a Pages or ceremonies link is not served by the
   Host.)
2. **Both halves of the invite sat in one storage entry.** The tab stash kept
   the bearer *and* the out-of-band code together in `sessionStorage`, so one
   read of that entry defeated the two-channel design.
3. **Everything offered was accepted.** `acceptedItemIds` was every item in
   the offer; optional items were never shown as a choice.
4. **Any text was a token.** An unparseable paste was posted as a bearer.
5. **The code was guessed at the Host's expense.** Placeholder and hint said
   "six characters" (`FKM 2RD`); the Host mints eight letters from a
   20-letter alphabet (`BCDF-GHJK`), trims but does not normalize, and burns
   the offer after five misses. A lowercase or undashed code spent an attempt.
6. **Unbounded, redirect-following reads.** Answers from a link-named server
   were `res.json()`'d whole, and a 307 would have replayed the bearer.
7. **A join was resumed without being seen.** After sign-in the stashed
   request was sent automatically, as whichever account had signed in; and
   the setup record was written `joined: true` before anything had joined,
   retiring the front door on an unfinished ceremony.
8. **Errors were prose boxes and a `ready` pill**, which DESIGN.md forbids.

And the Host had since hardened in a way the old ceremony never met: a
browser request carrying an `Origin` must present an approved, DPoP-bound
browser grant (`middleware/browser_grants.rs`), and a grant reaches the
delegation routes only after passkey verification (`host-authorizations`).

## Decision

### 1. The join road returns, as the one Host-speaking ceremony in Pages

ADR 0128's exception list gains the join ceremony. It speaks to exactly one
endpoint — the one the ceremony names — through
`packages/app-core/src/lib/join/*`, and to no other Host route. No Host panel,
note or session gate returns with it, and nothing else in Pages starts
speaking Host.

The front door draws **Join a session** beside **Set up your own** on a
deployment that can finish a join (`mayPairLocalAuthority`: a dedicated or
loopback origin). On a shared-origin demo the road is not drawn — a control
that can only fail is not offered — and an invite link that arrives there
opens the ceremony, which says so and spends nothing.

### 2. Two roads, one ladder each

- **Invite** — where (endpoint, the link or token, and the out-of-band code,
  all checked locally and sent nowhere) → approval → verify → the offer
  (looked up once, chosen item by item, then joined).
- **Open session** — where (endpoint) → approval → verify → which session
  (the endpoint's public listing, or an id) plus a note of at most 280
  characters, counted as the Host counts them → asked.

*Approval* is the endpoint's operator approving this browser: the existing
browser pairing, under a new join-only ceiling (§4), with a code the person
reads to the operator and the account the passkey step will prove shown
beside it, so the operator approves the right principal. *Verify* is the
person proving, by passkey in the Identity window, that they are who the
operator approved (`browser.authenticate`). Together they are what "joining
as an approved user" means on the Host.

Because the Host answers a browser nothing before both, the invite is looked
up — and its one presentation spent — only once this browser can go on to
accept it. That trades ADR 0044's "see the manifest before an account" for
"never spend an invite you cannot accept"; the manifest is still shown, and
still chosen from, before anything is accepted. The approved grant lasts
five minutes (the Host's bound), so the code is asked up front: nothing
after approval waits on the person fetching it.

"Open" means *anyone may ask*. Admission stays the operator's decision
(ADR 0079 §7); the ceremony reports whatever the endpoint answers, so an
endpoint that ever admits on ask needs no change here.

### 3. The rules the ceremony keeps

- **The endpoint is the ceremony's, never the app's.** Nothing reads or
  writes `settings.hostApi`. A link may name its endpoint
  (`#token=…&endpoint=…`); that fills the field in view, and any endpoint
  other than the deployment's own carries a warn mark. Every call takes the
  endpoint explicitly (`pairedHostFetch(endpoint, …)`); verification takes it
  too (`authorizeHost(…, via)`).
- **Strict input.** Only `osc_dlg_<id>.<random>` is an invite; a query-string
  bearer is scrubbed and refused as leaked; the code is normalized to the
  Host's spelling and never sent unless it can be right; a session id must be
  the Host's canonical form.
- **Bearer out of the address bar first.** `bootCore` captures an invite
  fragment and scrubs it before anything paints; a drop link's `osc_clm_`
  fragment is left alone.
- **Present once, from this device.** The looked-up offer is kept for the
  tab (`join.pending.v2`, `sessionStorage`) until the offer ends (or the
  Host's 24-hour ceiling), and reused instead of presenting again. A
  device-wide marker (`join.presented.v1`, `localStorage`) holds a SHA-256
  digest of each presented bearer — never the bearer — and refuses a second
  present from any tab. It is written *before* the request leaves, so a
  lookup whose answer was lost (a dropped connection, a closed screen) is
  never retried into a burn; it is forgotten only when the Host provably
  refused before reaching the offer, or the offer is dead. The ceremony
  cannot be closed while a lookup is in flight. The code is never stored;
  the removed ceremony's `join.invite.v1` entry is erased on sight.
- **An offer belongs to its endpoint and its invite.** Editing either lets
  go of the offer in memory; a held offer for the same invite at another
  endpoint is refused, not re-presented. Its bearer and code are only ever
  sent to the endpoint it was looked up at.
- **Least privilege.** Required items (and what they depend on) are locked
  on; optional items start off; turning one on brings its dependencies, off
  takes its dependents.
- **Least privilege, continued.** Joining with nothing chosen is never
  sent — the Host would refuse it after counting the code.
- **Bounded reads.** 64 KiB and 8 s per answer, ≤ 32 items, strings clipped
  on characters (never inside a surrogate pair), control, bidi, zero-width,
  separator, BOM and tag characters stripped, identifiers held to the Host's
  grammar, dangling dependencies refused whole. Lists are never cut
  silently: past sixteen entries the rest is shown as "+N more", and no
  length makes a (spent) offer unreadable. Each item says how long its
  delegation lasts. Text reaches the page as text only; the invite field is
  masked like any secret.
- **Authority is short and dropped.** The grant lives in memory (≤ 5 minutes
  by the Host's own bound). Finishing, closing, starting over, the screen
  unmounting and signing out all end it; signing out also forgets a pending
  offer. Joining leaves no standing grant.
- **The setup record is written only after a join completes** — a claim,
  or an ask the endpoint answered with `admitted`; a pending ask retires
  nothing — and never overwrites an operator's existing record.
- **An invite arriving in an unlocked tab** (a link pasted into the address
  bar) is still taken out of the address bar, and a notice says it is
  waiting; the ceremony opens at the next lock.
- **Design.** Setup's frame, `.go` commits, `StatusMark` failures beside the
  field they belong to; no error boxes, pills or Host in the copy.

### 4. The Host, narrowly

**A join-only pairing ceiling.** A browser that pairs to join asks for
`host.join` alone. That ceiling reaches no route by itself, and passkey
verification widens it to exactly `host.delegations.claim` (delegation
present and claim) and `host.sessions.join` — never the connection, config,
relay, task or agent authority a sync pairing gains on verification
(`routes/browser_pairings/ceiling.rs`). The operator's approval prompt shows
`host.join`, so what they are approving is legible.

`middleware/browser_user_routes.rs` maps delegation present/claim to the new
`host.delegations.claim` (which every other verified browser also keeps),
and gains `host.sessions.join` for exactly two shapes: `GET shared-sessions`
(the public listing; the handler still refuses anything but
`visibility=public`) and `POST shared-sessions/{id}/join-requests`.
Deciding, granting, the roster, events and opening a session stay off the
map — a browser may ask in, never let itself in.

**Refusals are readable.** The browser guard now answers a refusal with the
CORS headers of the (already validated, pairable) origin, so the page can
tell "verify again" from "offline" instead of seeing a network failure.

**The operator's CLI approves again.** `opensesame` posted pairing decisions
to `/pair/decision`, which the gateway never routed; it now posts to
`/api/v1/browser-pairings/decision`, the route the gateway serves.

### 5. Parity

`delegations.claim` and `shared_sessions.join_request` gain PWA surfaces
(`lib/join/client.ts:claimInvite`, `:askToJoin`) under `access.authority`;
both are mapped to the `setup.join-session` support goal.

## Consequences

- An invited person can join from Pages again, on a deployment that runs its
  own origin and endpoint. The public GitHub Pages demo still cannot, by
  design (it is a shared origin); the ceremony says so and spends nothing.
- Joining needs a remote Identity service the endpoint trusts, for the
  passkey step, and an operator who knows the joiner's principal (shown on
  the Approval rung when the joiner is signed in). Without them the ladder
  stops at the rung that needs them and says so.
- **Approving a browser is not temporary on the Host.** The pairing decision
  provisions the approved principal into the organization as a Member
  (`provision_native_role`). The browser's own grant is short and dropped
  by the ceremony, but the membership is the operator's to manage like any
  other; on the open road the asker is a Member before they ask.
- A returning device (front door retired) reaches join through an invite
  link; there is no quiet foot link (AGENTS.md §5).
- The five-minute grant is the Host's; a person who pauses longer between
  approval and joining is sent back to approval.
- Follow-up, not decided here: whether an open session should admit on ask
  (as an observer, holding nothing) is a Host policy change and needs its own
  ADR.
