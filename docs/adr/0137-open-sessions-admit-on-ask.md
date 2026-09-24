# ADR 0137 — Open sessions may admit on ask, as observers

- Status: Accepted
- Date: 2026-09-24
- Amends: [ADR 0079](0079-shared-sessions-and-scoped-grants.md) §7 (joining
  a public session: the operator decides every request)
- Completes: [ADR 0136](0136-join-a-session-restored.md) §2's open road

## Context

ADR 0079 §7 made a public session one anyone in the organization may *ask*
into, and every ask the operator's decision. That is the right default and
the wrong only option. An operator running an open room — an incident
channel, a review anyone on the team may watch — has already decided that
anyone who asks may come in, and answering each ask by hand adds nothing but
waiting. ADR 0136 restored the join ceremony's open road and left "admit on
ask" as a follow-up because it is a Host policy change, not a client one.

What must not change: admission is a named seat (ADR 0079, as amended by
the coordination work), and a *key* is never handed out except by the
operator's own decision — a grant wraps a key for one person, and ADR 0079
§3 cannot take a wrapped key back.

## Decision

### 1. A session states how it admits

`POST /api/v1/shared-sessions` takes `admission`:

- `operator` (the default, and every session that existed before this ADR) —
  ADR 0079 §7 unchanged: an ask waits for the operator.
- `observer_on_ask` — whoever asks is seated at once **as an observer,
  holding nothing**.

There is no participant-on-ask. A participant seat needs the grant it mints,
and a grant is the operator's decision about one person; no policy makes it.

A policy that cannot apply is refused, not stored: `observer_on_ask` on a
private session (nobody can ask into one) answers `422 session_admission`,
as does any other spelling. The column carries a CHECK of the two values
(`migrations/0041_session_admission.sql`), defaulting to `operator`.

### 2. An ask under the policy is decided in the operator's name

The ask is recorded as a join request exactly as before, then seated and
decided in the same request: the seat written first, then the decision
`admitted` / `observer`, `decided_by` the session's operator — the person
who made this decision once, for everyone, when they opened the session. The
room hears `ParticipantJoined`; the asker gets `201 {decision: "admitted",
mode: "observer"}`. If the decision fails after the seat, the request stays
pending for the operator to answer, the same order ADR 0079's decide route
keeps. Asking again answers `already_in_session`.

### 3. The listing says which answer to expect

The discovery record (`GET /api/v1/shared-sessions?visibility=public`)
gains `admission` per session — still a name and an id and nothing about the
room's contents. The Pages ceremony (ADR 0136) reads it: a session that
admits on ask is offered with the verb **Join**, one that does not with
**Ask to join**, and the last rung says **Joined, as observer** or **Asked**
from what the endpoint actually answered. Anything but the exact spelling
reads as `operator`: the page never promises an admission the endpoint did
not state.

## Consequences

- "The vault is configured to allow all users" has a precise meaning: a
  public session that admits on ask. Anybody the Host already knows in the
  organization (a paired, passkey-verified join browser, or a signed-in
  session) who asks is in the room at once — present, seeing the roster and
  the channel, holding no key.
- An observer seated this way is an ordinary observer: the operator may
  raise them to participant with a grant, lower or remove them, exactly as
  for one they admitted by hand.
- The policy is chosen when the session is opened. Changing it on a running
  session is not offered; close and reopen, or admit by hand.
- Nothing about who may *ask* changes: the session is still visible only to
  its own organization, and a browser still needs the operator's pairing
  approval and a passkey check first (ADR 0136).
