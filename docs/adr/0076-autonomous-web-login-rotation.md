# ADR 0076 — Autonomous web-login rotation through remote agent browsers

Status: Proposed
Date: 2026-08-31
Supplements: ADR 0005 ([ConnectionRef over SecretRef](0005-authority-handle-connectionref.md)),
ADR 0021 ([frozen intent](0021-frozen-intent.md)), ADR 0037 (git-native sealed store),
ADR 0039 ([event-driven backup](0039-event-driven-github-backup.md)),
ADR 0046 ([relayed execution](0046-relayed-execution-and-authorization-inbox.md)),
ADR 0048 §D4 (capability classes), ADR 0049
([derived short-lived materialization](0049-derived-short-lived-materialization.md)),
ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md))
Supersedes in part:
[ADR 0052 — password-manager ecosystem bridging](0052-password-manager-ecosystem-bridging.md)
§11 and §14, **only** their refusal of programmatic third-party password change,
and only under the constraints of §3 below.
Extended by: ADR 0081
([live session observation](0081-live-session-observation.md)) — §4's replay
overlay and interactive attach, made live and given a transport, an entitlement
rule and a control-handoff protocol.
References: [placeholder-substitution audit](../security/audit-2026-08-08-placeholder-substitution.md),
RFC 8615 (well-known URIs), W3C Change Password URL

## Context

Rotation already exists in this repository and is not in question.
`crates/rotation` is a fifteen-state verify-before-revoke machine with Kani
proofs, a Shuttle concurrency test and a fuzz target;
`crates/connection-broker/src/rotation.rs` holds durable policies and jobs;
`apps/gateway/src/routes/rotation.rs` serves `/api/v1/rotations` and
`/api/v1/rotation/policies`; and since ADR 0074 the lifecycle scanner in
`apps/gateway/src/lifecycle/` detects what is due and drives rotation as one of
its responders. What exists rotates two target classes: a connection,
whose "rotation" is an OAuth refresh, and a sealed-store path, which is
deferred to the human CLI with the honest detail string
`store_path rotation requires the sealed-store CLI`.

The gap is the case that covers most of a person's credentials: a password at
a consumer website with no rotation API, no mint path, and no broker adapter.
ADR 0052 §14 routes exactly this case to `needs-human`, and says why:

> `auto` is a statement about *consent*, never a licence to invent a capability
> a provider does not offer — and for consumer web logins, which is exactly
> where the Apple-Passwords comparison points, full automation is structurally
> unavailable. The toggle must not imply otherwise.

§11 is blunter:

> there is no way to make a third party's account settings page programmatic,
> and pretending otherwise ships a feature that fails silently.

Both sentences were right about the mechanism available when they were written:
a static per-relying-party checklist cannot survive a site redesign, so a
product built on one fails silently, which is worse than not shipping it. This
ADR does not claim they were wrong. It claims a different mechanism is now
available — a browser driven by a model, which adapts to a redesign instead of
breaking on it — and that the mechanism is safe to use **only** because the
failure mode §11 warned about can be made loud instead of silent.

One correction to the comparison §14 names. Apple does not autonomously rotate
passwords. Apple publishes the `/.well-known/change-password` convention and
maintains the `apple/password-manager-resources` corpus, and Safari **deep-links
the human** to the right settings page. That is the bottom rung of the ladder
below, it is the well-trodden part, and this ADR must not borrow its
credibility for the rungs above it. The autonomous rungs are new, and every
serious risk here lives in them.

## Decision

### 1. The agent orchestrates; deterministic tools hold the secrets

ADR 0052 §13 already states this principle for the scheduling layer. This ADR
extends it, unchanged, to DOM actions. The agent driving the browser is fully
inside the credentialed loop — it decides what to click, what to fill and when
to submit — and it never receives a secret value, because the tools it calls
produce credentials into fields and return only an outcome.

The sandbox tool surface is:

- `fill_credential(ref, selector)` — a deterministic controller resolves the
  reference and types the value through CDP `Input.insertText`. Returns
  `{ok: bool}`. This is ADR 0005's ConnectionRef-plus-Intent shape applied to a
  DOM node: the agent names *which* credential and *where*, never *what*.
- `generate_candidate(composition_policy)` — returns a **handle**, not a value.
- `navigate`, `submit`, `read_dom_redacted`, `screenshot_redacted`.

There is no `read_field_value` and no `get_secret`, in the same structural
sense as `wit/connector/world.wit` having no `secrets.get`: the tool does not
exist, so no check has to deny it.

Redaction is **at capture, never at render**. `read_dom_redacted` strips the
value of every `input[type=password]` and of any live candidate handle before
the DOM string is serialized; `screenshot_redacted` masks credential-field
bounding boxes in the capture pipeline before an image exists. A redaction
applied when a transcript is displayed is not redaction, because the unredacted
form was already written down.

### 2. Rotation resolves down a capability ladder, and passkey migration is above it

ADR 0048 §D4's acquisition preference (MINT → INVOKE-THROUGH → IMPORT) is
extended, not replaced. For a login credential the ladder is:

| Tier | Mechanism | Default |
|------|-----------|---------|
| T0 | **Passkey migration.** The relying party is passkey-capable → enrol a vault-custodied passkey and retire the password (ADR 0052 §10 custody, §11 retirement). | on |
| T1 | **Mint.** Provider-native short-lived materialization (ADR 0049). | on |
| T2 | **Invoke-through.** Broker-driven API rotation under the ADR 0048 §7 egress fences. | on |
| T3 | **Deterministic web.** `/.well-known/change-password` plus a signed recipe, replayed by a deterministic executor with no model in the loop. | on |
| T4 | **Agentic web.** A model plans against a redacted DOM and calls the §1 tools. | gated |
| T5 | **Blocked.** Notify, then a teaching session (§4), which produces or repairs a recipe and returns the target to T3. | on |

T0 outranks rotation deliberately. Where a site supports passkeys, refreshing
the password is the weaker action: enrol-and-retire removes the credential
instead of replacing it, and no plaintext exists during the ceremony to
protect. Rotating a password on a passkey-capable relying party is a bug
against this section.

"Enabled by default" means T0 through T3 and T5 evaluate and execute
unattended. T4 additionally requires a one-time consent and a per-domain
opt-in. A target with no recipe and no well-known URL lands in T5. It never
improvises.

### 3. The constraints that bound the supersession

The supersession of ADR 0052 §11 and §14 holds only while all of the following
hold. Removing any one of them voids it and returns consumer web logins to
`needs-human`.

1. No secret value reaches a model context, a transcript, a screenshot or a
   recording. Redaction is at capture (§1).
2. The candidate is sealed **and its backup acknowledged** (ADR 0039 outbox)
   before any submission. A candidate lost after the site accepted it is an
   unrecoverable lockout, and the outbox is what makes "durably written" a
   thing the code can wait on rather than assume.
3. Candidate presence is asserted **fail-closed** immediately before submit. A
   credential field that did not receive a real value aborts the run. The
   forbidden implementation is fill-if-you-can-then-submit-anyway, which is how
   a user's password silently becomes a placeholder.
4. No CAPTCHA solving, no bot-detection evasion, no browser-fingerprint
   impersonation, no residential-proxy egress, and no retry pattern shaped like
   credential stuffing. A challenge routes to T5. A security product does not
   ship an anti-detection arms race.
5. Indeterminate outcomes park in `ReconciliationRequired` and raise a human
   notification. The previous value is never deleted before
   `RevocationVerified`.
6. T4 sandboxes are attested and either OpenSesame-operated or self-hosted.
   Never an arbitrary third-party browser service (§6 explains why this one is
   not negotiable).

### 4. Failure is a teaching session, not a dead end

This is the answer to §11's silent-failure objection, and it is what makes the
long tail tractable.

When a run blocks, the job parks and the user is notified with what was
attempted and where it stopped. The user then opens a **replay overlay** over
the recorded run: a scrubbable timeline of every action the agent took against
the page state at that moment, so "where did it go wrong" is a thing you look
at rather than guess. From there the user attaches interactively to the **same
sandbox** and demonstrates the way past the blocker.

Demonstrating in the sandbox rather than locally is a requirement, not a
convenience: the agent will replay in that environment, and a demonstration
recorded against a different browser, a different DOM and a different network
position teaches the wrong lesson.

The demonstration is captured **value-blind by construction** into a candidate
recipe — selectors, event sequence, navigation, waits, and *credential-field
references*. The recorder cannot capture a typed secret, in the same sense as
`crates/connection-detect`'s `CommandRunner`, whose contract returns an exit
status so that raw output cannot leak through it. The candidate is
canary-verified and signed, and subsequent runs on that domain drop to
deterministic T3.

Every run is recorded and replayable, not only failing ones. That is what gives
a receipt evidence anybody can check, and what makes recipe drift visible
before it becomes a failure.

### 5. Recordings are vault-class data

A recording with zero passwords in it still contains an authenticated view of
someone's account — balances, addresses, message subjects, security settings.
Recordings are sealed at rest, TTL-bound, excluded from every agent surface,
and never returned by an API that lists jobs. The retention default is the
observation window, not forever.

### 6. Egress substitution is rejected

An earlier shape of this design routed the sandbox's traffic through a
TLS-terminating proxy that swapped a placeholder for the real secret on the
way out, so that plaintext never entered the browser process at all. It is
rejected on three independent grounds, recorded here so it is not re-proposed.

**It is the generic string replacer ADR 0005 forbids.** That ADR's line is
"Gateway is **not** a generic string replacer; credential injection is bound to
connection egress (scheme/authority/path) + grant + intent." On the L2
connector path OpenSesame declares the request shape, so the binding is real.
In a browser rendering a third party's JavaScript, the *untrusted page*
generates the request, which makes the placeholder text itself the
authorization — precisely the High finding already recorded in
[the placeholder-substitution audit](../security/audit-2026-08-08-placeholder-substitution.md):
"The swap keys off the placeholder's text, which makes the text itself the
authorization: whatever string is named gets a secret written behind it." That
audit covers a *sandboxed WASM guest inside the host's trust boundary*. A
cloud browser running arbitrary site JavaScript is a strictly weaker position.

**It fails, silently, on the accounts that matter most.** Any page that
transforms the field before the wire — SRP, an in-page KDF, RSA-OAEP of the
password against a per-session public key — hashes the *placeholder*. The
natural rewriter default, replace-if-found-else-forward, then submits the
placeholder as the user's new password: a value that is not secret, and that
nobody holds. The sites doing this are disproportionately the
client-encrypted vaults and financial accounts a rotation policy most wants to
reach. Byte-level substitution also mangles secrets containing `&`, `=` or `%`
in form encoding, and cannot address JSON, multipart, gRPC-web or compressed
bodies without a parser per format.

**It buys less than it appears to.** See §7.

Placeholder delivery stays where it is sound: `CredentialDeliveryMode::Placeholder`
with a pinned `PlaceholderPlacement` and an exact egress row, on the connector
path where OpenSesame declares the request.

### 7. The session is the residual risk, and it is recorded rather than solved

To change a password the sandbox must first log in. From that moment it holds a
live first-party session, and a compromised sandbox can add a recovery address,
enrol its own second factor, or change the account email and trigger a reset —
taking the account over without ever learning the password.

No secret-handling design mitigates this. The §1 tool boundary protects the
*value*, not the session. Stating it precisely matters because the overclaim is
the failure mode ADR 0052 §12 exists to prevent, so the supportable claim is
"the secret is never in the transcript, the logs, or the screenshots", and the
unsupportable one is "the sandbox cannot take the account."

What follows from it: constraint 6 above (attested sandboxes only for T4), a
post-run diff of account-security state — recovery address, phone, MFA
enrolments, active sessions, API keys — surfaced to the user as part of the
receipt, and a sign-out-everywhere at run end.

### 8. Runner contract, not runner choice

The sandbox is remote and swappable. Playwright is a local driver and is
therefore not the contract; the contract is transport-level — CDP over a
WebSocket to a remote browser, plus the step IR and the §1 tool surface. A
self-hosted Chromium container and a hosted open-source agent-browser service
are then alternative implementations rather than forks.

No runtime LLM dependency enters a shipped binary. The model lives in the
remote runner, on the far side of the tool boundary, consistent with the
existing rule that no `@anthropic-ai/*` or `openai` dependency appears in
shipped code.

### 9. State machine: no new variants

`crates/rotation` is sufficient as written and gains no states.
`Scheduled → Discovering → CandidateGenerated → CandidateInstalled →
CandidateVerified → CandidateActivated → DependentsUpdated → Observing →
PreviousRevoked → RevocationVerified → Completed` maps directly, with a new
`RotationTarget::WebLogin` alongside `Connection` and `StorePath`.

Three semantics are specific to the web-login target class and belong in the
policy layer above `can_transition`, not in the machine:

- **`PreviousRevoked` is site-side and simultaneous with install.** The site
  kills the old password when it accepts the change. We are not the revoker,
  and the transition records an observation rather than an action.
- **`RevocationVerified` is never an active probe.** Proving the old password
  no longer works means deliberately failing a login, which increments lockout
  counters and looks exactly like credential stuffing. It is satisfied by the
  site's own change confirmation. This is ADR 0047's "a test is an oracle"
  applied to the other end of the credential's life.
- **Rollback is unavailable.** We cannot un-change a password on a third
  party's site, so a web-login job never enters `RollbackStarted`;
  indeterminate outcomes route to `ReconciliationRequired` with the previous
  value retained.

### 10. Agent-surface mapping

Per ADR 0065, each capability introduced here maps or is excluded with a
citation:

| Capability | cli | mcp_host | webmcp |
|---|---|---|---|
| `rotations.web_policy_read` | `opensesame rotate policy list` | `rotation_web_policy_read` | `opensesame_rotation_policy_read` |
| `rotations.web_policy_write` | `opensesame rotate policy set` | `rotation_web_policy_write` | excluded — configuration ceremony, ADR 0065 rule 5 |
| `rotations.teach_open` | `opensesame rotate teach` | excluded — human ceremony, ADR 0065 rule 5 | ceremony-open only, returns `{status: "ceremony_opened", location}` |
| `rotations.recording_read` | — | excluded — vault-class session capture, §5 above | excluded, same |

Nothing here returns a credential value, a recording body, or a candidate
handle's contents on any surface.

## Alternatives considered

**Keep `needs-human` and ship only the deep link.** What Apple does, and what
ADR 0052 §11 already specifies. It is correct, it never locks anyone out, and
it leaves the majority of a person's credentials rotating never. Retained as
T5's notification and as the terminal state when a teaching session is
declined.

**Drive the browser on the user's own device.** Satisfies ADR 0052 §2's
three-part plane test cleanly, inherits the user's real network position and
device reputation, and can perform WebAuthn step-up. Rejected as the primary
design because it cannot run while the machine is closed, which is most of when
a scheduled rotation wants to run. Worth revisiting as an additional runner
implementation under §8's contract, where it is a strictly better *option*
rather than a replacement.

**Relayed execution (ADR 0046): the remote agent proposes a frozen request,
the user's runtime replays it.** Attractive — it moves the request rather than
the credential, and ADR 0021's `FrozenIntentV2` would bind the proposal. It
founders on the session: the credential-bearing request needs the authenticated
session, and the session was established by the remote sandbox, so the residual
in §7 is not actually removed. Retained as a candidate for the narrower case
where a change endpoint is reachable with a session the local runtime already
holds.

**Recon-only agent: explore uncredentialed, author recipes, never log in.**
Safe and appealing, and rejected because most change-password forms sit behind
authentication, so the agent could not reach the thing it was meant to learn.
Its useful half — that agentic exploration should produce durable deterministic
recipes rather than one-off runs — is kept, as §4.

## Consequences

- **The long tail becomes reachable, and gets cheaper over time.** A site that
  needs T4 once needs T3 afterwards, because the run leaves a signed recipe
  behind. The expensive, non-deterministic tier is a bootstrap for the cheap
  deterministic one, not a permanent runtime cost.
- **§11's silent failure is answered by making failure loud, not by claiming
  reliability.** A blocked run notifies, parks, and hands the user a replay of
  what went wrong. This ADR does not claim third-party settings pages became
  programmatic. It claims failure can be made visible and recoverable, which is
  the property §11 actually required.
- **A default-on policy can lock someone out of a third-party account, and no
  amount of design removes that.** Constraints 2, 3 and 5 shrink the window;
  verify-before-revoke, already structural in `crates/rotation`, is what makes
  the failure recoverable rather than terminal. Anyone changing those
  constraints is changing a lockout probability, and should be made to say so.
- **A compromised T4 sandbox can take over the account it is rotating.**
  Recorded in §7 rather than mitigated away. It is the reason T4 is gated,
  attested-only, and off by default, while T0–T3 are on.
- **Recordings are a new class of sensitive data.** A feature that did not
  exist before now stores authenticated views of people's accounts. §5 seals
  and bounds them; the honest cost is that the blast radius of a gateway
  compromise grew.
- **This is a real increase in what the rotation subsystem is trusted with.**
  It gains a browser, a model, and a session. The `crates/rotation` state
  machine, its Kani proofs and its verify-before-revoke edge are load-bearing
  for all of it, and should be treated as security-critical code from here on.
- **Apple parity is claimed only where it exists.** T3 and T5 match what Safari
  does. T4 has no Apple counterpart, and product copy that implies otherwise is
  a bug against this ADR — the phrasing to grep for is "like Apple" and
  "automatic password change".
