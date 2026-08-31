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
| HTTP surface | `apps/gateway/src/routes/rotation.rs` |
| Expiry detection and dispatch | `apps/gateway/src/lifecycle/` (ADR 0074) |
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

Tools available in the sandbox:

| Tool | Returns |
|---|---|
| `fill_credential(ref, selector)` | `{ok}` — never the value |
| `generate_candidate(composition_policy)` | a **handle**, never a value |
| `navigate(url)` | page state |
| `submit(selector)` | outcome |
| `read_dom_redacted()` | DOM with password values stripped |
| `screenshot_redacted()` | image with credential fields masked |

There is no `read_field_value` and no `get_secret`. Not denied — absent, the
way `wit/connector/world.wit` has no `secrets.get`.

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
  [audit-2026-08-08-placeholder-substitution](../security/audit-2026-08-08-placeholder-substitution.md).
- Any page that hashes or encrypts the field before the wire — SRP, an in-page
  KDF, RSA-OAEP against a session key — transforms the *placeholder*. A
  replace-if-found-else-forward rewriter then sets the user's password to a
  non-secret string nobody holds. The sites doing this are disproportionately
  the client-encrypted vaults most worth rotating.
- It protects the password while the sandbox still holds the session, which is
  the more valuable thing. See below.

## The residual risk

To change a password the sandbox must log in first. It then holds a live
first-party session and could add a recovery address, enrol a second factor, or
change the account email and trigger a reset — full takeover, no password
needed.

The tool boundary protects the *value*, not the session. Nothing in this design
changes that, so the claim to make is:

- supportable: the secret is never in the transcript, the logs, or a screenshot
- **not** supportable: the sandbox cannot take the account

Mitigations are operational, not cryptographic: T4 sandboxes are attested and
OpenSesame-operated or self-hosted; every run ends with a diff of account
security state (recovery address, phone, MFA enrolments, active sessions, API
keys) surfaced in the receipt; every run ends with sign-out-everywhere.

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
in `apps/gateway/src/main.rs`.

## Runner contract

The sandbox is remote and swappable. **Playwright is a local driver and is not
the contract.** The contract is transport-level:

- CDP over a WebSocket to a remote browser
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

## Intended code homes

For the implementation pass. Nothing below is built yet.

| Change | Where |
|---|---|
| `RotationTarget::WebLogin` + `from_parts` + DDL `CHECK` | `crates/connection-broker/src/rotation.rs`, `store.rs` |
| Tier resolution, recipe evaluation, step IR, runner trait | new crate, e.g. `crates/rotation-web` |
| Web-login executor dispatch | `execute_rotation` in `crates/connection-broker/src/rotation.rs` |
| Routes for policies, teaching sessions, recordings | `apps/gateway/src/routes/rotation.rs` |
| Registry entries | `packages/capability-registry/src/index.ts`, then regenerate `capabilities.json` |

The new crate must **not** become a daemon dependency —
`scripts/daemon-deps-gate.sh` audits `invoke-through`, `tailscale-authn` and
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

One residual, recorded rather than fixed here: the same unconditional-respond
path applies to every other lifecycle subject, so certificate renewal can still
double-fire across processes. That is a defect in ADR 0074's dispatcher, not in
rotation, and widening this change into it would have been a change nobody
reviewed.

**T2 verification is now real.** `execute_connection_rotation` used to record
`verify_skipped: provider catalog exposes no no-op verification invoke` and walk
`CandidateVerified` anyway. Honest, but it meant the machine's Kani-proven
verify-before-revoke edge proved nothing.

The broker now calls the provider's own read-only identity endpoint through the
`invoke-through` fences before activating a candidate. Three properties matter:

- **The daemon's egress allowlist is untouched.** `EGRESS_RULES` is a static
  that `apps/daemon` links and serves from `POST /v1/invoke_through`; adding
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
