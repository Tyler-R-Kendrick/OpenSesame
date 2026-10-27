# ADR 0213 — CUA password reset: deterministic recipes, bounded fallback, durable reconciliation

- **Status:** Proposed (design only; nothing in this ADR is built)
- **Date:** 2026-10-27
- **Amends (proposed):**
  - [ADR 0191](0191-forgot-password-ceremony-remote-browser.md) §1 and its
    architecture's crash rule, **only** to allow durable, read-only
    reconciliation and compensation after a crash. Blind autonomous resume and
    another password-request or password-set submit remain forbidden.
  - [ADR 0150](0150-surrogate-credentials-at-the-last-hop.md) §6.3, **only** for
    a password-set form whose recipe and actual intercepted request prove that
    the synthetic value reaches one declared field untransformed. The general
    prohibition on password-set substitution otherwise stands.
  - [ADR 0174](0174-the-pepper-is-the-persons-and-passwords-are-produced-by-one-facade.md)
    §1, **only** for this reset ceremony: the person is asked for their pepper
    once for each reset, and again only when human verification after an
    indeterminate submit needs it. It is never stored, chosen by the product,
    logged, or given to the model.
- **Builds on:** [ADR 0005](0005-authority-handle-connectionref.md),
  [ADR 0006](0006-env-spec-delivery-modes.md),
  [ADR 0076](0076-autonomous-web-login-rotation.md),
  [ADR 0081](0081-live-session-observation.md),
  [ADR 0086](0086-wallet-native-interaction-layer.md),
  [ADR 0090](0090-static-frontend-complete-without-backend.md),
  [ADR 0099](0099-scoped-local-agent-authority.md),
  [ADR 0130](0130-operator-controlled-capability-composition.md),
  [ADR 0149](0149-nothing-stored-in-the-clear.md),
  [ADR 0150](0150-live-sessions-browser-to-browser.md),
  [ADR 0157](0157-logs-and-events-carry-no-secrets.md),
  [ADR 0159](0159-agent-hooks-interceptor.md),
  [ADR 0186](0186-live-session-transport-port-and-catalog-greeting.md),
  [ADR 0190](0190-password-reset-mailboxes-are-vault-items.md),
  [ADR 0191](0191-forgot-password-ceremony-remote-browser.md), and
  [ADR 0196](0196-device-authorization-in-live-sessions.md).
- **Design:** [CUA password reset](../architecture/cua-password-reset.md).

## Context

ADR 0191 made a forgotten-password reset a fixed, value-blind ceremony through
a driver and a browser provider. Its deterministic spine is the cheap and safe
path, but three parts need to be made explicit for a computer-use agent (CUA):

1. An unfamiliar or changed page needs perception and selection, not an
   arbitrary agent with a shell and a password. The useful lesson of
   [CUA-JEV](https://github.com/ZJU-REAL/CUA-JEV) is the bounded loop: enumerate
   legal typed `intent × channel` candidates, select a candidate id, guard its
   fresh observation and authority, execute it, and verify new state
   independently. The model is not the guard or the verifier.
2. A browser action is not exactly-once merely because a workflow step is
   durable. [AI SDK `WorkflowAgent`](https://ai-sdk.dev/docs/agents/workflow-agent)
   documents durable steps and approvals, and also warns that replay does not
   guarantee exactly-once external effects. [Vercel Worlds](https://workflow-sdk.dev/worlds)
   separates event log, compute, and queue; the
   [Local World](https://workflow-sdk.dev/worlds/local) is explicitly a
   development component with an in-memory queue and no authentication. A reset
   therefore needs its own local, authenticated, sealed intent/outcome journal
   and an explicit indeterminate state, not automatic retry of a submit.
3. The credential boundary has to distinguish browser control from password
   delivery. CDP is the preferred control channel, the extension is the next
   channel for a person's own tab, and a proxy is the last control channel.
   Password delivery is the reverse where it is safe: exact-field proxy
   substitution is preferred; otherwise the real value is filled by CDP or the
   extension only at the last moment. A synthetic same-shape key is lawful only
   on the proxy route.

The person supplies the CUA browser/runtime and model. OpenSesame does not get
to turn that into arbitrary code execution, a default model dependency, or a
cloud control plane. [Cua](https://github.com/trycua/cua) provides useful prior
art for local computers, typed drivers, and person/agent handoff;
[agent-browser](https://github.com/vercel-labs/agent-browser) provides a native
CDP CLI with accessibility snapshots and element references. Both are optional
adapters behind OpenSesame's contract, not new trust assumptions.

## Decision

### 1. A reset is a local, per-run ceremony with four separated roles

The **static PWA** is the person's approval and takeover surface. It needs no
Identity API, Host, relay, or other backend to load or to complete the ceremony
with a local driver. The **driver** owns recipes, the journal, browser control,
and the exact secret callsites. The **CUA planner** sees only masked
observations and chooses among typed candidates. The **agent's own local
OpenSesame vault** holds the new password method and its algorithm parameters;
it is not the person's general PWA vault and its key is never delegated to the
planner, browser, model, proxy, or Host.

A run begins only with a person's transaction-bound approval. Its digest covers
the run id, agent instance, exact site origins, account reference, recipe and
configuration digests, model/provider custody, permitted channels, step and cost
budgets, expiry, and whether password-set substitution is allowed. Changing any
of them requires a new approval.

### 2. The model makes bounded typed decisions; deterministic code owns effects

The only planner response is a closed union: `act`, `wait`, `handoff`, `finish`,
or `refuse`. `act` names an observation id, a candidate id minted by the driver,
and an expected-effect id already attached to that candidate. It carries no
script, selector text, URL, shell command, field value, or arbitrary tool
arguments. The driver checks the observation is fresh, the candidate is still
legal and unique, the grant covers the effect, and the remaining budgets permit
it. An executor receipt is not success: an independent postcondition checks the
next state.

The driver, not the model, enumerates candidates from the current recipe or
masked browser state. Model prose, confidence, and claims of completion have no
authority. Invalid, late, duplicated, or out-of-scope decisions are typed
refusals. Page and mail content are untrusted data, never instructions.

### 3. A signed per-domain recipe is always tried first

A recipe pins origins, frame rules, navigation and form shapes, semantic and
selector anchors, expected observations, challenge recognizers, session shape,
mail matcher, budgets, and verification steps. Replay is deterministic and needs
no model. Each step checks the recipe digest, exact origin, frame, observation
epoch, and expected anchors before acting.

A mismatch is **drift**, not a reason to force a selector. Before submit, drift
stops replay, clears any filled credential in a context that can be closed
without submitting, and enters the same bounded planner used for an unknown
site. After a password-request or password-set submit, drift enters
reconciliation instead; the planner cannot “repair” it with another submit.

A successful fallback may distill a candidate recipe containing no values. It
remains `candidate` until the existing review, signature, and canary trust ladder
promotes it. A model cannot sign or promote its own recipe, and a recipe learned
for one registrable domain is not authority for another.

### 4. Control and secret delivery have separate, explicit orders

Browser control is **CDP first, extension second, proxy third**. The selection
is recorded in the approved run. There is no silent move between local and
hosted custody, and no fallback to a channel the person did not approve.
Arbitrary browser MCP tools and arbitrary `agent-browser` shell commands are not
exposed to the planner; adapters expose only the closed reset verbs.

Secret delivery is independent:

1. **Prefer the per-run surrogate proxy** when it is installed and enabled, the
   approval allows it, and the recipe qualifies under §5. The driver fills a
   synthetic same-shape key by reference. The agent never receives a real
   password, and the model still receives no field value.
2. **Otherwise fill the real value at the last moment** through CDP
   `Input.insertText`, or through extension fill-by-reference under ADR 0150's
   exact-origin, top-frame, focused-field, trusted-gesture rules. Fill occurs
   after navigation, challenges, field validation, candidate persistence, and
   immediately before the presence assertion and submit.
3. If neither route is available and approved, stop. Never put the password in a
   planner argument, model message, environment variable, journal event, CLI
   output, or generic MCP call.

A synthetic key is randomly generated, matches only the candidate's length and
required character classes, is not derived from it, and has no authority outside
its one run and exact form. It is forbidden on CDP and extension routes because
without exact-field substitution it could become the account's real password.

### 5. Password-set substitution is a narrow runtime proof, not text replacement

ADR 0150 §6.3's “password-set fields are never a substitution site” is amended
only where all of these hold:

- the signed recipe declares one POST action origin and path, one exact body
  field, and `application/x-www-form-urlencoded` or JSON with identity content
  encoding; multipart, redirects, duplicate fields, and every other encoding are
  refused;
- a reviewed canary trace established the form shape, and the actual request is
  intercepted before upstream transmission;
- the actual intercepted body contains the issued synthetic value exactly once,
  as the entire value of that declared field, with no other appearance or
  transformation;
- the run, caller, origin, path, method, recipe, grant, and ledger entry all
  match, and the response is scrubbed as ADR 0150 requires.

The proxy recognizes and re-places; it never performs a generic string replace.
A hash, encryption, encoding, split, or any other transformation fails closed.
If the proxy can prove the request was aborted before any upstream bytes were
sent, the run may return to real CDP fill. Once transmission is uncertain, the
run is `submit_indeterminate` and reconciliation is the only path.

### 6. User-provided CUA components are validated at configuration time

Configuration uses the existing env-spec delivery discipline and trusted-exec
rules (ADR 0006). A browser/runtime executable is an exact pinned path or a
trusted executable resolved by the existing mechanism, with a minimal
allowlisted environment. Model credentials are references, never recipe or
journal values. No default CUA, model, remote browser, or model endpoint is
introduced.

At configuration time, before a run can be approved, OpenSesame validates:

- adapter and schema versions, executable/model identity, exact endpoint
  origins, redirect refusal, timeouts, and declared custody and egress;
- the complete decision schema against local fixtures, including malformed
  JSON, unknown fields and candidate ids, stale observations, free-form code,
  and attempts to return secrets or URLs;
- bounds on decisions, steps, tokens, concurrent calls, and cost, including an
  explicit stop condition (a durable agent loop is not implicitly bounded);
- masked fixture observations and screenshots, with canaries asserted absent
  from the actual model request and persisted model state;
- independent verification, human handoff, and failure behavior, not merely a
  successful happy-path response.

A model that cannot satisfy the structured contract is refused at configuration
time. Runtime validation still repeats on every decision. Cua, CUA-JEV-style
runtimes, `agent-browser`, and AI SDK `WorkflowAgent` may implement adapters;
none is required, auto-installed, or allowed to bypass the contract.

### 7. A local sealed journal makes recovery explicit

Inspired by Worlds' event-log/compute/queue separation, the driver persists an
append-only, single-writer **intent/outcome journal** locally. It is sealed at
rest, fenced by a writer lease, and contains typed ids, state transitions,
digests, counters, timestamps, and masked evidence references only. Passwords,
pepper, synthetic keys, reset links and codes, cookies, mailbox contents, raw
screenshots, and unmasked model messages are never journal values.

Every step has a stable idempotency key and two durable checkpoints: intent
**before** dispatch and outcome **after** the result is known. Retry is allowed
only for an operation classified idempotent, or when the journal proves dispatch
did not begin. A process crash between intent and outcome makes an external
side effect indeterminate; it never licenses automatic repetition. Journal
replay pins schema, recipe, configuration, and code versions and never executes
serialized model code.

The ADR 0191 no-resume rule is amended only as follows:

- after a crash, no autonomous browser mutation, mail request, link reuse, fill,
  or submit is resumed;
- a still-valid, or newly human-approved **reconciliation-only** grant may run
  bounded read-only checks, fresh-context login verification, cleanup, and the
  compensations in the architecture;
- `submit_indeterminate` resolves to `accepted`, `not_applied`, or remains
  `needs_human`; only `not_applied`, established without another password-set
  submit, permits a separately approved new run;
- a single-use reset link is never replayed automatically, and an expired grant
  never becomes authority merely because the journal survives.

This is durable reconciliation, not general workflow resume. In particular,
`WorkflowAgent` automatic retries must not wrap password-request, password-set,
or verification-submit effects without these guards.

### 8. Every interactive challenge belongs to the person

CAPTCHA and “verify you are human” checks are never solved or evaded. A required
mail code, TOTP, SMS or other 2FA code, and every passkey ceremony are human
takeover, even when a recipe recognizes the challenge. The person reads and
enters a mail or second-factor code directly; it never crosses the planner,
journal, credential proxy, or Host. Challenge takeover uses a direct
CDP/extension path or the provider's live view with the credential-substitution
proxy not in that request path; a proxy-only configuration that cannot provide
this handoff parks for manual recovery. Passkeys require the person's own
authenticator and gesture. ADR 0191's read-only mail handling may still open a
qualified link-only message; it does not turn a required code into an agent
input.

Takeover pauses the planner, checkpoints the wait, transfers ADR 0081's single
control lease to the person, and revokes driver input until the person returns
control or the lease expires. The driver then takes a fresh masked observation
and verifies that the challenge cleared. Timeout parks the run; it does not
lower assurance or try another route.

### 9. The new password uses the facade and lands in the agent's local vault

The default password method is algorithmic. The trusted CLI-side vault adapter
calls `producePassword`; neither the CUA runtime nor the browser learns an
algorithm, root, counter, or pepper position. Before any real or synthetic value
is filled, the method and its parameters are committed to the agent's own local
vault and the candidate checkpoint is durable.

For this reset-only exception to ADR 0174, the method has a pepper slot and the
person is asked for their pepper for every reset. The product never generates,
chooses, stores, seals, hashes, verifies, or logs that pepper. The trusted
callsite combines it with the facade's `head` and `tail` in memory only. An
indeterminate submit may require the person to enter it again for fresh-login
verification; there is still no local “wrong pepper” check—the site's response
is the only test.

The existing [`AgentClient`](../../packages/agent-client/src/index.ts) remains
the one-use launch-handle exchange and short-lived, exact-resource capability
client; it is not described as a vault API and never receives vault key
material. The existing CLI `VaultStore` path remains the local encrypted vault
implementation. A trusted adapter joins the two: `AgentClient` authorizes the
run's closed operations, while only the CLI-side vault adapter opens the
agent-dedicated state directory and commits the password method. The planner
has neither import path nor IPC method for a raw vault read.

### 10. Static-first transport and least-privilege authority

The PWA talks to the driver through the ADR 0186 transport port. WebRTC using
ADR 0150's consent and route rules is the static-first remote path; a Host may
optionally carry the same closed run messages where one is already configured.
ADR 0196's device pattern supplies approval and seat binding with an empty vault
catalog, not its generic read-only connection-call table. Neither WebRTC nor a
Host transports plaintext credentials, pepper, unmasked observations, or model
state. No new backend is required by the PWA.

Every capability has its own human-approved, per-run grant: domain metadata,
item use, mailbox, browser, runtime, model, proxy, password production, takeover,
reconciliation, and compensation. Each names one agent instance, exact action
and resource, short expiry, budget, proof key, no redelegation, and
`raw_credential_export: false`. First, `password_reset.domain_metadata.list` on
`password-reset:domain:<domain>:metadata` permits only a domain-scoped,
metadata-only PAM query. Selecting a login requires a narrower exact-item grant;
no wildcard or sibling capability is implied. Enforcement uses `Grant`'s
`assert_active` and `permits_resource` plus exact `Intent` operation, resource,
and run audience. `InvocationState` remains the Host lifecycle; local
`submit_indeterminate`, reconciliation, and compensation never pretend that
`Executing -> Succeeded` is safe before independent verification.

### 11. Screenshots and model state are masked before either leaves the driver

The default observation is a masked structured accessibility/DOM state. All
input values, identifiers, concealed fields, reset links and query/fragment
tokens, cookies, mail, codes, QR/recovery material, and credential-shaped text
are removed at capture. URLs are reduced to the approved origin and recipe path
class before entering model state.

Screenshots are optional, scoped to the target browser viewport, and masked
locally before model upload or persistence. Sensitive regions from the same
layout epoch are opaque-masked, not blurred; a region that cannot be aligned
with fresh state masks the whole image. Raw screenshots stay in volatile driver
memory and are never journaled. Diagnostic artifacts, if enabled, contain only
masked images, sealed locally with a short retention.

Durable planner context contains candidate ids, typed verdicts, and digests, not
raw prompts or credentials. Model request/response state is masked with the same
rules before it reaches a workflow event log, telemetry, trace, WebRTC frame,
Host record, or retry stream. A redaction failure blocks the model call.

## Consequences

- Deterministic per-domain replay is the normal path; model cost and exposure
  are paid only for an unknown or drifted flow.
- A CUA chooses among legal actions but cannot mint authority, execute code, or
  obtain the old/new password, pepper, reset capability, or second factor.
- Durability improves diagnosis and safe completion without pretending that
  external browser effects are exactly-once.
- The static PWA remains complete without a backend. Local operation and WebRTC
  need no Host; a Host is an optional value-blind transport, not a secret owner.
- Proxy substitution becomes possible for a narrowly proven password-set form,
  while transformed forms retain ADR 0150's original protection and use real
  last-moment fill.
- The agent owns a durable local password method, but a peppered password still
  requires the person at production and at any later use. This is deliberate.
- The design adopts ideas and optional adapters from Cua, CUA-JEV,
  `agent-browser`, and WorkflowAgent/Worlds. It does not adopt their general
  tool authority, unbounded loops, automatic side-effect retry, hosted custody,
  or development-only local queue as OpenSesame defaults.

## Verification

Implementation must include:

1. schema and adversarial-model tests for every decision and configuration
   refusal, including config-time canary leakage checks;
2. recipe replay and drift fixtures for unknown, changed, duplicated, hidden,
   cross-origin, transformed, and challenge states;
3. grant scope, expiry, replacement-attenuation, resource-pattern, and
   invocation/reconciliation mapping tests against `crates/domain`;
4. crash injection at every intent/outcome boundary, duplicate delivery,
   stale-writer fencing, idempotent retry, and proof that neither submit is
   repeated after an indeterminate outcome;
5. submit-indeterminate reconciliation matrices and compensation tests,
   including a lost response after the site accepted the candidate;
6. proxy conformance for exact-field replacement, every transformation and
   encoding refusal, before-egress abort versus unknown transmission, response
   scrubbing, and the rule that synthetic keys never occur without a proxy;
7. vault/facade tests proving candidate persistence precedes fill, algorithmic
   production is the default, pepper is requested each reset and absent from
   every artifact, and AgentClient never becomes a vault-read interface;
8. screenshot, DOM, model-state, journal, log, receipt, Host, and WebRTC canary
   tests, including raw-image absence and masking-failure refusal;
9. human-takeover tests for CAPTCHA, required mail code, TOTP, passkey, SMS and
   generic 2FA, lease expiry, timeout, and fresh-state verification;
10. end-to-end fixture-site runs with no backend, with real WebRTC, and with the
    optional Host transport; transport-order and no-silent-custody-fallback
    tests; and adapter conformance for each shipped CUA/browser integration.

The normal repository gates, the relevant browser journeys, and security audits
apply when this is implemented. No provider or model ships without its real
conformance run.

## References

- [trycua/cua](https://github.com/trycua/cua) — local computers and typed
  desktop/browser drivers with human handoff.
- [ZJU-REAL/CUA-JEV](https://github.com/ZJU-REAL/CUA-JEV) — legal typed
  candidates, guarded execution, independent verification, and explicit limits
  of the research evidence.
- [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) —
  native CDP browser CLI, accessibility snapshots, and element references.
- [AI SDK WorkflowAgent](https://ai-sdk.dev/docs/agents/workflow-agent) —
  durable agent steps, human approvals, bounded-loop controls, and replay
  limitations for external effects.
- [Vercel Worlds](https://workflow-sdk.dev/worlds),
  [Local World](https://workflow-sdk.dev/worlds/local), and the
  [durable-execution architecture](https://vercel.com/blog/a-new-programming-model-for-durable-execution)
  — event log, compute, queue, and why the development Local World is not this
  design's production journal.
