# ADR 0159 — OpenSesame as an agent-hooks/0.1 interceptor and host

- Status: Accepted
- Date: 2026-10-03
- Builds on: [ADR 0005](0005-authority-handle-connectionref.md) (agents hold
  `ConnectionRef`s, never secrets), [ADR 0008](0008-better-auth-oidc-provider.md)
  (mature libraries over our own protocol code),
  [ADR 0046](0046-relayed-execution-and-authorization-inbox.md) (the
  authorization inbox; an approval only narrows),
  [ADR 0065](0065-agent-surface-parity.md) (every capability on the registry),
  [ADR 0065 — connector hooks](0065-connector-hook-architecture.md) and
  [`docs/research/hooks-ecosystem.md`](../research/hooks-ecosystem.md)
  (hooks as data, fail closed, never widening),
  [ADR 0076](0076-autonomous-web-login-rotation.md) (web-login rotation, its
  recipes and its custody ordering),
  [ADR 0081](0081-live-session-observation.md) (observation runs, the step
  queue, control handoff), [ADR 0082](0082-agent-run-registration-ceremonies.md)
  (capture ceremonies), [ADR 0084](0084-external-authorization-notifications.md)
  and [ADR 0086](0086-wallet-native-interaction-layer.md) (an approval counts
  only when its proof is bound to the request digest),
  [ADR 0139](0139-one-definition-every-target.md) (one definition, every
  target), [ADR 0146](0146-account-factor-removal-step-up.md) (the `step_up_required` refusal)

## Context

Agent frameworks each grew their own hooks — Claude Code's `PreToolUse`,
LangChain callbacks, the OpenAI Agents SDK guardrails, Semantic Kernel
filters — with different event names, payloads, verdicts and failure
policies. A governance product had to write one adapter per framework and
re-learn each one's answer to "what happens when the hook times out".

[Agent Hooks 0.1](https://github.com/responsibleai/agent-hooks/blob/v0.1.0-alpha.5/spec/AGENT-HOOKS-0.1.md)
(`agent-hooks/0.1`, MIT, a framework-neutral AI governance contract)
replaces that with one contract:

- eight closed **interception points** bracketing the agent loop —
  `agent_startup`, `input`, `pre_model_call`, `post_model_call`,
  `pre_tool_call`, `post_tool_call`, `output`, `agent_shutdown`;
- one **`AgentContext`** payload per point, with a `target` — the value the
  guarded action will consume or has produced;
- three **verdicts**: `allow`, `deny`, `transform` (of `$target` only).
  `warn` is `allow` plus `warnings`; `escalate` is a `deny` carrying an
  `approval` block, lifted only by the host's approval seam, so an
  unresolved escalation is a deny by construction;
- **host obligations** (a `deny` at `pre_tool_call` means the tool is not
  invoked; at `post_tool_call`, the result is discarded), a closed set of
  **composition profiles**, and fail-closed `host_error:*` reasons;
- **result labels** (§5.4): provenance an interceptor returns, which the host
  persists and resurfaces on later emissions;
- an **approval seam** whose request carries a `context_identity` — by
  default `sha256:` over the RFC 8785 canonical JSON of what the approver
  was shown — that the resolution must echo byte for byte;
- a payload-free **interception record** per emission (`transform.value`
  dropped, messages truncated).

The spec draws the line OpenSesame already draws. It is a cooperative
contract, not a security boundary (§1.4): the host decides whether verdicts
are honoured. OpenSesame's boundary stays where ADR 0005 put it — the Host
API authorizes every use of a `ConnectionRef`. But the places an agent loop
moves content — what a user pastes, what a tool returns, what the model is
about to read or say — are exactly where a raw credential leaks into a
context window, and exactly the places this contract names.

The contract has two sides and OpenSesame sits on both. It is an
**interceptor** for any framework that registers it. And it is a **host**:
the Host's own web-login rotation (ADR 0076) is an agent loop — an agent
surface of eleven verbs that a person's browser executes — whose every verb
is a tool call and whose escalations need a person. Governing it with the
contract means the Host must build the hooked run, put an escalation to a
real person without trusting the channel, keep a payload-free audit, and
survive its own crash without changing a third party's password twice.

## Decision

### 1. OpenSesame takes the interceptor's side, on the canonical core

`crates/agent-hooks` (`opensesame-agent-hooks`) depends on the canonical
Rust core, `agent-hooks-sdk`, pinned exactly (`=0.1.0-alpha.5`). The core
owns envelope validation, canonical JSON and context identity, verdict
validation, transform application and composition; every other language SDK
binds to it over FFI. We do not re-implement any of it (ADR 0008). The pin
is exact because the contract is pre-1.0: a bump is a deliberate re-read of
the spec, with this ADR updated when the contract moves. Links to the spec
name the tag, never a branch.

As an interceptor OpenSesame runs no agent loop: the framework that does
registers `OpenSesameInterceptor` in process (Rust), runs
`opensesame hooks intercept` per emission, or calls the Host (§11). As a
host it is §10.

### 2. One verdict from two controls

`OpenSesameInterceptor` returns one verdict per emission:

- **Tool rules at `pre_tool_call`.** An operator policy allows, escalates or
  denies each tool by exact name or literal prefix. An exact name beats any
  prefix; the longest prefix beats a shorter one. A tool no rule names
  **escalates** by default — refused unless a person lifts it, so an empty
  policy fails closed without making every agent unusable to a person
  standing by. The order is fixed and every refusal but the last is a plain
  deny: a rule's `deny`, a credential in the arguments, label flow (§8), and
  only then a rule's `escalate`.
- **The secret guard at every content seam** (`input`, `pre_model_call`,
  `post_model_call`, `post_tool_call`, `output`). A credential-shaped string
  is rewritten to `[redacted:<kind>]` by a `transform` of the whole
  `$target`, so the model never reads it and the caller never receives it.
  In **tool arguments** it is a plain deny instead (`opensesame:raw_secret`):
  a rewrite would hand the tool garbage, and an agent passing a raw secret to
  a tool is what a `ConnectionRef` exists to prevent. The deny is plain even
  for a tool that would otherwise escalate: a person shown redacted
  arguments could not know what they were approving, so no approval is
  raised for it.

Nothing is decided at `agent_startup` or `agent_shutdown`: there is no
content to guard, and the spec forbids a transform there.

### 3. The policy is data, strictly parsed

The policy is a JSON document with a closed shape (`deny_unknown_fields`,
typed enums, version `1`), per the hooks research: a config file that
causes execution is code, and most gates are predicates data can express.
There are no globs and no regular expressions — nothing whose cost or
meaning depends on the input matched. Ambiguity is refused at load: a rule
with both or neither selector, a repeated name or prefix, a bad label, or a
`reason` beginning `host_error:` (reserved to hosts, §11 of the spec).
Errors name a rule's position, never its content.

```json
{
  "version": 1,
  "unlisted_tools": "escalate",
  "secret_guard": "redact",
  "refuse_labels": ["opensesame:credential_material"],
  "tools": [
    { "prefix": "github.", "decision": "allow" },
    { "name": "shell", "decision": "deny", "message": "no shell on this agent" },
    { "name": "deploy", "decision": "escalate", "reason": "acme:change_window" },
    { "name": "crm.lookup", "decision": "allow", "labels": ["acme:pii"] }
  ]
}
```

`secret_guard` is `redact` (default), `deny` (deny every emission carrying
one), or `off`. Three named policies ship as **presets**, each one file under
`spec/agent-hooks/presets/*.json` — an envelope `{preset:1, name, summary,
policy}` with `deny_unknown_fields`, `name` equal to the file stem, and
`policy` parsed by the same `HookPolicy::parse` (ADR 0139):

- `rotation-web-login` allows exactly the eleven verbs of the tool boundary
  (the eight `BROWSER_VERBS` and three `CEREMONY_VERBS`) by exact name, never
  prefix, with `unlisted_tools: deny`, `secret_guard: redact`, and refuses
  `opensesame:credential_material` policy-wide. A test pins the named set equal
  to rotation-web's two constants, so renaming a verb fails here.
- `strict` denies everything unnamed, with `secret_guard: deny`.
- `observe` allows everything with `redact`; it is for audit, not enforcement.

The CLI and the gateway each embed the directory with `include_str!`, and a
drift test in each compares the embedded table with the directory byte for
byte, so a new or edited file fails until the table row is added.

### 4. Recognition by issuer shape, never by label

The guard matches credentials by the shapes their issuers made distinctive
— `ghp_`/`github_pat_`, `glpat-`, `AKIA`/`ASIA`, `xox?-`, `sk_live_`,
`sk-ant-`, `sk-`/`sk-proj-`, `AIza`, `npm_`, signed JWTs, PEM private-key
blocks — plus OpenSesame's own `secret://` `SecretRef`, which an agent
should never name (ADR 0005). It does **not** match on labels
(`password=`, `token:`) the way the audit redactor does: agent content is
full of code, and a label rule would rewrite `password = read_password()`
in the middle of the agent's own work. Precision is the requirement;
recall beyond known shapes is the Host's job, not the hook's.

### 5. Every verdict is value-blind

Reasons are fixed `opensesame:*` identifiers (`tool_denied`,
`tool_requires_approval`, `secret_redacted`, `raw_secret`,
`label_flow_denied`, `context_unreadable`, `approval_declined`,
`approval_not_bound`, `hook_out_of_order`) or the operator's own. Messages
name credential kinds and counts (`github_token×2`) and labels the policy
itself names, never text from the target (spec §14). The record a host
persists keeps `reason` and a truncated `message` and drops
`transform.value`, so neither the secret nor its redacted surroundings
reach the audit trail. Every audit table in this ADR has no column that could
hold a target, a tool argument, a transform value or a verdict message.

### 6. The approval seam is bound the way ADR 0086 binds approvals

The spec's `context_identity` and ADR 0086's `requestDigest` are the same
idea from opposite ends: a digest of exactly what the approver saw, which
the answer must be bound to. `BoundApprovalResolver` is the join. It
implements the SDK's `ApprovalResolver` over a `HumanApprover` port and
uses the identity as the request digest:

- an **identity-unbound** request (`identity_provider: null`) is never put to
  a person — a proof commits to a digest, and there is none — and resolves
  `unresolved`, which the host enforces as a deny;
- a decision whose proof is **bound to another digest** is a `reject`
  (`opensesame:approval_not_bound`), never an approval;
- a **declined** decision is a `reject` (`opensesame:approval_declined`),
  reported at once and never able to lift a deny;
- an approval lifts the deny to a plain `allow`, never a `transform`: an
  approver that could rewrite the action would be its second author, and an
  approval only narrows (ADR 0046 D11);
- no answer — a timeout, a broken channel, a withdrawn or already spent
  approval — is `unresolved`.

`redact_for_approver` is the emitter's approval redactor: credential shapes
become markers before the context leaves for an approver, and because the
host computes `context_identity` over the redacted context, what a person's
proof binds to is what they saw — which held no secret. What leaves the Host
for a person is display-safe only: the interception point, a machine-
identifier reason, the tool name, the agent id and the `context_identity`.
Tool arguments, messages and results never travel.

### 7. CLI verbs for out-of-process hosts and for the operator

`opensesame hooks intercept [--policy FILE]` reads one `AgentContext` from
standard input and writes one `Verdict` to standard output. It needs no
Host, daemon or network. The size bound is checked on the raw bytes before
decoding: the read stops one byte past 5 MiB, and anything longer — or not
UTF-8, or failing the SDK's §4 envelope check — is answered with a deny
(`opensesame:context_unreadable`). The interceptor fails closed on its own,
never relying on the host having validated. A policy it cannot load exits
non-zero with nothing on standard output, which a conformant host turns into
`deny host_error:interceptor_failed` (spec §6.3). `OPENSESAME_HOOK_POLICY`
names the file.

With `--approver-url`, `--approver-ref` and the bearer all configured, `hooks
intercept` settles its own escalations through the Interaction-backed approver
(§9). It consults the seam only for a liftable deny at `pre_tool_call` — the
only place the policy engine escalates. Approved is a plain allow; declined or
not-bound is the resolver's deny; unresolved returns the original escalation
unchanged for a host with its own seam, never an invented `host_error:*` (those
belong to hosts). `context_identity` is the SDK's, computed over
`redact_for_approver(context)`, and the resolver's echo is checked. The bearer
has no flag: it comes only from `OPENSESAME_HOOK_APPROVER_BEARER`, because
standard input already carries the context, so there is no free no-echo channel
for it (a test proves clap rejects `--approver-bearer`). A partial configuration exits
non-zero before reading standard input.

The operator verbs over the same machinery are `hooks check` (print a policy
with defaults filled), `hooks policy get|put|preset ls|show`, `hooks approver
get|put`, `hooks decisions` and `rotate hooks`, each a thin client of §11. The
`put` verbs try each stored credential on 401/403 and, when none succeeds,
show the step-up refusal (the remedy) rather than a wrong token's plain 401;
a real answer such as `412` from a later credential is shown in preference to
an earlier step-up refusal. The approver handle's shape (`inbox_` prefix, 8 to
256 bytes of `[A-Za-z0-9_.-]`) is checked before it is sent; the gateway and
the SQL `CHECK` enforce the same bounds.

### 8. Result labels, and why they are session-sticky

A permit's `result_labels` mark the data an action produced; the host
resurfaces them as `extensions.opensesame.source_labels` on a later emission.
Three sources: every guard rewrite carries the built-in
`opensesame:credential_material` (the redaction removed the value, the label
keeps the fact); a tool rule's `labels`; and **carried** labels — a permit also
names every resurfaced label the policy knows, so a host that resurfaces one
hop at a time still refuses `email.send` two hops after the CRM lookup (result,
model, tool call). Inputs deriving from a label a rule's or the policy's
`refuse_labels` names are a plain deny (`opensesame:label_flow_denied`). A
`source_labels` that is not an array of strings is `opensesame:context_unreadable`
at every seam that reads it: a host that garbles provenance cannot launder it.
A label is `namespace:name` (`^[a-z][a-z0-9_]*:[a-z0-9_.:-]+$`, at most 64
bytes, at most 16 per list), refused at load by position when malformed.

Labels ride permits only. §5.4 forbids persisting labels for an action that did
not proceed, and the pinned core's composition unions labels from permit
verdicts only but leaves a winning deny's own labels in place, so the
interceptor never puts a label on a deny.

Labels are session-sticky on the host side as well (§10): the hooked session
persists a label only when it acted on the emission and the combined verdict
names it, and resurfaces it on every later emission of the run under the
namespace the interceptor registered as. The remote model's derivations are
invisible to the host, so over-labelling can only make a label policy refuse
more. The `rotation-web-login` preset therefore labels `read_dom_redacted` and
`screenshot_redacted` results `opensesame:untrusted_page` for provenance in the
records but refuses only `credential_material`: refusing `untrusted_page` on
`submit` or `fill` would refuse any agent that read the DOM first.

### 9. The Interaction-backed approver

`crates/agent-hooks/src/interaction` implements `HumanApprover` over the
Identity API's interactions (ADR 0086), so an escalation reaches a real person
holding a passkey:

1. `POST /v1/authorization-requests` raises the subject for the approver whose
   inbox handle the operator or organization configured;
2. `POST /v1/interactions` fronts it with an `authorization_request`
   interaction. The `context_identity` rides inside the one authorization detail
   the approver sends, so the server's request digest covers it;
3. the person approves in their inbox with a WebAuthn activation the server
   binds to that digest;
4. the approver polls `POST /v1/interactions/{ref}/consume`, the requester's
   exactly-once compare-and-set spend, **before** it reports an approval, so one
   approval can never lift two emissions.

Decisions taken in the Identity plane and the approver to make this safe:

- **Requester-visible decline.** A requester that spends an interaction a
  person refused gets `403 approval_denied` (final); `401 approval_required`
  means only that nobody has answered. This was chosen over a new status route
  because the unauthenticated `/i/{ref}` summary already shows `status: denied`
  to any holder of the reference, so nothing new is disclosed and no route is
  added. `approval_denied` is in the contracts' `InteractionErrorCode` and the
  Identity OpenAPI. A decline needs no proof: the approver reports a declined
  `HumanDecision` whose binding states a refusal of exactly the request created,
  and the resolver answers `approval_declined` on the first poll, not at the
  deadline.
- **Withdrawal.** `POST /v1/authorization-requests/{id}/cancel` (requester only;
  an approver or stranger gets the same 404 as an unknown id) moves a pending
  request to `cancelled` through a domain transition that records no decider,
  since a withdrawal is not a decision, and revokes the live interaction fronting
  it. An approved, refused or lapsed request keeps its ending (`409
  request_not_pending`, `410 expired_request`). On every exit that is not a
  spent approval the approver revokes the interaction and cancels the request,
  including when the request was raised but its interaction never was, and when
  the interaction's reference never reached the approver (cancel closes it by
  subject). The route is API-only; it is not a registry capability.
- **Requester is not approver.** At `POST /v1/interactions` for kind
  `authorization_request` only, the caller may not be the principal the inbox
  handle names, and the approver must be the principal the fronted request was
  addressed to; both refusals are the same `404 interaction_not_found` as an
  unverifiable handle. Other kinds (device, pairing, claim, transaction) are
  not bound this way because their caller owns the ceremony and routinely
  approves it from a second device. `resolveEntitledSubject` for authorization
  requests entitles the requester only. The Identity API also budgets 20
  prompts per approver and 5 per requester and approver pair per five minutes;
  an over-budget request is a denial here.
- **The digest is recomputed, not trusted.** When a spend comes back the
  approver recomputes the interaction `requestDigest` itself from kind,
  `authorization_request:<authReqId>`, its configured approver ref and the
  consumed detail's requester, binding message, expiry and authorization
  details; the result must equal both the digest returned at creation and the
  digest the server reports at consume. Any mismatch, missing field,
  uncomputable detail or a `resourceRef` this approver never sent is an
  unbound binding, which the resolver rejects as `approval_not_bound`. It is
  checked at consume because the requester handle is reported only on the
  consumed detail. The encoding is written once, as
  `spec/conformance/request-digest-vectors.json` (24 cases generated from
  `packages/os-domain` `crypto/request-digest.ts`, `UPDATE_REQUEST_DIGEST_VECTORS=1`);
  an os-domain test regenerates in memory, fails on drift and independently
  recomputes each case, and `interaction::digest` reproduces every case byte
  for byte. The vectors pin two JavaScript-object behaviours the Rust reader
  replicates deliberately: keys that are canonical array indices are walked first
  in ascending numeric order, and every number is read as a double and written by
  ECMAScript `Number::toString` (which needs `serde_json`'s `float_roundtrip`).
  `canonicalize` in os-domain defines rather than assigns object members, so a
  `__proto__` member is hashed instead of silently dropped.
- **Cancel-safe ask.** The whole `ask` body runs in a spawned task. Dropping the
  caller's future resolves the task's cancel receiver; the task stops waiting at
  its next checkpoint, withdraws whatever it recorded as raised, and ends. An
  in-flight create is never abandoned, and each request is bounded by its own
  timeout (default 15 s). Both creates carry an `Idempotency-Key` unique per ask
  and per stage, and a create that produced no reply is retried once under the
  same key, so a reply lost on the way back is found, not stranded. The wait is
  a wall at the configured deadline, and no prompt is left answerable after the
  future that raised it is gone.
- **The transport is narrow.** https only (loopback http allowed), no redirects,
  no proxy, no userinfo, query or fragment, bounded bodies, and nothing a server
  wrote reaches an error. `IdentityClient` resolves routes with `Url::join`
  under an invariant — the path starts with `/` and has no query, fragment,
  backslash or empty, `.` or `..` segment — and the result must keep the base's
  origin and path prefix, so an Identity API behind a path-prefixing proxy works
  and a path can never send a bearer to another origin.

### 10. OpenSesame as a host: web-login runs under the contract

`crates/rotation-web/src/hooks` makes each run an agent-hooks session.

- **The seam is the transport, not the executors.** `HookedTransport<T>`
  decorates `BrowserTransport` (and `CeremonyTransport` where `T` can capture).
  Every verb is one `pre_tool_call`/`post_tool_call` pair under one
  `tool_call.id`; a caller holding a `HookedTransport` has no un-hooked verb to
  reach for. `host_run` adds `agent_startup`, `input` (kind, recipe id, origin —
  never a credential), `output` and `agent_shutdown` in §3.1's order, its
  reason following the outcome (`completed` for a finished run, `cancelled` when a
  person has the page, `error` for a hook refusal, drift, a transport failure or a
  run left for reconciliation); a run that hits its deadline still emits the
  shutdown (`error`), and an emission dropped mid-flight is recorded as a deny
  with `host_error:interceptor_timeout` rather than leaving a gap; a startup deny processes nothing and still emits
  the shutdown. A block at `pre_tool_call` means the verb is not called and no
  `post_tool_call` is emitted; at `post_tool_call` the result is discarded. Both
  answer `StepError::Refused`, so the executors' fail-closed handling of a failed
  step takes over and nothing is submitted after a refused fill or assertion.
- **Authority is pinned; content is not.** A `pre_tool_call` transform is
  applied to content, never to authority. The credential `reference` of
  `fill_credential`, `assert_present` and `verify_login`, the capture `slot` of
  `capture_credential` and `capture_download`, and the **origin** a `navigate`
  reaches (scheme, host, port and userinfo, compared with the URL parser) are
  pinned: a transform whose effective arguments change any of them is
  `host_error:transform_invalid`, and the verb is not called with the altered
  value. The rule is a type: every verb's argument type implements `Authority`,
  `Verb::Args` requires it, and the one bracket every verb goes through
  compares the proposed and effective pinned views, so a new verb cannot be
  added without saying which members are authority. A selector rewritten within
  the frame, a same-origin navigation rewrite, a redacted DOM and a dropped frame
  still transform. A tool known only by name (the engine's untyped surface) has
  no pinned member, since the host cannot tell which argument names a credential;
  its transform is bound by shape only. The run request at `input` and the
  report at `output` are facts the host acts on: a transform may leave them as
  they were and nothing else, and restating an outcome (a `completed` rotation
  reported `blocked` is a lockout) is `transform_invalid`.
- **No lock across an interceptor or an approval.** An emission reserves under a
  short lock (phase check, context build, atomic `sequence`), is dispatched by
  the SDK's emitter without a lock, and settles under a short lock (phase,
  labels, record). A verb parked on an approval does not hold up another verb;
  records leave in `sequence` order; a run's boundaries wait for every emission
  in flight and are emitted alone; a verb outside a turn is refused without an
  emission (`opensesame:hook_out_of_order`). The `pre_model_call` /
  `post_model_call` pairing is a counter under the same lock, so two posts in
  flight cannot answer one pre.
- **A refusal is split on whether the run acted.** `HostedRunError::Refused`
  means nothing ran (startup or input). `HostedRunError::Withheld` means the run
  finished and its report was refused at `output`: whatever it did to the site
  stands, and the caller reconciles.
- **Custody is not hooked.** `generate_candidate`, `seal_candidate` and
  `promote_candidate` are host-owned, Host-minted handles with acknowledgement-
  only outcomes, and none is a tool in the agent's surface (ADR 0076 §1). An
  interceptor never decides on them, a policy cannot name them, and an agent
  cannot call, probe or pre-clear them. Custody ordering is still enforced by the
  hooked steps: `run_change_password` dispatches custody only after the hooked
  `navigate` and `wait_for` succeed, so a denied or unresolved one leaves no
  custody step in the queue. A complete run queues 11 steps and decides 8 hooked
  `pre_tool_call` records. Hooking custody would let a policy deny a step after
  the site had been touched, the lockout ADR 0076 exists to prevent.
- **Two conformance claims, kept apart.** Claim A (`opensesame-rotation-web`, a
  tool router, capabilities `tool_calls` and `int64_json`) runs 4 of the 47
  vendored CTK vectors, all passing, because alpha.5's corpus reaches the tool
  seam only through a mock model. Claim B (`opensesame-rotation-web (emission
  engine, mock loop)`, adding `model_calls`) drives the same `HookSession` and
  `host_run` with the CTK's scripted model and tools and passes 46 of 47, the
  remainder skipped for the undeclared `bigint_json`. B says nothing about a
  run; the crate's own tests cover the tool seam, authority, concurrency,
  labels and records. See
  [`docs/validation/agent-hooks-conformance.md`](../validation/agent-hooks-conformance.md).

### 11. Host API routes

All are on the Host (`:8787`) and registered in `spec/openapi/host-api.yaml`.

| Route | What it does | Who may call |
|---|---|---|
| `POST /api/v1/agent-hooks/intercept` | One `AgentContext` in, one `Verdict` out, under the organization's stored policy; the policy version in `opensesame-hook-policy-version`. An escalation is answered as an escalation: the framework's own seam (or `hooks intercept` with an approver) lifts it. A context over 5 MiB, not UTF-8 or off the envelope is `200` with a deny. Each decision is recorded before it is handed out; one that cannot be recorded is not handed out (`500`). | A native session of any role in the organization, or the operator. |
| `GET\|PUT /api/v1/agent-hooks/policy` | Read, and replace, the organization's policy. `ETag` is the version; `PUT` is compare-and-set on `If-Match` (0 creates; `412` carries `current_version`; `428` when missing). The replacement and its `agent_hooks.policy.updated` outbox event (policy SHA-256, never the policy) commit together. | Read: owner/admin or operator. Replace: step-up (§12). |
| `GET /api/v1/agent-hooks/presets` | Each preset's parsed policy and its `policy_sha256`, the digest the `PUT` audit carries, so a stored policy can be told to be a preset byte for byte. Applying a preset is the ordinary `PUT`: no second way to write a policy. | Owner/admin or operator. |
| `GET\|PUT /api/v1/agent-hooks/approver` | Who is asked (§13). | Read: owner/admin or operator, `Cache-Control: no-store`. Replace: step-up. |
| `GET /api/v1/agent-hooks/decisions` | The audit of verdicts the intercept route answered: point, decision, escalated, a machine-identifier reason, policy version, caller, time — never a tool name, target, transform value or message. Newest first, exact-match filters, a time window and an opaque cursor. | Owner/admin or operator. |
| `GET /api/v1/agent/runs/{id}/hook-records` | The payload-free record of a hosted run (point, decision, reason, escalated, the before and after `sha256:` identities), plus the count/verdict summary on the run view. | The credential's owner and nobody else. |

No route in this table is reachable by an agent capability or a browser grant:
an agent that could call the intercept route, read its own decisions, or read the
policy could probe the rules that govern it. A stored policy the build cannot
parse is an error (`500`, and a parked run), never a quiet fall back to the
default. The decision audit is the append-only table `agent_hook_decisions`, not
an outbox event: an audit trail is not a change feed, and on the outbox every
caller's traffic would grow without bound.

### 12. Who may replace a policy: the step-up guard

Owner/admin alone does not replace the policy, because the agent framework it
governs may run under that same role. A `PUT` to the policy, a `PUT` to the
approver and the pinning of a recipe signer (§14) require **the operator token**
or **a fresh step-up on a human's native session**: assurance
`phishing_resistant`, `amr` exactly `["webauthn"]`, and a `last_step_up_at` set,
not in the future and no older than 300 seconds — the evidence `agent_runs` asks
before a control handoff (ADR 0084). `last_step_up_at` is valid only alongside
`phishing_resistant`, so an `amr` string alone cannot satisfy it. The refusal is
`403` (never `401`), code `step_up_required` (ADR 0146), with a `reason` of
`no_step_up`, `stale_step_up` or `delegated_credential` and a hint naming the
remedy.

Delegation is refused whatever evidence a credential carries: an agent
capability or a browser grant is refused by the existing guards before dispatch
and again by the step-up guard; a native session whose ceiling has any entry but
`host:user` is refused as `delegated_credential` (a strict allowlist, not a
denylist). The guard takes the already-resolved `Caller` and re-reads the claims
from the same headers, so presenting the operator header beside a session does not
lift the session. Role is judged before step-up, so a member with a step-up gets
`forbidden`. `require_step_up(state, headers, caller, action)` is the one guard
for all three callers, so codes, reasons and hints change together.

The guard is claims-based rather than a purpose-bound Host authorization (ADR
0084's `host_authorizations`), because that mechanism needs a paired browser grant
and a per-request WebAuthn challenge bound to a digest, which a native CLI session
cannot hold; it asks for evidence on the session and leaves how a session acquires
it to the Identity-plane path that mints it.

### 13. Who is asked: the approver setting and its deployment

Who is asked is a sibling setting stored beside the policy
(`agent_hook_approvers`), not a member of the policy document: the policy stays
strictly parsed and byte-comparable to presets, and a handle to somebody's inbox
is not policy. The setting has its own compare-and-set version and its audit
event (`agent_hooks.approver.updated`: previous version, version, who, the
handle's SHA-256, never the handle) commits in the same transaction as the row; a
lost race appends nothing. `approver_ref` is nullable on purpose: `PUT
{approver_ref:null}` keeps the row so the version keeps rising and a stale editor
still loses, and it means *ask nobody* — it does not fall through to the
operator's default; only a missing row does. `GET` reports who is asked as
`organization`, `operator_default` (the word, never the handle) or `nobody`, plus
`transport_configured`. An inbox handle authorizes asking that person, so the
organization's own is shown to owner/admin/operator only.

The Identity API and the requester's identity on it are deployment configuration,
in the environment: `OPENSESAME_AGENT_HOOKS_APPROVER_URL`, `_BEARER` (sensitive),
`_REF` (optional default handle), `_TTL_SECONDS` (30..3600, default 300),
`_POLL_MS` (default 2000), `_DEADLINE_SECONDS` (default the TTL). It is
all-or-nothing: URL and bearer are required together, any other variable alone
refuses start, and nothing set is conformant (escalations stay denials, spec §9).
The `.env.schema` entries carry no `@required` decorator, since it would make an
unconfigured deployment invalid. Startup validation builds an
`InteractionApprover` from the real settings, with a placeholder handle when no
default is named, so what would fail at the first escalation fails at boot, from
one validator; errors name the variable and never a value. The requester bearer
must belong to a principal distinct from every approver (a service principal for
the Host).

Every failure to build a resolver — unreadable store, an unusable stored handle,
no row and no default, a row that cleared the handle, no deployment configuration
— yields no resolver for that run, so each escalation stays a denial. No path
falls back to allow. A hosted run's escalated step is **held**: nothing is
enqueued for the driver until the person approves; a decline is a deny with
`opensesame:approval_declined`; a deadline is `host_error:approval_unresolved`
and the approver withdraws what it raised (one revoke, one cancel); an approval
whose digest covers other content is refused by the approver's recomputation and
the step never dispatches. The run stays bounded by its own run deadline.

### 14. Recipes and signers

A recipe is what a run replays; the policy decides whether each step may be taken.

- **The document** (ADR 0076 §4): strict JSON, `schema_version` 1, closed objects
  at every level (a repeated member at any level is refused, so a signature
  covers exactly one reading), members `recipe_id` (`rcp_` plus 1 to 63 of
  `a-z0-9_-`), `origin` (the canonical https origin a rotation target stores),
  `expires_at` (RFC 3339, at most 93 days out when stored), `change_password`
  (the executor's own `ChangePasswordRecipe`), an optional `canary
  {verified_at}` and an optional `signature`; at most 16 KiB. No new step
  language: the richer fields in the earlier schema document are not read by the
  executor, so the parser refuses them rather than store them unread.
- **Signing.** Ed25519, verified with `verify_strict`, over the domain tag
  `opensesame/web-login-recipe/v1\n` followed by the RFC 8785 canonical JSON of the
  document without its signature (one JCS implementation in the repo, the
  agent-hooks one). Keys, seeds and signatures are lowercase hex, because
  rotation-web's default build links no base64. `key_id` is `rsk_` plus the first
  32 hex of SHA-256 of the public key, derived and never chosen, so a signature
  cannot name a key it was not made with. The document digest is independent of
  the signature, so re-signing does not change it.
- **Signers** (`web_login_recipe_signers`): primary key (organization, key id),
  at most 32 per organization, revoked included. Revocation is final — the row
  stays, so the id is never re-pinned — and is one conditional `UPDATE ... WHERE
  revoked_at IS NULL`. Pin and revoke append outbox events in the same
  transaction; recipe writes and deletes append `web_login.recipe.put|deleted`.
  Audit payloads carry ids, digests and outcomes, never the document or selectors.
- **Trust is never an input.** No route, body member or flag names a trust. The
  one writer of recipe rows, `put_web_login_recipe_document`, takes an optional
  verification and derives trust inside its transaction: none is `candidate`; a
  verified signature with a signed canary attestation is `canary_verified`
  (source `signed`); verified without one is `candidate` with `verified_at` set.
  The same transaction re-checks the signer is still pinned and unrevoked. A
  signature that fails is refused `422` and never stored (`unknown_signer`,
  `signer_revoked`, `invalid_signature`); a canary claim without a signature is
  `canary_unsigned`; an unsigned document is stored as an inert `candidate`.
  `PUT` is compare-and-set on `If-Match`.
- **Runner enforcement** (`web_login/recipe_trust.rs`). The store returns a row only
  if its signer is pinned and unrevoked now, the row is verified and unexpired,
  and, for an unattended run, trust is `canary_verified` with a passing canary no
  older than 90 days. The runner then re-verifies the stored document against the
  signer's current key, checks its digest equals the row's, its origin equals the
  target and its signed expiry has not passed, and replays the steps from the
  document alone. Failures park the job: no recipe, no canary, recipe invalid,
  recipes unreadable.
- **Attended and unattended** are the caller's statement: the lifecycle scanner is
  unattended; a run a person asked for is attended, needs the signature but not the
  canary (which is how the first canary happens), and shares the registry slot key
  with the scanner's within a process, and across replicas a claimed run is
  created only when no running job (an unexpired claim, or no claim row) already
  holds the same organization and target (`web_login_run_in_flight`, 409). The
  guard covers claimed runs; beginning an already-scheduled generic job has none.
- **Canaries are the Host's record**, taken against the digest the run replayed: a
  completed run is `canary_verified`; `RecipeDrift` or a submitted-but-unconfirmed
  run demotes to `candidate` with `canary_result = failed`; any other stop before
  submit records nothing. A signed attestation must not be from the future (5
  minutes' skew) or older than 90 days.
- **Authority.** Recipe and signer routes are for a native session of an owner or
  admin, or the operator, never an agent capability or a browser grant. Pinning a
  signer takes the step-up (§12), because a key the governed framework could pin
  would sign the recipes that govern it; revoking takes none (the safe
  direction); recipe put/delete need none, since an unsigned recipe is inert and a
  signed one needs a private key the Host never holds. The canary route starts an
  attended run, so it is an owner/admin's own native session only: not a member,
  not the operator (no browser to drive), not a session whose ceiling carries
  agent capabilities.
- **The CLI** (`opensesame access connectors rotate recipe put|get|ls|rm|sign|canary`
  and `rotate signer add|ls|rm|keygen`). Signing is local: the private key is a
  64-hex seed file, refused if group- or other-readable, read into `Zeroizing`,
  never an argument, never printed, never sent; `keygen` creates it `0600` with
  `create_new` and prints only the public half and id. The operator guide embeds
  `docs/operators/examples/web-login-recipe.example.json` verbatim, asserted byte
  for byte in the CLI and gateway tests, and both run its worked example.
- **Ordering.** The implementation signs first, since an attended run needs a
  verified signature, and the canary then promotes the recipe. The trust ladder is
  unchanged: nothing replays unattended without both.

### 15. The Host's web-login runner

`crates/gateway/src/web_login` is the executor side of the step channel, run as the
hooked session of §10. In `Harness::open` it builds
`HookedTransport::new(ExtensionTransport::new(BrowserChannel(..)),
HookSession::new(..)?.with_record_sink(sink))` with the organization's own
`OpenSesameInterceptor`, and `drive` calls `run_change_password_hooked`.

- **Spawned and tracked.** A run takes up to 15 minutes, each step waiting on a
  person's browser, so the lifecycle scanner *starts* it and moves on; a tracked
  `RunRegistry` task (a `JoinSet`) owns it. Bounds: a global and a per-organization
  bound on runs executing (the organization's slot is taken before the global one),
  one task per target, and a bound on how many may queue at all. A queued task holds
  nothing. A slot is released by a guard's `Drop`.
- **Atomic claim.** Ownership of a web-login job is one organization-scoped
  compare-and-set on `state='scheduled'`. The runner creates its job already
  claimed (state `discovering` plus a row in `web_login_job_claims` naming the run,
  lease = run deadline + 120 s) and publishes no `credential.rotation.requested`
  event, because that event is the generic consumer's work queue. The generic
  path and `defer_web_login_rotation` are conditional on `state='scheduled'`, so
  neither can take or park a job the runner owns. `web_login_job_claims` is created
  lazily like `rotation_jobs`.
- **Prepared, or parked with the reason.** Before a run starts, `prepare` checks an
  owner to drive it, a recipe the trust ladder lets it replay, and a hook policy it
  can read; a missing prerequisite parks the job with the honest reason and never
  improvises.
- **Records before steps.** The session delivers each record synchronously and the
  sink only buffers; the step channel flushes the buffer to `agent_hook_records`
  **before** it hands the next step to the driver, so every record that precedes a
  step is durable before the step can act, and a record that cannot be written
  stops the run (settled as unaudited).
- **Control state.** Before each step the channel consults the run's persisted
  control state: a person who asked for the page parks the run at a safe point,
  nothing is enqueued while a person holds it, and the run never resumes autonomy.
  The critical span between `assert_present` and `submit` is never interrupted.
- **Durable closure before settle.** Closing the run is what makes the step queue
  refuse a late driver answer, so a run is closed durably before its rotation is
  settled or its policy released. Close is retried 5 times with doubling backoff
  (250 ms, capped at 4 s), and every attempt is verified by reading the run back
  (an `UPDATE` of zero rows is not proof). If it cannot land, the job is parked for
  reconciliation with a detail saying the run could not be closed, and the open run
  is left to the reaper. A run left open for a person (handed off or held) is not
  closed.
- **Reaper.** At startup, before the scanner starts anything, and then on a timer,
  the reaper closes observation runs open past the longest a run may last and parks
  `discovering` jobs whose persisted claim lease has expired, closing the exact run
  the claim names; a job with no claim row falls back to "untouched since the
  horizon". Runs are **never resumed**: after a crash it is unknown whether the
  submit reached the site, and a replay could change a third party's password twice.
  The detail never says "not submitted". Settlement is fenced (`updated_at` bumped
  conditionally on `state=discovering`), so a stale listing cannot overwrite a
  settlement and a settlement cannot overwrite the reaper's parking.
- **Typed canonical settle.** The settle route (`POST` of a step's outcome) does not
  trust the driver's JSON. It reads the claimed step first (a caller that is not the
  live claimant gets `409` before anything it sent is examined); the pending
  request's step tag selects the outcome that may answer it (`done`, `filled`,
  `presence`, `dom`, `frame`, `verified`, `captured`; `sealed` for the custody seal;
  `failed` answers anything); it decodes into `StepOutcome` or the custody outcomes
  and stores the **canonical re-encoding**. A difference from the canonical form (an
  unknown field at any depth, a wrong shape) is `422 invalid_outcome`, the wrong
  outcome kind `422 wrong_outcome`, an unknown step `409 unknown_step`; nothing is
  stored and the claim stands, and refusals carry closed codes only. Settling needs
  a live lease in the same atomic `UPDATE` that tests `claim_expires_at > now`. A
  drift test requires every `StepRequest` variant to have a table entry, and the
  store separately refuses anything that is not an object with a string `outcome`.
  The contract is enforced at the route and exercised by the extension's driver
  tests (§16).
- **Sealed observation.** The Host holds no viewer key, so every run it opens
  carries `viewer_key_id` `none:hook-records-only`; its record is the payload-free
  `agent_hook_records` plus the hook-records route. Storage refuses any sealed
  event append to such a run, and a gateway test proves a hosted run seals nothing.
  Sealed logs are for drivers that hold a viewer key.
- **Typed settlement.** `Refused` is "not submitted"; `Withheld` and a failed run
  after a submit are a reconciliation; a `pre_tool_call` refusal of the submit is
  "not submitted" because the step was never enqueued. Every detail is fixed text
  plus a machine-identifier reason and the point, never a message or content.
- **Retention.** Decisions are kept `OPENSESAME_AGENT_HOOK_DECISION_RETENTION_DAYS`
  (default 90, 1 to 3650); a run is kept until the `expires_at` it was opened with
  (seven days) and its step queue and hook records go with it in one transaction.
  The actor runs at startup and hourly (`OPENSESAME_RETENTION_TICK_SECONDS`).
  `agent_hook_records` belongs to its run: migration 0053 makes (organization, run)
  a composite foreign key to `observation_runs` with `ON DELETE CASCADE`, rebuilt
  keeping only rows whose run exists in the same organization; purge still deletes
  children explicitly so its counts are exact.

### 16. The extension is the local runner

The default browser extension (`apps/browser-extension/runner`) drives the step
protocol with the person's own Host session, through typed `api-client` methods. A
DPoP-bound token is not used: the Host refuses it without its proof key (401).

- **Ownership.** The Host lists only runs whose credential the caller owns, and
  the runner claims only from that list. It additionally requires `closed_at` null,
  not expired, driver `agent`, `control_state` `agent_driving`, a drivable origin
  (https, or http on loopback only), the origin armed, the browser's grant held, a
  credential held for the origin, a pinned recovery key and a private window
  allowed — all re-read before every claim, because the Host's claim route does not
  check `control_state` itself. A handoff or pause stops claiming at the next poll;
  the runner never resumes autonomy, closes the tab or touches the page.
- **Permission model.** Standing permissions are unchanged. `scripting` is an
  optional permission and `https://*/*` an optional host permission; the options
  page asks for exactly `{scripting, one origin}` on the person's own click, and
  the grant is removed when the run closes, the 30-minute arm expires or the person
  stops it. No content scripts, no `activeTab`, `tabs`, `cookies` or `browsingData`.
  The `arm`, `disarm` and `status` messages are answered only to the extension's own
  pages.
- **Page execution.** `scripting.executeScript` with world `ISOLATED` and `frameIds`
  `[0]` only, every injection through one function that first checks the tab is on
  the run's exact origin (`off_origin` otherwise); navigation is refused before the
  browser is touched when the URL is outside the origin. A step with an unknown tag,
  or a missing, mistyped or extra field, is refused by `decodeRunnerStepRequest` and
  neither executed nor settled; the Host's lease lapses it.
- **Outcomes** are built only by closed constructors mirroring `StepOutcome` and the
  custody outcomes (no constructor takes a value), checked by `guard()` against a
  closed step-to-outcome table and the Host's 1 MiB bound, with DOM text scrubbed of
  every credential value the runner holds in raw, JSON-escaped and HTML-entity form.
  Frames carry image bytes, a layout `epoch` and `masked_boxes` (selectors that
  matched at least one node), so the Host drops a frame composited under a different
  layout.
- **Submit is at-most-once.** After executing a step the runner keeps its outcome
  per run, so a settle that never reached the Host is answered from it instead of
  re-executing. A pending marker is written (in the same sealed `last.<runId>`
  record) before a `submit`; a claim that finds the marker and no kept outcome
  answers `failed(transport)` and does not press again, even across a worker stop. A
  4xx from settle ends the pass without retry; any other failure surfaces and the
  next claim is answered from the kept outcome.
- **Credentials and backup.** The extension has no vault, so credentials live in the
  runner's own store sealed through `sealForRest` (ADR 0149), bound to the storage
  name; with no key nothing is written. `current_password` resolves to the entry for
  the run's origin; `candidate:<id>` only for the run and origin it was generated
  for. The device-sealed copy cannot survive losing the profile, so it is not a
  backup: `seal_candidate` answers `backed_up: true` only if a recovery recipient
  (RSA-OAEP public JWK, at least 3072 bits, the private half kept off-device) is
  pinned, the hybrid envelope (RSA-OAEP-256 wrapping an AES-256-GCM key, AAD bound to
  handle and origin) was accepted by `POST /api/v1/sync/push` with `accepted == 1`,
  and a pull-page read-back returned byte-identical ciphertext. Any other outcome is
  `backed_up: false`, so the executor blocks before the submit. `promote_candidate`
  is refused until the candidate has been sealed.
- **`verify_login`** proves the new credential in a private window (a clean cookie
  jar) using a per-origin login profile, and answers Works only when the signed-in
  marker appears with the login form having been present; Rejected when the refusal
  marker appears without it; everything else (no profile, no private window, neither
  marker, a second step, a private window already signed in) is Indeterminate, which
  the executor parks for a person.

### 17. Agent surfaces and operator guides

Every capability in this ADR is a `packages/capability-registry` entry (ADR 0065),
and every non-CLI surface is excluded with a citation of this ADR (or, for the
extension's own rows, of ADR 0076): `agent_hooks.intercept`, `.policy.check`,
`.intercept.remote`, `.policy.read|write`, `.approver.read|write`,
`.policy.presets.read|remote`, `.decisions.read`, `.run_records.read`; ten
`web_login.recipes.*` and `web_login.signers.*` entries (sign and keygen are
`client_local`); and `agent.runs.drive.arm|disarm|status` (extension-local, no agent
surface may arm: arming is a person's consent over a signed-in session). They are
excluded on the MCP servers and WebMCP because the agent is the subject of a
verdict, never its caller — a tool it could call would let it probe or pre-clear its
own policy, learn whom to target, choose its own approver, or read or write the
recipes that govern it. The Identity routes the approver uses (including cancel) are
not registry capabilities. The operator's guides are
[`docs/operators/agent-hooks.md`](../operators/agent-hooks.md) and
[`docs/operators/web-login-recipes.md`](../operators/web-login-recipes.md).

## Consequences

- Any framework with an agent-hooks adapter gets OpenSesame's tool rules and secret
  guard without an OpenSesame-specific integration, and the framework's composition
  profile, timeouts and records apply unchanged.
- The secret guard is defence in depth, not the authority boundary. A host that
  ignores verdicts voids it (§1.4); the Host API's `ConnectionRef` authorization does
  not depend on it.
- Shape recognition misses credentials without a distinctive shape (a random
  database password). That is the price of not rewriting code; the answer to such a
  secret is to never give it to the agent at all.
- A redacted tool result changes what the model sees. The marker names the kind, so
  an agent can tell a credential was withheld and ask for a `ConnectionRef` instead.
- A deployment without an Identity API, or an organization that names no approver,
  has no approvals: every escalation is a denial, and the system is usable only
  through tools the policy allows. The Identity API's anti-fatigue budgets turn an
  over-eager agent into denials, not into queued prompts.
- An escalated step can hold a hosted run for as long as the approval deadline; the
  run deadline bounds it.
- A rotation never silently replays after a crash. A stranded job is parked for a
  person to reconcile, which costs a manual step and avoids a double change.
- Changing the policy, the approver or a signer takes the operator token today, so a
  governed framework running under an administrator's token can read the policy but
  cannot rewrite it.
- The upstream core is alpha. The exact pin, and this ADR, move together.

## Limits

These are the boundaries of what is built, each with its reason.

- **The passkey branch of the step-up guard has no caller that can satisfy it.** The
  branch is implemented and tested against constructed claims, but no session in this
  repo carries step-up evidence: device approval is operator-only, and a browser grant
  minted with a WebAuthn authentication is the only claims shape with
  `phishing_resistant` evidence, which the guards refuse as delegated (it is DPoP-bound
  with a scoped ceiling). So the policy `PUT`, the approver `PUT` and the signer pin are
  satisfied only by the operator token. That is secure by default. The refusal's hint
  names the operator token as the working remedy and describes the passkey path only
  conditionally.
- **The operator token binds the Host, not the machine.** It is the machine owner's own
  credential and is readable from the process environment or disk by anything running
  as that user. That is outside the Host's control, and agent-hooks is a cooperative
  contract (§1.4).
- **The extension answers `failed(transport)` for `capture_credential` and
  `capture_download`.** Both steps are known, but no host envelope scheme exists:
  ADR 0082 leaves the sealed-capture envelope to the host and the repo defines none
  (`CaptureVault` has no production implementation), so no truthful sealed answer is
  possible from the extension.
- **The Host's runner drives web-login rotations only.** A registration ceremony's
  capture run is hooked in `crates/rotation-web` (`run_capture_steps_hooked`) and is
  walked under the `rotation-web-login` preset in tests, but no gateway runner starts
  one, for the reason above.
- **An approval request whose create never gets a reply is not withdrawn.** Each ask
  carries an opaque per-ask reference in the authorization request's binding message
  (the approval page shows it as `(ref …)`), so asks never share a request. If every
  attempt at the create goes unanswered, the ask never learns the request's id and
  cannot cancel a row the server did create; it stays pending in the approver's inbox
  until its ttl, fronted by nothing.
- **A held web-login target costs the policy an attempt.** A scheduled rung refused
  because another run holds the target publishes no outcome (the expiry alert stays
  open) and backs the policy off like a failed attempt, so it is retried when the
  holder's claim lapses; eight such attempts park the policy.
- **An unclosed run is found by the age-based reaper once its job settles.** The job's
  claim is released at settlement, so a run whose close never landed is no longer named
  by a lease, and until the reaper's age pass closes it a driver's late answer to a step
  it still holds can be stored (canonical and scrubbed). No executor reads it.
- **The extension's per-claim re-read is the pause and handoff guard.** The Host's claim
  route does not check `control_state`, so between a claim and the execution of an
  already-leased step (lease 120 s, `STEP_CLAIM_SECONDS`) a handoff can land and the step
  still runs.
- **No DPoP-bound token drives the runner.** The Host refuses a DPoP-bound token without
  its proof key (401), so the runner claims nothing under one; it uses the person's
  bearer session token, saved sealed on the options page.
- **Recipe trust is per organization and origin.** The earlier schema document's scoping
  of T3 replay to the user who produced the recipe is not implemented: pinned signers are
  organization-wide, and the document's rule that a recipe is signed only after a
  successful canary is reversed (§14, Ordering).
- **The Host seals no log of a hosted run.** It holds no viewer key (ADR 0081 §9 puts
  that key in the owner's client), so a hosted run's observation is the payload-free hook
  record and nothing sealed; a live, sealed observation stream belongs to a driver that
  holds a viewer key.
- **The upstream contract and its harness bound what is claimed.**
  - Alpha.5's composition leaves a winning deny's own labels in place, so the interceptor
    never puts labels on a deny (§8); a label on a deny would be carried although the
    action did not proceed.
  - `tool_seam_host_error: terminate` is declared by claim A but not exercised: the
    alpha.5 runner does not read a posture and no vector carries `run_outcome_by_posture`.
    Claim B declares `continue`, the loop's own. The corpus has no vector that
    distinguishes them.
  - The corpus reaches the tool seam only through a mock model, so claim A passes 4 of 47
    and the production tool seam, authority pinning, concurrency and labels are covered by
    the crate's own tests, not by the CTK. `bigint_json` is not declared (`serde_json`
    coerces beyond-u64 literals at load).
  - The vendored golden vector `G-15-rfc8785-numbers` expects `9.999999999999996e+22` for the
    input `9.999999999999997e+22`; RFC 8785 Appendix B (and `JSON.parse`) give
    `9.999999999999997e+22`. Every OpenSesame build parses numbers exactly
    (`float_roundtrip`), so a context carrying that number has the RFC's canonical form and an
    identity that differs from the vector's; the host's golden test checks the RFC's digits for
    that one fixture and the rest byte for byte. The difference is upstream's, not a choice here.
  - No row for either claim is filed in upstream `conformance/CLAIMS.md`, which is another
    repository.
  - Neither claim is a security certification (§1.4).
