# Live session observation

Watching an agent work inside your account while it happens, reading what it
believes it is doing, and taking the page back.

Decision record: [ADR 0078](../adr/0078-live-session-observation.md).
Vocabulary: `crates/session-observe`.
Overall flow: [web-login rotation](web-login-rotation.md).
After the fact: [teaching sessions and replay](rotation-teaching-and-replay.md).

## Why this exists

ADR 0076 gates T4 — a model driving a browser inside someone's account — behind
a one-time consent and a per-domain opt-in. A gate is only as good as what the
person on the other side of it can see. Offering them a transcript tomorrow is
not the same offer as letting them watch today, and the difference shows up as
consent that gets clicked through.

The second reason is coverage. The teaching session in ADR 0076 §4 fires when the
agent reports being stuck, so it handles the failure the agent recognizes. It
does not handle the agent that is confidently wrong on a page that looks right —
which a person watching catches immediately and a post-hoc reviewer catches after
the submit.

The third is that the channel is already required. ADR 0076 §4 has the user
attach interactively to the same sandbox to demonstrate. That is a live,
bidirectional link into a credentialed browser, specified but never given a
transport or a handoff protocol. This is that protocol.

## One log, two readers

```
runner ──append──> sealed observation log ──┬── live viewer  (tail)
                                            └── replay overlay (seek)
```

There is no second pipeline for the live case. Live is a read position.

That is a redaction decision, not a plumbing preference: a separate low-latency
path is the one that skips a masking step, because the recorded path is the one
tests are written against. Making live a cursor means no code can be live-only,
so nothing can be redacted only on the slow path.

It also inherits ADR 0076 §5 wholesale — sealed at rest, TTL-bound to the
observation window, excluded from every agent surface, never in a job listing,
deleted with the job — with no chance of the two drifting apart.

## Three lanes

| Lane | Carries | Status |
|---|---|---|
| `action` | the step IR the executor actually issued | the record; the only lane a receipt binds |
| `thought` | the model's stated reason for the step | narration, untrusted, sometimes wrong |
| `frame` | a masked still of the page | corroboration; droppable |

On a deterministic T3 run the thought lane is empty because no model is in the
loop. The viewer shows that silence rather than hiding it: you can tell which
tier you are watching without being told.

Where the action lane and the thought lane disagree, the action lane is right.
A UI that presents them as peers is a bug against ADR 0078 §2.

## Frames are admitted, not merely masked

ADR 0076 §1 requires redaction at capture rather than at render. Live capture
adds a hazard the recorded path does not have.

A browser screencast is asynchronous and lossy: the compositor produces frames
independently of whatever is solving mask geometry, so a frame can reach the
encoder describing a layout the page has already left. Rectangles solved for
generation *N* do not mask generation *N+1* — a credential field that appeared,
scrolled or reflowed since is uncovered, and the frame looks perfectly redacted
while missing the only node that mattered.

Every frame therefore carries the layout generation it was composited under, and
ships only if:

1. a mask manifest exists for **that exact generation**, and
2. that manifest covers every node the classifier called sensitive — including
   every node it could not classify, which fails closed to sensitive.

`admit_frame` in `crates/session-observe` is the gate:

| Outcome | Meaning |
|---|---|
| `Ok` | mask solved for this generation, covering every sensitive node |
| `FrameDrop::NoMask` | nothing was solved for this page — absence of a manifest means nobody looked |
| `FrameDrop::StaleMask` | the mask describes a different layout generation |
| `FrameDrop::IncompleteMask` | sensitive nodes the solver could not cover |

There is no bypass argument and no best-effort mask. A page with nothing
sensitive on it still needs a solved manifest saying so, because "no password
fields here" is a claim about a layout and the manifest is where the claim is
recorded.

**The preview stutters when the page churns.** That is the gate working. Smoothing
it means shipping frames nobody can prove were masked.

## Thoughts: safe to stream, unsafe to trust

Two separate properties, and both matter.

**Why it is streamable.** The model's context structurally never held a
credential value — no `read_field_value` exists, `fill_credential` returns
`{ok}`, DOM reads are redacted before serialization. A model cannot narrate a
value it never received. The safety is structural, not a scrub applied to the
text afterwards.

**Why it is untrusted.** The thought lane's input is a third party's page.
Hostile text reaches the model through the redacted DOM read and can come back
out as narration, which OpenSesame then renders in its own chrome beside real
controls — a phishing surface wearing the product's trust dressing.

Render rules:

- inert quoted data in a visually distinct region: no link activation, no
  markup, no embedded resources
- never in a notification body, which is the one place text arrives with no
  surrounding context
- bidirectional overrides and control characters stripped **at capture**, so
  displayed text is actual text (`UntrustedText::capture`)
- a length cap, marked when it bites
- **an approval never cites a thought.** ADR 0046 §8's binding message is what a
  person answers; a rationale sits beside that question and is never the question

Thoughts are vault-class with the rest of the log. They cannot quote a secret;
they can quote an account.

## Taking control

One holder, and the agent parks first. Two actors in one DOM race the fail-closed
presence assertion and produce a receipt that cannot say who did what.

```
AgentDriving ──request──> HandoffRequested ──park──> AwaitingHuman
                                │                         │ grant
                            withdraw                      v
                                └──────────────>     HumanDriving
                                                          │ release
                                                          v
AgentDriving  <──reassertion passed──  ResumeRequested ────┘
                                            │ failed
                                            v
                                        Suspended  ──reattach──> AwaitingHuman
```

`ControlLease` in `crates/session-observe` is that machine. Three properties it
holds:

**The agent's tools die when it stops driving.** `agent_tools_live()` is false in
every state but `AgentDriving` and `HandoffRequested`, so suspending the tool
surface is a property of the state rather than a check at each call site.

**Autonomy never resumes on a timer.** Every edge back to `AgentDriving` leaves
from a state where either the agent never stopped (a withdrawn request) or a
re-assertion just ran. A lease that expires, a viewer that vanishes, and a failed
re-assertion all land in `Suspended`, and `Suspended → AgentDriving` does not
exist. Kani proves it:
`autonomy_resumes_only_through_a_withdrawal_or_a_reassertion`.

**A human driving does not gain the agent's authority — the agent loses its
own.** The person types their own input. Credential material still comes only
from the deterministic controller, resolving a reference. Someone demonstrating
"the password goes here" marks a field and produces a *reference*: they never see
a value and cannot type one. That is what keeps a teaching session value-blind
with a human at the keyboard.

### The critical section

`assert candidate present -> submit`
([ordering that must not be rearranged](web-login-rotation.md)) has no quiescent
point in it. The assertion is a claim about what a field holds at submit time, so
a second actor between the two voids it — and ADR 0076 constraint 3 is the
difference between a rotation and a password that silently became a placeholder.

| Event | Behaviour |
|---|---|
| handoff requested inside the span | **queued**, and reported as queued — a request that vanishes teaches people to mash the button |
| span closes with a queued request | released; the agent parks at the next step |
| `park()` attempted inside the span | refused (`ControlError::Critical`) |
| `enter_critical()` while parked or human-driven | refused (`ControlError::NotAgentDriving`) |
| `suspend()` inside the span | **allowed**, and clears it — an interrupted `assert -> submit` is exactly ADR 0076 constraint 5's indeterminate outcome and reconciles rather than retrying |

Coming back from human control **re-runs** the assertion instead of inheriting
it. What it established was true of a page the agent controlled, and a person has
been in that page since.

## Who may attach

| Relation | View | Control | Why |
|---|---|---|---|
| Credential owner | yes | yes, with a fresh step-up | it is their account |
| Delegate | no | no | a use-grant is authority over a credential; a session view is the account behind it, which no delegation covered |
| Operator / support | no | no | ops needs to know a run parked and why — that is metadata; a live view is shoulder-surfing |
| MCP / WebMCP | no | no | extends ADR 0076 §10's recording exclusion to the live tail of the same log |

Viewing needs no step-up because cryptography already gates it: the log is sealed
to the owner's viewer key, so a locked client cannot read it whatever an
authorization check returns. **Control does**, because it is a live action inside
an authenticated third-party session over a channel a stolen tab also reaches —
decrypting frames and issuing input events are different capabilities.

`authorize_attach` reports a stale step-up *before* it reports contention.
Telling somebody the lease is held when they were never going to be allowed to
drive discloses who else is on the account.

## Transport

ADR 0046 §7's ladder, unchanged:

| Tier | Used for | Notes |
|---|---|---|
| 1 — per-principal NATS inbox | park, notify, lease events | already granted bidirectionally; a `filter_subject` change, not a new permission rule |
| 2 — WSS relay through the gateway | the observation stream | payloads sealed to xkeys recipient keys (ADR 0042); the relay is a courier, not a reader |
| 3 — WebRTC | not taken | §3's admission gate keeps the frame rate low enough that relay bandwidth is not the constraint |

Sealing is to the owner's **public** viewer key, so a run at 04:00 seals to a
viewer who is asleep. The gateway holds ciphertext in both the live and the
stored case — stronger than "sealed at rest", because there is no window in which
it holds plaintext frames at all.

The limit, stated rather than implied: **the runner holds plaintext**, because it
renders the page. Sealing protects the log between runner and viewer. ADR 0076
§7's session residual is untouched by any of it.

The consequence users feel: live preview requires an unlocked vault. A locked
client sees that a run is in progress and nothing else.

## Receipts

Per ADR 0046 §11's `decidedByKind: human | agent`, the receipt records that a
viewer attached, when, whether they held control, and over which step range.

A rotation is not less trustworthy for having been driven by its owner; it is
differently trustworthy. The receipt that misleads is the one that cannot tell an
unattended run from a hand-held one, and later gets read as proof the automation
worked.

## Intended code homes

For the implementation pass. Only `crates/session-observe` exists today.

| Change | Where |
|---|---|
| Lease machine, frame admission, attach entitlement | `crates/session-observe` (done) |
| Sealed observation log: append, range, tail | `crates/storage`, new migration |
| Capture pipeline, mask solver, screencast admission | the T4 runner, alongside `crates/rotation-web` (ADR 0076) |
| Attach ceremony, lease routes, WSS relay | `apps/gateway/src/routes/rotation.rs` |
| Park / notify events | the existing per-principal NATS inbox (`crates/authz/src/callout.rs`) |
| Viewer: tail, seek, lane rendering, take-control | `apps/pages` — it holds the viewer key |
| Registry entries | `packages/capability-registry`, with the routes |

`crates/session-observe` must not become a daemon dependency —
`scripts/daemon-deps-gate.sh` audits that tree, and ADR 0053 §2's rule is that
the daemon depends on none of this.
