# Web-login rotation

How a password at a consumer website gets rotated without the user doing it.
Decision record: [ADR 0076](../adr/0076-autonomous-web-login-rotation.md).
Teaching and replay: [rotation teaching and replay](rotation-teaching-and-replay.md).
Recipe format: [rotation recipe schema](rotation-recipe-schema.md).

## What already exists

Rotation is not new here. Before reading further, know that all of this is
built and tested:

| Layer | Path |
|---|---|
| Verify-before-revoke state machine (Kani + Shuttle + fuzz) | `crates/rotation/src/lib.rs` |
| Durable policies, jobs, orchestration | `crates/connection-broker/src/rotation.rs` |
| HTTP surface | `crates/gateway/src/routes/rotation.rs` |
| Expiry detection and dispatch | `crates/gateway/src/lifecycle/` (ADR 0074) |
| Sealed-store value update | `crates/sealed-store/src/update.rs` |
| Agent surface | `rotations.read`, `rotations.trigger`, `connections.rotate` |

Two target classes exist: `Connection` (whose rotation is an OAuth refresh) and
`StorePath` (deferred to the human CLI). Web-login rotation adds a third,
`WebLogin`, and an executor for it. It adds **no new states**.

## The ladder

Rotation resolves to the highest tier available for the target. Capability sets
the ceiling — the rule from ADR 0052 §14, extended with two new rungs.

```
T0  passkey migration     enrol vault-custodied passkey, retire password
T1  mint                  provider-native short-lived token (ADR 0049)
T2  invoke-through        broker API call under egress fences (ADR 0048 §7)
T3  deterministic web     well-known URL + signed recipe, no model
T4  agentic web           model plans, calls credential tools
T5  blocked               notify -> teaching session -> recipe -> back to T3
```

T0–T3 and T5 are on by default. T4 needs one-time consent plus a per-domain
opt-in. Nothing improvises: a target with no recipe and no well-known URL goes
to T5.

That is the policy of ADR 0076 §2 (the ADR is still Proposed), not a function in
this checkout: `execute_rotation` dispatches on the target kind, and the Host
records every web-login run it starts as tier `t3`
(`crates/gateway/src/web_login/launch.rs`). Nothing here starts a T4 run, so the
T4 consent and per-domain opt-in are not enforced anywhere yet.
`crates/ceremony`'s `resolve` applies the same ladder shape to registration
ceremonies.

T0 sits above rotation on purpose. On a passkey-capable relying party,
enrol-and-retire removes the credential rather than refreshing it, and no
plaintext exists during the ceremony. Rotating a password there is a bug.

## The tool boundary

This is the part that makes the rest defensible. ADR 0052 §13 already says "AI
orchestrates; deterministic code holds the secrets" about job scheduling. Web
rotation applies the same sentence to DOM actions.

The agent is fully in the credentialed loop — it decides what to click and when
to submit — and never receives a secret value.

```
agent  --fill_credential(ref, "#new-password")-->  controller
                                                        |
                                                        | resolve ref
                                                        | CDP Input.insertText
                                                        v
agent  <---------------- {ok: true} ------------------ browser
```

Tools available in the sandbox (`BrowserTransport` in `crates/rotation-web`):

| Tool | Returns |
|---|---|
| `fill_credential(ref, selector)` | `Filled` — whether it landed, never the value |
| `assert_present(ref, selector)` | `Presence` (`Present`, `Absent`, `Mismatch`) — answered by the controller, which knows both sides |
| `navigate(url)`, `wait_for(selector)` | ok, or a typed `StepError` |
| `submit(selector)` | ok, or a typed `StepError` |
| `read_dom_redacted()` | `RedactedDom` — DOM with credential values stripped |
| `screenshot_redacted(mask)` | an admitted frame, or nothing when no mask covers the layout |
| `verify_login(ref)` | `Verified` (`Works`, `Rejected`, `Indeterminate`) |

Generating a candidate is not a sandbox tool: the vault does it
(`CandidateVault::generate_candidate`) and hands the tools a **handle**
(`CandidateHandle`), never a value.

There is no `read_field_value` and no `get_secret`. Not denied — absent, the
way `spec/wit/connector/world.wit` has no `secrets.get`.

**Redaction is at capture, never at render.** `read_dom_redacted` strips
`input[type=password]` values and live candidate handles before the string is
serialized. `screenshot_redacted` masks bounding boxes in the capture pipeline,
before an image exists. Redacting at display time is not redaction — the
unredacted form was already written down.

The same discipline already appears twice in this repo, and both are worth
copying rather than reinventing: `crates/connection-detect`'s `KeychainBackend`
returns labels and cannot return values, and its `CommandRunner` returns an
exit status so raw output cannot leak through it.

## Why not substitute secrets in browser egress

An earlier design routed sandbox traffic through a TLS-terminating proxy that
swapped a placeholder for the real secret on the way out, so plaintext never
entered the browser at all. It is rejected — ADR 0076 §6 has the full argument.
The short version, because it is the first idea everyone has:

- It is the "generic string replacer" ADR 0005 forbids. The untrusted page
  generates the request, so the placeholder text becomes the authorization.
  This repo already found and fixed that exact bug in a safer setting:
  [audit-2026-08-08-placeholder-substitution](../security/audits/2026-08-08-placeholder-substitution.md).
- Any page that hashes or encrypts the field before the wire — SRP, an in-page
  KDF, RSA-OAEP against a session key — transforms the *placeholder*. A
  replace-if-found-else-forward rewriter then sets the user's password to a
  non-secret string nobody holds. The sites doing this are disproportionately
  the client-encrypted vaults most worth rotating.
- It protects the password while the sandbox still holds the session, which is
  the more valuable thing. See below.

[ADR 0150](../adr/0150-surrogate-credentials-at-the-last-hop.md) §6.3 later
admitted one narrower thing, for logging in only and never for a field that
sets a password: a recipe may declare the one field of the one login POST, and
the runner types a surrogate (`osr_…`) that its egress hook re-places with the
credential through the body format's own encoder. It is an optional, default-off
plugin feature (`login-surrogate` in `crates/rotation-web`, see its README), and
the rejection above stands for rotation itself.

## The residual risk

To change a password the sandbox must log in first. It then holds a live
first-party session and could add a recovery address, enrol a second factor, or
change the account email and trigger a reset — full takeover, no password
needed.

The tool boundary protects the *value*, not the session. Nothing in this design
changes that, so the claim to make is:

- supportable: the secret is never in the transcript, the logs, or a screenshot
- **not** supportable: the sandbox cannot take the account

Mitigations are operational, not cryptographic. ADR 0076 §7 names them: T4
sandboxes are attested and OpenSesame-operated or self-hosted; every run ends
with a diff of account security state (recovery address, phone, MFA enrolments,
active sessions, API keys) surfaced in the receipt; every run ends with
sign-out-everywhere. No code in this checkout produces that diff or signs the
account out yet.

## State machine mapping

No new variants. `RotationTarget::WebLogin` walks the existing path:

| State | Web-login meaning |
|---|---|
| `Scheduled` | policy tick selected the target |
| `Discovering` | resolve `/.well-known/change-password`, load recipe, probe capability |
| `CandidateGenerated` | CSPRNG value under the site's composition rules |
| `CandidateInstalled` | sealed **and backup-acknowledged**, then submitted |
| `CandidateVerified` | fresh login in a clean context succeeded |
| `CandidateActivated` | promoted to primary in the vault |
| `DependentsUpdated` | sync targets and dependent configs updated |
| `Observing` | soak window; previous value still retained |
| `PreviousRevoked` | observation, not action — see below |
| `RevocationVerified` | site's own change confirmation — never a probe |
| `Completed` | sink |

Three target-class semantics live in the policy layer above `can_transition`,
not in `crates/rotation`:

**`PreviousRevoked` is site-side and simultaneous with install.** The site
kills the old password the moment it accepts the change. We are not the
revoker; the transition records that it happened.

**`RevocationVerified` is never an active probe.** Proving the old password no
longer works means deliberately failing a login — which increments lockout
counters and looks exactly like credential stuffing. It is satisfied by the
site's change confirmation. ADR 0047's "a test is an oracle", applied to the
other end of the credential's life.

**Rollback is unavailable.** We cannot un-change a password on a third party's
site. A web-login job never enters `RollbackStarted`; an indeterminate outcome
routes to `ReconciliationRequired` with the previous value retained, which is
what `RotationError::Indeterminate` ("unknown provider outcome — reconcile
before retry") already names.

## Ordering that must not be rearranged

```
generate candidate
  -> seal to vault
  -> WAIT for backup acknowledgement (ADR 0039 outbox)
  -> assert candidate present in field  [FAIL-CLOSED]
  -> submit
  -> verify by fresh login
  -> promote
```

Two of these are the difference between a rotation and a lockout:

**Backup acknowledgement before submit.** A candidate lost after the site
accepted it is unrecoverable. ADR 0039's outbox writes the event in the same
transaction as the mutation, which is what makes "durably written" something
the code can wait on rather than assume.

**Fail-closed presence assertion before submit.** A credential field that did
not receive a real value aborts the run. The forbidden implementation is
fill-if-you-can-then-submit-anyway; that is how a password silently becomes a
placeholder.

This ordering is a good candidate for a `pact::assert_source_order` test
alongside the existing `rotation_authorizes_then_loads_connection_then_enqueues`
in `crates/gateway/src/lib.rs`.

## A person asks for the page mid-run

The Host's runner keeps the executor's `ControlLease` in memory, and the control
routes write the run's *row*. `crates/gateway/src/web_login/control.rs` is the
executor's lease projected onto that row, consulted around every step the step
queue hands the owner's browser:

- **Before a step**, `agent_driving` goes ahead; an accepted
  `handoff_requested` parks the run right there — `awaiting_human`, nothing
  enqueued — and every state that is a person's (`awaiting_human`,
  `human_driving`, `resume_requested`, `suspended`) refuses the step. The queue
  itself refuses too (`enqueue_runner_step` and `claim_runner_step` admit only
  `agent_driving` and `handoff_requested`), so no caller has to remember it.
- **Around the critical section.** The gate opens the span on the row when it
  lets `assert_present` through, so a handoff asked for inside it is *queued* by
  the routes, and it never parks between the assertion and the submit. When the
  submit returns the span closes, the queued handoff is released, and the next
  step — the verification — parks. The change was submitted and not confirmed,
  so the job reconciles; it never reads as "not submitted".
- A run a person asked for is left **open** so they can take it; the job is
  settled at once, with the reason the run stopped. The reaper closes it once
  it has outlived the policy lease and nobody holds it.

A gateway that stops mid-run leaves a `discovering` job and an open run. The
reaper (`web_login/reaper.rs`) closes runs and parks jobs whose claim lease
(`web_login_job_claims`) has lapsed, at startup and on a timer, with the detail *the run stopped
before it settled; whether the site received the change is unknown*.

## The hooked path

Every run the Host executes is an
[agent-hooks/0.1](https://github.com/responsibleai/agent-hooks/blob/v0.1.0-alpha.5/spec/AGENT-HOOKS-0.1.md)
session ([ADR 0159](../adr/0159-agent-hooks-interceptor.md)). The Host does not
call the executor bare. `Harness::open` in `crates/gateway/src/web_login/launch.rs`
builds a `HookedTransport` over an `ExtensionTransport` whose step channel is the
step queue, registers the organization's own `OpenSesameInterceptor` (and, when an
approver is configured, a per-run approval seam) on the `HookSession`, and drives
`run_change_password_hooked`:

```text
agent_startup -> input -> [ pre_tool_call -> step queue -> driver -> post_tool_call ]* -> output -> agent_shutdown
```

- **A verb the policy denies is never enqueued.** A `pre_tool_call` deny means the
  inner verb is not called, so the driver never sees the step and the executor's
  fail-closed handling takes over: nothing is submitted after a refused fill or
  assertion. A refusal of the submit itself settles the job as "not submitted".
- **An escalation holds the run.** Nothing is enqueued until the person the
  organization named approves the interaction bound to that step's
  `context_identity`; a decline, a deadline or an unconfigured approver leaves the
  step undispatched.
- **Custody is not hooked.** Generating, sealing and promoting the candidate are
  Host-owned steps with acknowledgement-only outcomes and are not tools in the
  agent's surface. A policy cannot name them, but the hooked `navigate` and
  `wait_for` that precede them still gate whether custody is reached.
- **Authority is pinned.** An interceptor's transform may rewrite a selector or a
  same-origin path; it cannot change which credential is filled, which slot a
  capture seals into, or the origin a navigation reaches.
- **The record is payload-free.** Each interception is a row in `agent_hook_records`
  (point, decision, machine reason, the before and after context identities),
  flushed before the next step reaches the driver, and removed with its run. The
  Host holds no viewer key, so a hosted run seals no log: its observation is
  these records (`GET /api/v1/agent/runs/{id}/hook-records`).
- **A run is closed before its job settles,** and a run a stopped gateway left open
  is closed by the reaper; runs are never resumed, because after a crash whether the
  submit reached the site is unknown.
- **A driver's answer is canonical or refused.** The settle route decodes the outcome
  into the step's own outcome type and stores the canonical re-encoding; an unknown
  field or an outcome for another step is `422`.
- **The recipe is signed.** A run replays only a document whose Ed25519 signature
  verifies against an organization-pinned signer that is still pinned, and an
  unattended run additionally needs a passing canary no older than 90 days.

## The extension runner

The default browser extension is the local runner of the step protocol
(`apps/browser-extension/runner`, ADR 0159 §16). It is the driver on the far side of
the queue for a run whose credential its person owns: it claims a step with the
person's Host session, executes it in the isolated world of the one tab on the run's
origin, and settles an outcome built by closed constructors that mirror the Host's
`StepOutcome`. It runs only while the person has armed the origin (an optional
`scripting` permission and one optional host permission, granted on the person's own
click and removed when the run closes or the 30-minute arm lapses), stops claiming at
the next poll when a person asks for the page, presses a submit at most once, and
proves the new password in a private window. It has no vault of its own: the
credentials it holds are sealed at rest, and `seal_candidate` reports `backed_up`
only after a recovery recipient's envelope has been pushed and read back. It answers
`failed(transport)` for the two capture steps, since no host envelope scheme exists
for them. A remote CDP sandbox remains an alternative transport (below); the
extension is the one in this repository.

## Runner contract

The sandbox is remote and swappable. **Playwright is a local driver and is not
the contract.** The contract is transport-level:

- CDP over a WebSocket to a remote browser, or the browser extension's local
  runner over the same step queue
- the step IR (see [recipe schema](rotation-recipe-schema.md))
- the tool surface above, with redaction applied inside the runner

A self-hosted Chromium container and a hosted open-source agent-browser service
are then alternative implementations, not forks.

No runtime LLM dependency enters a shipped binary. The model runs in the remote
runner, on the far side of the tool boundary — consistent with the existing
rule against `@anthropic-ai/*` or `openai` in shipped code.

## Relying-party data ships checked in

Change-password URLs need no corpus: RFC 8615 makes the path well-known, so
`https://{host}/.well-known/change-password` is derived, not looked up. Only
composition-rule quirks and non-conforming sites need data, and per ADR 0052
§12 that data ships **checked in and refreshed by a routine** — "a lookup is a
disclosure".

Before vendoring anything from `apple/password-manager-resources`, verify its
license against the `deny.toml` allowlist. ADR 0052 §3 draws the line
(implementing from a public specification is fine; copying source is not) and
ADR 0048 §9 records the license trap that makes this worth checking rather than
assuming.

## Code homes

Where each piece lives. The hooked path above is wired in `crates/gateway/src/web_login`.

| Change | Where |
|---|---|
| `RotationTarget::WebLogin` + `from_parts` + DDL `CHECK` | `crates/connection-broker/src/rotation.rs`, `store.rs` |
| Recipe evaluation, step IR, runner trait | `crates/rotation-web` |
| Web-login executor dispatch | `execute_rotation` in `crates/connection-broker/src/rotation.rs` (parks the job when no runner exists) and `rotation_web_login*.rs` (the hosted run's job life) |
| Routes for rotation policies and jobs | `crates/gateway/src/routes/rotation.rs` |
| Live observation lanes, frame admission, control lease | `crates/session-observe` (ADR 0081) |
| Sealed observation log, observe/control routes | `crates/storage/src/observation.rs`, `crates/gateway/src/routes/agent_runs.rs` |
| Registry entries | `packages/capability-registry/src/index.ts`, `agent-hooks.ts`, `web-login-recipes.ts`, `extension-runner.ts`, then regenerate `capabilities.json` |
| Hooked executor, signed recipe document | `crates/rotation-web/src/hooks`, `crates/rotation-web/src/recipe_doc` (ADR 0159) |
| Runner, claim, reaper, settle route, recipe and signer routes | `crates/gateway/src/web_login`, `crates/gateway/src/routes/{agent_runs,web_login_recipes}*`, `crates/storage/src/web_login_runs*` |
| Local runner | `apps/browser-extension/runner` |

The new crate must **not** become a daemon dependency —
`scripts/audit/daemon-deps-gate.sh` audits `invoke-through`, `tailscale-authn` and
`uds-authn` trees, and ADR 0053 §2's rule is that the daemon depends on none of
this. A browser driver in the daemon's tree would be a large regression.

## Two gaps that are now closed

Both were pre-existing defects that web-login rotation would have made
dangerous. Both are fixed; they are recorded here because the reasoning is the
same reasoning the tiers above rely on.

**Rotation now claims a lease before acting.** The old `rotation_scheduler.rs`
listed enabled policies and executed each due one with no lease, so two gateway
processes both executed the same policy — for a password change, a lockout.

ADR 0074 then replaced that scheduler with the lifecycle scanner, and moved the
defect rather than fixing it: `lifecycle::dispatch::publish` records a watermark
and then responds unconditionally, so two processes scanning concurrently both
evaluate the same subject as due and both respond.

The split is now clean. **The scanner decides *when* a policy is due; the
rotation responder decides *who* acts.** The responder claims through
`ConnectionBroker::claim_rotation_policy` before rotating and stands down if it
loses, so one credential is rotated once.

The claim deliberately does **not** re-check the interval. `subjects.rs` owns
that math now, and a second statement of the schedule would be a second
authority to drift from — the exact bug class this work exists to prevent. What
the claim owns is what the scanner has no view of: an unexpired lease held by
another process, a backoff that has not elapsed, and a parked policy.

A policy that exhausts its attempts **parks**: it stops retrying, stays
`enabled`, and raises `needs_attention`. It is deliberately not auto-disabled. A
rotation policy that silently switches itself off is the ADR 0052 §11 failure
mode — the operator believes credentials are rotating and they are not.

**The dispatcher claims too, so this holds for every subject.** The same
unconditional-respond path applied to certificates, authorities and signers, so
certificate renewal double-fired across processes for exactly the same reason.
`lifecycle::dispatch::publish` now treats the watermark write as the claim: only
the process that advanced it runs the responder.

The `WHERE` on that write mirrors `newly_crossed` and `Watermarks::effective`
exactly — a rung is new when the subject's expiry changed (the ladder reset) or
the incoming threshold is strictly further down. Anything else advances nothing
and claims nothing.

Publishing is deliberately *not* gated. A crash between emit and record
re-notifies rather than drops, which is the safe direction for an expiry notice
and what subscribers are built for. Acting is the opposite: renewing a
certificate twice is a real fault. So the claim gates the responder and nothing
else, and a watermark write that errors stands the responder down rather than
letting it act unclaimed.

**T2 verification is now real.** `execute_connection_rotation` used to record
`verify_skipped: provider catalog exposes no no-op verification invoke` and walk
`CandidateVerified` anyway. Honest, but it meant the machine's Kani-proven
verify-before-revoke edge proved nothing.

The broker now calls the provider's own read-only identity endpoint through the
`invoke-through` fences before activating a candidate. Three properties matter:

- **The daemon's egress allowlist is untouched.** `EGRESS_RULES` is a static
  that `crates/daemon` links and serves from `POST /v1/invoke_through`; adding
  providers to it would widen that surface for callers who never asked. The
  broker passes its own `ROTATION_EGRESS_RULES` through `Invoker::with_rules`,
  and a test pins the daemon's table to `github` only.
- **The fence bites before the credential is opened.** `preflight` runs first;
  `resolve_bearer` is only reached once it passes, so a denied verification
  never decrypts the credential. A `pact::assert_source_order` test pins that
  order in the source.
- **A rejection parks the job.** `refresh` has already activated the new token,
  so a rejection cannot be rolled back. The job goes to
  `ReconciliationRequired` with the previous value retained — the machine
  permits `CandidateInstalled → ReconciliationRequired` for exactly this case.

Verify endpoints ship as catalog data, and only for providers whose documented
endpoint is unambiguous. A provider without one still records the honest skip:
an invented path turns a verification into a false negative, which is worse than
admitting we cannot check.
