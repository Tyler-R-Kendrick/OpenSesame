# ADR 0081 — Live session observation: watching the agent work, and taking the page back

Status: Proposed
Date: 2026-08-31
Supplements: ADR 0076 ([autonomous web-login rotation](0076-autonomous-web-login-rotation.md))
§4 and §5, ADR 0046
([relayed execution and the authorization-request inbox](0046-relayed-execution-and-authorization-inbox.md))
§7, §8 and §11, ADR 0042 ([NATS TaskBus and xkeys](0042-nats-taskbus-auth-callout-and-xkeys.md)),
ADR 0005 ([ConnectionRef over SecretRef](0005-authority-handle-connectionref.md)),
ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md))
Implements: `crates/session-observe`
Design: [live session observation](../architecture/live-session-observation.md)

## Context

ADR 0076 put a model in a browser inside somebody's account. It gated that tier
(T4) behind a one-time consent and a per-domain opt-in, and it answered ADR 0052
§11's silent-failure objection with a **recording**: every run is captured, a
blocked run parks and notifies, and the user then opens a replay overlay and
demonstrates the way through in the same sandbox.

Every verb in that sentence is past tense. The user learns what happened after
it happened, and can intervene at exactly one moment — the moment the agent
itself admits defeat.

That leaves three gaps.

**Consent without observation is a formality.** T4 asks a person to authorize a
model to drive their bank's settings page. What makes that question answerable
is being able to watch the answer play out, and to stop it. "You can read the
transcript tomorrow" is a different, weaker offer, and a gate defended by a
weaker offer is a gate that will get clicked through.

**A blocked run is the case the agent recognizes.** The teaching session in
ADR 0076 §4 triggers on the agent's own self-report, so it covers the failure
mode where the agent knows it is stuck. It does not cover the one where the
agent is confidently doing the wrong thing on a page that resembles the right
one — which is the failure mode a person watching would catch in two seconds and
a post-hoc reviewer catches after the submit.

**The channel is already in the design.** ADR 0076 §4 has the user "attach
interactively to the **same sandbox**" and demonstrate — view and control, over
a live bidirectional link into a credentialed browser. The hard part is
specified. It is only scoped to fire after a failure, and it was never given a
transport, an entitlement rule, or a handoff protocol.

Cloud coding agents have converged on the shape being borrowed here: watch the
remote machine work, read the reasoning beside it, take control when it goes
wrong. The convergence is evidence the interaction is right. The setting is not
the same, and the difference is the whole of this ADR: a coding agent works in a
scratch container, and this one works inside an authenticated session at a third
party. ADR 0076 §7 already records that the session, not the password, is the
valuable thing in the room. A live channel makes both the value and the risk of
observation larger than they are in the coding case, and neither can be borrowed
along with the interaction.

## Decision

### 1. One log. Live is its tail, replay is a seek into it.

There is no separate live pipeline. The runner appends to a single sealed,
append-only observation log; the replay overlay seeks in it and a live viewer
tails it.

This is the load-bearing choice, and it is a redaction decision rather than an
architectural preference. A second path built for latency is where redaction
goes to die: it is the path that skips the masking step the recorded path
applies, because the recorded path is the one people write tests against. Making
live a *read position* rather than a *pipeline* means there is no code that can
be live-only, and therefore nothing that can be redacted only on the slow path.

It also means ADR 0076 §5's decisions about recordings — sealed at rest,
TTL-bound to the observation window, excluded from every agent surface, never
returned by a job listing, deleted with the job — cover the live view without
being restated, and cannot drift apart from it.

A viewer that falls behind seeks forward. It does not accrue an unbounded buffer
and it is not handed a cheaper live-only artifact to catch up from.

### 2. Three lanes, and the action lane is the record

- **Action** — the step IR the executor actually issued.
- **Thought** — the model's stated reason for the step it is about to take.
- **Frame** — a masked still of the page, admitted under §3.

The action lane is the truth, and the only lane a receipt binds. Frames
corroborate it; they do not testify. A pixel stream cannot be diffed against a
recipe, cannot be cited by a receipt, and cannot be checked for what it failed to
redact — a typed action can be, and ADR 0021's frozen-intent discipline already
gives structured actions a digest to bind.

On a deterministic T3 run the thought lane is empty, because no model is in the
loop. That silence is informative and is displayed as such: a viewer can tell
which tier they are watching without being told.

### 3. Frames are admitted, not merely masked

ADR 0076 §1 requires redaction at capture rather than at render. Live capture
adds a hazard the recorded path does not have, and "at capture" stops being
sufficient on its own.

A browser screencast is an asynchronous, lossy producer: frames are composited
and coalesced independently of whatever else is computing mask geometry, so a
frame can reach the encoder describing a layout the page has already left. Mask
rectangles solved for layout generation *N* do not mask generation *N+1* — a
credential field that appeared, moved, scrolled or reflowed since is uncovered,
and the frame looks perfectly redacted while missing the one node that mattered.

So every frame carries the layout generation it was composited under, and is
encoded only when both hold:

1. a mask manifest exists for **that exact generation**, and
2. it covers every node the classifier called sensitive — including every node
   it could not classify, which fails closed to sensitive.

Anything else drops the frame. There is no fallback that encodes it anyway with
a warning attached, and no "best effort" mask. `crates/session-observe`'s
`admit_frame` is that gate and takes no bypass argument.

The cost is visible and intended: the preview stutters precisely when the page
churns, which is precisely when the mask is least trustworthy. A smooth stream
would mean shipping frames nobody can prove were masked.

### 4. Thoughts are streamable because of the tool boundary, and untrusted because of the page

Two claims, and both are needed.

**Streamable at all.** The model's context structurally never contained a
credential value: ADR 0076 §1 gives it no `read_field_value`, `fill_credential`
returns `{ok}`, and DOM reads are redacted before serialization. A model cannot
narrate a value it never received. This — not a filter over the text — is what
makes a reasoning stream shippable inside a credential product, and it is the
same structural argument as `wit/connector/world.wit` having no `secrets.get`.

**Untrusted anyway.** The thought lane's *input* is a third party's page.
Hostile text reaches the model through the redacted DOM read and can come back
out as narration, which `OpenSesame` then renders inside its own chrome, next to
real controls. That is a phishing surface wearing the product's trust dressing.
Four rules follow:

- thoughts render as inert quoted data in a visually distinct region — no link
  activation, no markup, no embedded resources, and never in a notification
  body, which is the one place text arrives with no surrounding context;
- bidirectional overrides and control characters are stripped **at capture**, so
  what a reviewer sees is what is there (`UntrustedText`);
- a length cap, marked when it bites;
- **an approval never cites a thought.** ADR 0046 §8's binding message, rendered
  identically to requester and approver, is what a person answers. A rationale
  is context beside that question, never the question.

And the honest one: model narration is not an execution trace, and the two can
disagree. Where they do, the action lane is right, and a UI that presents them
as equals is a bug against this section.

Thoughts are vault-class with the rest of the log. They cannot quote a secret;
they can certainly quote an account.

### 5. Control is a lease with one holder, and the agent is parked before a human drives

Not a shared cursor. Two actors in one DOM race the fail-closed presence
assertion (§6) and produce a receipt that cannot say who did what.

The machine is `crates/session-observe`'s `ControlLease`:

```
AgentDriving -> HandoffRequested -> AwaitingHuman -> HumanDriving
             -> ResumeRequested  -> AgentDriving
Suspended reachable from all of them; see §7 for what leaves it.
```

While a human holds the lease the agent's tool surface is not merely idle, it is
dead — no `fill_credential`, no `submit` — and that is a property of the state
(`ControlState::agent_tools_live`) rather than a check somebody has to remember
to write at each call site.

Taking control does not hand a person the agent's authority; it removes the
agent's. The human types their own input. Credential material is still produced
only by the deterministic controller from a reference (ADR 0076 §1), so somebody
demonstrating "the password goes here" marks a field and produces a *reference* —
they never see a value and cannot type one. That is what keeps a teaching
session value-blind by construction (ADR 0076 §4) with a human at the keyboard.

### 6. The critical section is uninterruptible, and preconditions are never inherited

`assert candidate present -> submit`
([ordering that must not be rearranged](../architecture/web-login-rotation.md))
contains no quiescent point. The assertion is a claim about what a field holds at
submit time, so a second actor in the page between the two voids it, and
ADR 0076 constraint 3 is the difference between a rotation and a password that
silently became a placeholder.

A handoff requested inside the span is therefore **queued and reported as
queued** — not dropped, because a request that vanishes teaches people to mash
the button — and released the moment the span closes.

Symmetrically, returning from human control **re-runs** the assertion instead of
inheriting it. What it established was true of a page the agent controlled, and a
person has been in that page since. A re-assertion that fails parks the run.

### 7. A lease that expires parks the run; it never hands the page back to the model

The obvious design is that control reverts to the agent on timeout. It is the
default in every session system, and it is wrong here.

Reverting means resuming a model into a page a person left in an unknown state: a
half-filled form, a different origin, a step-up prompt they started and
abandoned. That is exactly the improvisation ADR 0076 refuses at T5, arrived at
by a timer rather than by a decision — and worse, arrived at silently.

So lease expiry, a vanished viewer, and a failed re-assertion all land in the
same place: the run parks, notifies, and waits for a person. Returning is
`Suspended -> AwaitingHuman`, and there is no edge `Suspended -> AgentDriving`.
The Kani proof `autonomy_resumes_only_through_a_withdrawal_or_a_reassertion`
holds that shut: every edge back into autonomy leaves from a state where either
the agent never stopped or a re-assertion just ran.

The cost is that somebody who walks away mid-demonstration leaves a parked run
rather than a finished one. That is the correct cost, and it is the same bargain
ADR 0076 constraint 5 already struck for indeterminate outcomes.

### 8. Only the owner watches — not a delegate, not an operator, not an agent

- **Delegate: no.** A use-grant is authority over a credential. A session view is
  an authenticated view of the account behind it — balances, addresses, message
  subjects, security settings — which no delegation covered. Attenuation does not
  run that direction: a narrower grant cannot acquire a wider read.
- **Operator: no.** Ops legitimately needs to know that a run parked and why.
  That is metadata, it is a different artifact, and it already exists. A live
  view is the surface that turns a support request into shoulder-surfing.
- **Agent surfaces: no**, structurally. ADR 0076 §10 excludes
  `rotations.recording_read` from every agent surface; §1 makes the live tail the
  same log, so the exclusion applies to it without a second decision.

Viewing needs no step-up, because it is already gated cryptographically: the log
is sealed to the owner's viewer key, so a client with a locked vault cannot read
it whatever an authorization check returns. **Control does need one.** It is a
live action inside an authenticated third-party session, over a channel a stolen
tab also reaches, and cryptography does not gate it — decrypting frames and
issuing input events are different capabilities and must not share a bar.

`authorize_attach` refuses with a typed reason, and reports a stale step-up
*before* it reports contention: telling somebody the lease is held when they were
never going to be allowed to drive discloses who else is on the account.

### 9. The gateway relays; it does not watch

Transport is ADR 0046 §7's ladder, unchanged. Tier 1 — the per-principal NATS
inbox — carries park and notify. Tier 2 — a WSS relay through the gateway —
carries the stream, with payloads sealed to xkeys recipient keys per ADR 0042, so
the relay is a courier and not a reader.

Tier 3 (WebRTC) is deliberately not taken. §3's admission gate holds the frame
rate low enough that relay bandwidth is not the constraint, and a peer-to-peer
path would import DTLS-fingerprint signing to solve a problem this design does
not have.

Sealing is to the owner's *public* viewer key, so a run at 04:00 seals to a
viewer who is asleep. The gateway holds ciphertext in both the live and the
stored case — which is strictly stronger than "sealed at rest", because there is
no window in which it holds plaintext frames at all.

The limit, stated rather than implied: the runner holds plaintext by
construction, because it renders the page. Sealing protects the log between the
runner and the viewer. ADR 0076 §7's session residual is untouched by any of it.

The consequence a user will feel: **live preview requires an unlocked vault.** A
locked client can see that a run is in progress and nothing else.

### 10. Attaching is receipted, and a partly-driven run says so

Following ADR 0046 §11's `decidedByKind: human | agent`, the receipt records that
a viewer attached, when, whether they held control, and over which step range.

A rotation is not less trustworthy for having been driven by its owner; it is
*differently* trustworthy. The receipt that misleads is the one that cannot tell
an unattended run from a hand-held one, and later gets read as evidence that the
automation worked.

### 11. Scope: sandboxed runs, not an observability plane

This governs runs in a sandbox `OpenSesame` operates or the user self-hosts,
which today means ADR 0076's T3 and T4 rotation runs and nothing else.
`crates/session-observe` is target-agnostic because the vocabulary genuinely is,
but declaring a general "agent observability plane" ahead of a second consumer
would be inventing a subsystem to hold one feature. When a second sandboxed class
arrives, it inherits this rather than growing its own.

It is also not a debugging console for `OpenSesame`. The log is somebody's
account, not our telemetry, and the diagnostics operators need are the metadata
of §8 — a different artifact, with a different audience and a different
retention.

### 12. Agent-surface mapping

Per ADR 0065, each capability introduced here maps or is excluded with a
citation. Registry entries land with the routes, per ADR 0076 §10's precedent —
nothing below has a surface yet.

| Capability | cli | mcp_host | webmcp |
|---|---|---|---|
| `sessions.run_status_read` (parked/driving, lane counts, no bodies) | `opensesame rotate runs` | `rotation_run_status_read` | `opensesame_rotation_run_status` |
| `sessions.observe_open` | `opensesame rotate watch` | excluded — vault-class session log, §8 | ceremony-open only, returns `{status: "ceremony_opened", location}` |
| `sessions.control_request` | `opensesame rotate attach` | excluded — human ceremony, ADR 0065 rule 5 | excluded, same |
| `sessions.log_read` | — | excluded — vault-class session log, §8 | excluded, same |

Nothing here returns a frame, a thought body, or a credential value on any
surface.

## Alternatives considered

**A raw screencast, the way a remote-desktop product does it.** The most direct
reading of "like Cursor". Rejected as the *primary* record for three reasons that
compound: pixels cannot be bound by a receipt or diffed against a recipe; a
continuous stream makes §3's admission gate ruinously expensive, so the pressure
would be to relax it; and a video artifact is the largest possible version of the
vault-class data problem ADR 0076 §5 already flags. Retained as the frame lane —
subordinate, admitted, and droppable.

**Stream the model's raw token stream.** Higher fidelity, and closer to what a
coding agent shows. Rejected because reasoning tokens are not a stable contract
to build a UI on, they carry the §4 injection surface at maximum volume, and a
continuous stream of a model talking to itself invites exactly the confusion §2
forbids — treating narration as the record. Per-step thought records, bound to
the action they precede, keep the association a viewer needs without the rest.

**Shared control, where the human and the agent both act ("assist mode").**
Rejected: it races the §6 assertion, and it produces a receipt that cannot
attribute a step. The lease costs a round trip at each handoff and buys an
answer to "who did this", which is the question a rotation receipt exists to
answer.

**Revert the lease to the agent on timeout.** Covered in §7. Rejected because it
converts an abandoned session into unattended automation over a page in an
unknown state.

**Ship the live view but forbid taking control.** Tempting, and genuinely safer
in isolation: it removes the bidirectional channel that most of the new threat
rows are about. Rejected because ADR 0076 §4 already requires interactive attach
for teaching sessions, so the channel exists either way — a view-only product
would carry the same risk while withholding the one action that makes watching
worth doing. Better to specify the lease than to pretend the channel is one-way.

**Let operators watch, for support.** Rejected under §8. The support case is
served by metadata; the live view is somebody's bank account.

## Consequences

- **The T4 gate becomes answerable.** A person consenting to a model driving
  their account can watch it, and stop it. That is what makes ADR 0076's opt-in
  a decision rather than a formality, and it should be presented as such rather
  than as a convenience feature.
- **A live control channel into a credentialed sandbox is the largest new attack
  surface in this line of work.** A compromised viewer session becomes a control
  path into an authenticated third-party account. It is bounded by owner-only
  entitlement, a step-up for control, single-holder leasing, and a run that parks
  rather than continues — and it is not eliminated. It is recorded here in the
  same spirit as ADR 0076 §7.
- **The preview stutters, by design.** Frame drops under DOM churn are the
  visible form of §3 working. Anyone tempted to smooth it is proposing to ship
  unproven frames.
- **The thought lane will sometimes be wrong**, and users will read it as
  authoritative unless the UI stops them. §2 and §4 are the mitigation; they are
  interface obligations, and interface obligations decay.
- **Live preview requires an unlocked vault**, because the log is sealed to the
  viewer. This is the right trade and it will read as a bug in a support ticket.
- **Nothing here reduces ADR 0076 §7.** Watching a session does not constrain
  it; it makes a takeover visible sooner, which is worth having and is not the
  same claim. Product copy that implies observation mitigates the session
  residual is a bug against this ADR.
- **Retention for the live case comes free**, because §1 makes it one artifact —
  and so does the blast radius. There is no live-only store to forget to expire,
  and no live-only store to reason about separately in an incident.
