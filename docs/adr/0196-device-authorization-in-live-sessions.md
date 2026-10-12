# ADR 0196 — Device authorization in live sessions: a terminal uses the connections an open tab holds

- Status: Accepted
- Date: 2026-10-12
- Amends: [ADR 0150](0150-live-sessions-browser-to-browser.md) §2 (a session
  may share nothing of the vault and exist for devices alone), §3 (a request
  names who is asking and how they will arrive), §5 (a second vocabulary
  crosses the channel)
- Builds on: [ADR 0167](0167-nats-live-session-route.md) (the owner's NATS
  server carries a seat, sealed end to end),
  [ADR 0005](0005-authority-handle-connectionref.md) (callers hold a handle,
  never the credential), [ADR 0065](0065-agent-surface-parity.md) (agent
  surfaces), [ADR 0130](0130-operator-controlled-capability-composition.md)
  (an optional capability), [ADR 0157](0157-logs-and-events-carry-no-secrets.md)
  (nothing secret in a log or an event), [ADR 0158](0158-settings-rows-act-or-are-absent.md)
  (a row acts or is absent), [ADR 0192](0192-model-keys-and-token-exchange.md)
  (§9: no channel yet for another process to present authority)
- Standards: RFC 8628 (OAuth 2.0 device authorization grant)

## Context

The connections an operator configures in the PWA — a GitHub key, a Linear
sign-in, an S3 bucket, an MCP server — are sealed in that browser. A terminal
on the operator's machine, or a teammate's, has no way to use them: the Host
plane's `login --flow device` talks to a server, and a static origin has none
(ADR 0090). A live session already makes the open tab a server for the people
who hold its link (ADR 0150 §2), and over a NATS relay a seat needs no WebRTC
at all (ADR 0167). What was missing was the part that makes a terminal safe to
let in: a way for it to *ask*, for the operator to *decide* with the terminal's
own code in front of them, and for the tab to make the calls on its behalf so
that the terminal never holds a credential.

Two things were true of the existing session and had to stay true. The link is
a bearer: whoever holds it can ask to join, and an open session lets them in.
And a seat sees the vault the owner chose to share. A terminal given the link
must neither see that vault nor be handed authority by the link alone.

## Decision

### 1. A seat is a person's or a device's, and arrives by a peer route or a relay

A join request (the sealed `osl-request.` code) gains two optional fields. A
reader treats an absent one as the default, so a request without them is still
an ordinary one; a browser joining as a person says both anyway, which an owner
from before them ignores, as it ignores any key it does not read:

- `kind`: `person` (default) or `device`. A **person** is shown the shared
  items of the owner's vault. A **device** is shown none: it is sent an empty
  catalog, and its `reveal`, `copy` and `edit` are refused.
- `route`: `peer` (default) or `relay`. A **relay** request makes no WebRTC
  offer (`offer` is empty and a request that carries one is refused) and the
  owner's reply carries no answer (`answer` is empty and the reply must say
  `relay: "nats"`). The seat is carried over the owner's NATS server alone,
  sealed end to end with the pairing's keys (ADR 0167 §5). A terminal has no
  WebRTC; this is the road it takes.

The owner seats what it can serve and says so at once: a `device` request in a
session that does not let devices ask is `no-devices`, and a `relay` request
with no relay to carry it is `no-relay`. Neither is a miss, and neither
changes the seat cap or the lock. Admission is otherwise unchanged: an invite
session shows the owner the device's name before they let it in, an open
session lets it in as it asks.

### 2. Asking is RFC 8628, over the seat's sealed channel

The device authorization grant maps one to one onto four messages (`dev.*`,
`device-messages.ts`), each read as strictly as the rest of the vocabulary:

| RFC 8628 | Here |
|---|---|
| device authorization request | `dev.begin` (`want`: connection ids the device would like, a hint) |
| device authorization response | `dev.code` (`deviceCode`, `userCode`, `expiresIn`, `interval`) |
| user interaction at the verification URI | the owner's tab: the request is listed with its user code |
| device access token request | `dev.poll` (`deviceCode`) |
| `authorization_pending`, `slow_down`, `access_denied`, `expired_token` | `dev.auth` with that `state`, and `granted` for the success |

Differences, each deliberate: there is no verification URI, because the owner
is already looking at the tab that is the authorization server; the owner's
answer is also **pushed** to the device the moment it is made, with polling
kept as the fallback for a lost frame; the default wait is five seconds, a
poll that comes sooner is told `slow_down` and five more seconds, up to
sixty; a request lapses after ten minutes or with the session; a seat holds
one request at a time, may start a new one no sooner than two seconds after
its last, and the session holds at most eight.

The **user code** is eight letters from the alphabet ADR 0044 codes use, in
two groups of four, unique among the session's open requests. It is not typed
anywhere: the owner *compares* it with the device's screen, which is what
tells two requests from two devices apart. The **device code** is a
128-bit handle only the device holds; the owner's screen never receives it.

### 3. The owner decides, and the grant is the seat's, not a bearer

Allowing a request is a choice of connections from those this app can lend and
a duration (15 minutes to 8 hours, never past the session). The device's
`want` is a hint and pre-selects nothing. Letting a process use saved
connections is handing out authority, the same kind of act as a share or a
model key, so it meets the same check: `allowDevice` (`device-allow.ts`) runs
the vault's `manage_grants` check — its operator rule and its duress ceilings —
and `DeviceBroker.approve` takes the proof it yields (ADR 0178), so a caller
that did not pass it cannot compile (`device-approval.mistakes.ts`). A refusal
is a mark on the sheet and nothing is allowed. The grant:

- is **bound to the seat**. The seat's sealed channel is what authenticates
  the device, so there is no token to copy out, log or replay from another
  seat. A device that reconnects is a new seat and asks again.
- ends when it lapses, when the owner revokes it, when the seat goes and when
  the session ends. A grant replaced by a newer approval for the same seat
  replaces the old.
- covers exactly the connections chosen. A connection outside it, one that
  never existed and one that has since gone are all `access_denied`: a device
  learns nothing about the connections it was not given.

Allowing and revoking are the owner's act on their own screen; no agent
surface reaches them (ADR 0065 exclusions in
`packages/capability-registry/src/shared-sessions.ts`).

### 4. Using a grant is brokered, closed and value-blind

A device names a connection and an operation (`dev.call`); the owner's tab
makes the call and returns labelled lines (`dev.result`). The session knows
the connections only through a port (`connection-port.ts`) that the capability
that owns them binds while it is active (`connectors.external`, in Pages);
with that capability off the port offers nothing and nothing about devices is
drawn. What the port offers is a **closed table of read-only operations**
(`session-connections.ts`), never inferred from what a driver happens to
accept:

- `provider.read` — the account the credential belongs to, verified;
- `provider.repositories.read` (GitHub, Codeberg), `provider.objects.read`
  (S3), `provider.guilds.read` (Discord, with the permission);
- `mcp.tools.list` for an MCP server;
- `issues.list`, `projects.list`, `teams.list` for Linear.

Not on the table: `provider.secret.read` and anything whose name says it reads
a secret (the session refuses such a name whatever a port lists), calling an
MCP tool (which can act on the owner's account), and every write. The port
reads the stores afresh on each call, so a connection removed or needing
authorization again stops being offered and a call already granted to it is
refused.

What comes back is **rebuilt field by field**: an id, a label and, if it is an
https address, a link. Whatever else a driver's result held — a schema, a
value it keeps for its own use — is not copied. Text is cleaned of anything
that draws nothing or draws over its neighbours, because a terminal will print
it; lengths and counts are bounded; the whole answer is cut to fit one frame
and says it was cut. A failure is a code from a closed list and never what the
provider said, since that can hold a token or an account name.

Limits per grant: four calls running at once, sixty a minute, twenty seconds
each. Every ask counts against the minute, refused or not, so a grant cannot be
spent on filling the owner's log with its own refusals; past the limit a device
is told to wait and nothing more is logged. Every call, answered or refused
within the limit, is a line in the owner's on-screen log with the connection id
and the operation name, and no value. A device that sends something no
operation takes (input, today) is told `invalid_request`, not that the provider
failed.

### 5. The operator's surface

The Form's **Devices** choice is drawn only where the app has a connection to
lend (ADR 0158). A session may share **Nothing** of the vault and exist only
for devices. A request raises one tray notice naming the device and its code;
it is listed under the session's guests with Allow and Turn down; Allow opens a
sheet of the connections and a duration; a grant is listed with Revoke. A
device in the guest list is marked as one.

### 6. The terminal

`opensesame-id session <link> list` and `… invoke <connection> <operation>`
join as a device over the link's NATS relay, show the user code, wait for the
owner and print the result. The code to compare goes to stderr and the result
to stdout (`--json` for one document); the link, the invite code and the device
code are never printed, and `OPENSESAME_LIVE_LINK` / `OPENSESAME_LIVE_CODE`
keep the bearer out of a shell's history. Leaving waits for the seat's goodbye
frame to reach the relay before the connection is closed (`LiveChannel.drained`),
so the owner's tab drops the grant at once rather than at its lapse. The link is refused before anything is contacted if
it names no NATS carrier that may carry a session. The terminal's carrier is a
Node client of the same `@nats-io/nats-core` the browser uses
(`packages/cli/src/live-nats.ts`); everything above it is app-core, shared with
the browser (`device-session.ts`, `device-client.ts`).

## Not built

- **The native `opensesame` CLI.** Only the TypeScript client CLI joins.
- **A terminal that can use WebRTC.** A device needs the owner's NATS relay
  (`session` not `off`); a Node peer connection would need a native dependency
  and, across networks, the same routes a browser needs.
- **A proof bound to the session's vault.** `approve` takes a `manage_grants`
  proof for whichever vault the caller named; Pages names the vault that is
  open when Allow is pressed. A session ends when the vault locks, so these are
  the same vault in practice, but the broker holds no `Named` vault of its own
  to make the type say so. Binding the broker to one (and typing `approve` as
  `ManageGrants<T>` for that `T`) is the follow-up.
- **The device's `want` on the Allow sheet.** A device may name connections it
  would like (`--connection`); the request carries them, and the sheet does not
  yet show or pre-select them. The owner chooses from what the app can lend.
- **Calling MCP tools, writes, and model keys.** The table is read-only on
  purpose. Presenting a model key (ADR 0192 §9) and calling an MCP tool each
  need an approval per operation, not per connection.
- **Resuming a grant.** A reconnect asks again. A resume token the terminal
  would keep is a bearer, and a session lasts at most eight hours.
- **A device that learns the owner declined to host devices.** The owner cannot
  reply to a request it does not seat (that would answer a stranger), so the
  terminal waits until its own timeout and says what to check.

## Consequences

- Anyone who holds the link can ask: in an open session a device is seated as
  they ask, and the owner is told only when the device begins a request. The
  most they can do without the owner is fill the eight seats and the eight
  request slots until they expire; they cannot be given a connection, see the
  vault, or learn which connections exist.
- A user code is a comparison, not a secret and not a password: a stranger
  who started a request shows the owner a code the owner has no device to
  compare it with, and the owner turns it down.
- The relay sees ciphertext and its size, as a TURN relay does. The words of a
  result, a connection's name and the operation are sealed in frames the
  fake-bus walk asserts contain none of them.
- A session now ends its devices with it: the grant, the seat and any call
  in flight, on lock, expiry, the owner's end key and a withdrawn capability.
- Adding an operation to the table is one reviewed line in
  `session-connections.ts`, and each is a line the operator can see the effect
  of in the log.
