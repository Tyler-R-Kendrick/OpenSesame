# Web-login rotation threat model (addendum)

Extends `docs/security/threat-model.md` for autonomous password rotation at
consumer websites through remote agent browsers.

Decision record: [ADR 0076](../adr/0076-autonomous-web-login-rotation.md),
extended by [ADR 0081](../adr/0081-live-session-observation.md) for the live
observation and control channel.
Design: [web-login rotation](../architecture/web-login-rotation.md),
[live session observation](../architecture/live-session-observation.md).

## What is new

Three things this system did not have before, each of which is an asset or an
actor in its own right:

- a **remote browser** holding an authenticated first-party session at a third
  party, on the user's behalf
- a **model** planning actions inside a credentialed flow
- **run recordings**, which are authenticated views of people's accounts
- a **live bidirectional channel** into that browser, over which a person
  watches the run and can take the page (ADR 0081)

## Assets

- The password being rotated (previous and candidate values)
- The **authenticated session** the sandbox establishes — higher value than the
  password, see S1
- Run recordings and replay artifacts — and, per ADR 0081 §1, the live stream,
  which is the tail of the same log rather than a second asset
- The **control lease**: the right to act on the page in place of the agent
- Rotation recipes and the signing key that makes one trusted
- The account's security configuration at the relying party (recovery address,
  phone, MFA enrolments, active sessions)

## Actors

Everything in the base model, plus: the sandbox operator, the remote browser
process, the planning model, the relying party's own JavaScript, an anti-bot
vendor, a contributor proposing a recipe to the shared corpus, and — since
ADR 0081 — an attached **viewer**, who is the credential's owner and whose
client is a new endpoint on a live path into the sandbox.

## Trust boundaries

Numbered to continue the base model's list.

7. **Tool boundary.** The agent calls `fill_credential(ref, selector)`; a
   deterministic controller resolves the reference. The agent is inside the
   credentialed loop and outside the secret.
8. **Capture boundary.** DOM reads and screenshots are redacted in the capture
   pipeline, before a string or an image exists.
9. **Sandbox boundary.** The remote browser is untrusted with respect to the
   *value* and, unavoidably, trusted with respect to the *session*.
10. **Courier boundary.** The observation log is sealed by the runner to the
    owner's viewer key, so the gateway relays it without reading it. Plaintext
    exists at the runner, which renders the page, and at the viewer, which has
    an unlocked vault. Nowhere in between.
11. **Driver boundary.** Exactly one actor may act on the page. The control
    lease, not an entitlement check, is what makes that true.

## Abuse cases

| Threat | Control | Test anchor |
|--------|---------|-------------|
| Secret reaches model context or transcript | No `read_field_value` tool exists; `fill_credential` takes a ref and returns `{ok}` | tool-surface pact test |
| Secret in a screenshot or DOM dump | Redaction at capture, not at render; password-field values stripped before serialization | capture redaction tests |
| Secret in a run recording | Recorder is value-blind by construction; unclassifiable fields fail closed to sensitive | recorder property tests |
| Candidate lost after site accepted it → unrecoverable lockout | Seal + wait for ADR 0039 backup acknowledgement **before** submit | `assert_source_order` on the executor |
| Placeholder or empty value submitted as the new password | Fail-closed candidate-presence assertion immediately before submit | executor unit tests |
| Old value discarded on an ambiguous outcome | `crates/rotation` forbids `CandidateInstalled → PreviousRevoked`; indeterminate routes to `ReconciliationRequired` | existing Kani `cannot_revoke_before_observe` |
| Two schedulers rotate one account concurrently | Claim/lease on the rotation outbox, per `backup.rs` | scheduler lease tests |
| Old-password probe trips lockout / looks like stuffing | No `verify_old_password_fails` step exists in the step IR | recipe schema validation |
| Site echoes the typed value to a third-party origin | Default-deny sandbox egress; only the target origin and reviewed offsite hops | egress policy tests |
| Hostile page induces a fill into a field of its choosing | Recipe pins the target; agent may only name targets the recipe declares | recipe replay tests |
| Recipe poisoned via corpus contribution | Signing required; canary round trip required; corpus promotion is a reviewed ceremony | corpus review checklist |
| Recipe drift silently rotates into the wrong form | Bundle-hash binding, `expires_at`, verification is always a fresh login | drift tests |
| Recording exfiltrated from the gateway | Sealed at rest, TTL-bound, excluded from every agent surface, human ceremony to fetch | registry parity test |
| Agent surface gains a recording or value read | `rotations.recording_read` excluded on all agent surfaces citing ADR 0076 §5 | `packages/capability-registry` self-test |
| Browser driver pulled into the daemon's tree | New crate is not a daemon dependency | `scripts/daemon-deps-gate.sh` |
| A live frame ships before its mask is solved, or masked with geometry from a layout the page has left | Frames carry their layout generation; `admit_frame` requires a manifest for that exact generation covering every sensitive node, and drops otherwise | `session-observe` frame-admission tests |
| A low-latency live path skips a redaction the recorded path applies | Live is a read position on one log, not a second pipeline (ADR 0081 §1) | there is no live-only capture code to test |
| A hostile page plants text in the model's rationale, which renders inside `OpenSesame`'s chrome | Thoughts are inert quoted data, never in a notification body, never cited by an approval; bidi overrides and controls stripped at capture | `UntrustedText::capture` tests |
| A human takes control between the candidate assertion and the submit | The span has no quiescent point: handoff is queued and reported as queued, `park()` is refused inside it | `handoff_inside_the_critical_section_is_queued_not_honoured` |
| A stale assertion is inherited across a change of driver | Resume re-runs the assertion; a failed re-assertion parks the run | `a_failed_reassertion_parks_rather_than_resuming` |
| A lease times out and autonomy resumes into a page a person left half-edited | Expiry parks the run; no edge `Suspended -> AgentDriving` exists | Kani `autonomy_resumes_only_through_a_withdrawal_or_a_reassertion` |
| Agent and human act on the page at once, leaving a receipt that cannot attribute a step | Single-holder lease; the agent's tool surface is dead in every non-driving state | `agent_tools_are_dead_wherever_the_agent_is_not_driving` |
| An operator or a delegate watches somebody's account | Owner-only attach; delegation carries authority over a credential, not a view of the account | `nobody_but_the_owner_watches_a_run` |
| An agent surface reads the live stream | `AgentSurface` refused before anything else is considered; the live tail is the same log ADR 0076 §10 already excludes | `agent_surfaces_are_refused_before_anything_else_is_considered` |
| A stolen viewer tab drives the sandbox | Control needs a fresh step-up on top of the vault key; viewing and driving are separate capabilities | `viewing_needs_no_step_up_but_driving_does` |
| A refusal discloses who else is on the account | Stale step-up is reported before lease contention | `a_stale_step_up_is_reported_before_contention` |
| Anti-bot challenge treated as an obstacle to defeat | No solving, no evasion, no fingerprint impersonation, no residential egress; challenge routes to a teaching session | ADR 0076 constraint 4 |

## S1. The session residual — unmitigated, and recorded as such

To change a password the sandbox must first log in. From that moment it holds a
live first-party session and can add a recovery address, enrol its own second
factor, or change the account email and trigger a reset — **full account
takeover without ever learning the password**.

No secret-handling design mitigates this. The tool boundary protects the value,
not the session. The password is also the *least* valuable item on that list,
because it is random, per-site, and about to be replaced anyway.

Claims to make, precisely:

- supportable: the secret is never in the transcript, the logs, or a screenshot
- **not** supportable: the sandbox cannot take over the account

This is why an earlier design that kept plaintext out of the browser entirely,
by substituting secrets into browser egress at a proxy, was rejected rather
than merely deprioritised: it bought protection for the password while the
session — the more valuable asset — remained exposed, and it did so at the cost
of becoming the generic string replacer ADR 0005 forbids. The full argument is
ADR 0076 §6; the precedent is
[audit-2026-08-08-placeholder-substitution](audit-2026-08-08-placeholder-substitution.md).

Controls are operational rather than cryptographic:

- T4 sandboxes are attested and OpenSesame-operated or self-hosted; never an
  arbitrary third-party browser service
- every run ends with a diff of the account's security configuration, surfaced
  in the receipt, so a change we did not make is visible
- every run ends with sign-out-everywhere
- T4 is off by default and requires per-domain opt-in

## S2. The silent-lockout failure class

The most damaging outcome is not a failed rotation. It is a rotation that
appears to succeed and leaves the user holding a value that does not work, or
that leaves nobody holding the working value.

Four paths in, and what closes each:

| Path | Control |
|---|---|
| Candidate sealed but not durably backed up before submit | Wait for the ADR 0039 outbox acknowledgement, not just the write |
| Field never received a value; submit proceeded anyway | Fail-closed presence assertion before submit |
| Site truncated or rejected the value silently | `composition.max_length` and `forbidden_symbols` in the recipe; verification is a fresh login |
| Site reported success and did not change it | `verify_login` is the only trusted success signal; text and URL hints are corroborating only |

Behind all four sits the property that makes this survivable at all:
`crates/rotation` cannot reach `PreviousRevoked` without passing
`CandidateVerified`, and that edge is Kani-proven. The previous value is
retained until verification. Treat that state machine as security-critical code.

## S3. Recordings as a new sensitive class

A recording containing zero passwords still contains an authenticated view of
someone's account. The controls are in ADR 0076 §5: sealed at rest, TTL-bound
to the observation window by default, excluded from every agent surface, never
returned by a job listing, deleted with the job.

The honest cost, recorded rather than argued away: the blast radius of a gateway
compromise grew. Before this feature the gateway held ciphertext and metadata.
Now it holds pictures of people's accounts.

## S4. Anti-automation and the relying party

Password-change endpoints are the most defended surface on a consumer site,
because they are the account-takeover chokepoint. Automated interaction may
violate a site's terms of service, and a datacenter IP with a fresh profile is
close to the signature these systems are built to catch.

The position, which is a security position and not only a legal one:

- treat `/.well-known/change-password` as an invitation, and honour it
- no CAPTCHA solving, no bot-detection evasion, no TLS or HTTP fingerprint
  impersonation, no residential-proxy egress
- rate-limit per relying party; never retry in a pattern shaped like credential
  stuffing
- a challenge is a stop signal that routes to a teaching session, not an
  obstacle

Shipping fingerprint impersonation would mean maintaining an evasion arms race
inside a security product, in the same process that handles plaintext. That is
the trade being declined.

## S5. The live channel is the largest new surface, and it is worth it

ADR 0081 adds a bidirectional path into a browser holding an authenticated
first-party session. That is a bigger surface than anything else in this
document, and it is added deliberately.

What it buys, and the reason it is not optional: ADR 0076 §4 already requires the
user to attach interactively to the same sandbox to demonstrate past a blocker,
so the channel exists whether or not it is specified. Leaving it unspecified
would ship the risk and forfeit the benefit. And the benefit is real — the T4
consent gate is a formality unless the person granting it can watch and stop
what they granted.

What bounds it:

- attach is owner-only; delegates, operators and agent surfaces are refused
- viewing is gated by the vault key, because the log is sealed to it
- driving takes a fresh step-up on top, because decrypting frames and issuing
  input events are different capabilities
- one holder at a time, and the agent's tool surface is dead while a human drives
- a lease that expires parks the run rather than resuming autonomy

What does not bound it: none of the above helps if the viewer's own client is
compromised. A viewer that can decrypt the stream and pass a step-up is
indistinguishable from the owner, and from there the control lease is a direct
path into the account. This is the same shape as S1 — the session is the asset —
one endpoint further out.

Two honest notes on what live observation does **not** do:

- It does not mitigate S1. Watching a takeover makes it visible sooner. It does
  not prevent it, and copy that suggests otherwise is a bug against ADR 0081.
- It does not make the thought lane trustworthy. The model narrates; the action
  lane is what happened. A reviewer who reads the rationale as an execution trace
  is reading the wrong lane, and where the two disagree the UI is at fault for
  presenting them as peers.

## Residual risks

- **S1**, in full. Mitigated operationally, never eliminated.
- A default-on policy can lock a user out of a third-party account. S2 shrinks
  the window; verify-before-revoke makes it recoverable rather than terminal.
  It does not reach zero.
- A relying party can rate-limit, challenge, or suspend an account that it
  believes is being automated, including one being rotated legitimately.
- Corpus recipes are structure, but a reviewer can still be wrong. Signing and
  the canary requirement bound this; review quality is the remaining control.
- **S5**, in full. A compromised viewer client reaches the control lease, and no
  server-side control distinguishes it from the owner.
- The render rules that keep the thought lane inert are interface obligations,
  and interface obligations decay faster than type-level ones. Capture-time
  stripping (`UntrustedText`) is the part that does not.
