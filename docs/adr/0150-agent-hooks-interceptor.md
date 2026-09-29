# ADR 0150 — OpenSesame as an agent-hooks/0.1 interceptor

- Status: Accepted
- Date: 2026-09-28
- Builds on: [ADR 0005](0005-authority-handle-connectionref.md) (agents hold
  `ConnectionRef`s, never secrets), [ADR 0008](0008-better-auth-oidc-provider.md)
  (mature libraries over our own protocol code),
  [ADR 0065](0065-agent-surface-parity.md) (every capability on the registry),
  [ADR 0065 — connector hooks](0065-connector-hook-architecture.md) and
  [`docs/research/hooks-ecosystem.md`](../research/hooks-ecosystem.md)
  (hooks as data, fail closed, never widening), [ADR 0086](0086-wallet-native-interaction-layer.md)
  (an approval counts only when its proof is bound to the request digest)

## Context

Agent frameworks each grew their own hooks — Claude Code's `PreToolUse`,
LangChain callbacks, the OpenAI Agents SDK guardrails, Semantic Kernel
filters — with different event names, payloads, verdicts and failure
policies. A governance product had to write one adapter per framework and
re-learn each one's answer to "what happens when the hook times out".

[Agent Hooks 0.1](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md)
(`agent-hooks/0.1`, MIT, announced as a framework-neutral AI governance
contract) replaces that with one contract:

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

## Decision

### 1. OpenSesame takes the interceptor's side, on the canonical core

`crates/agent-hooks` (`opensesame-agent-hooks`) depends on the canonical
Rust core, `agent-hooks-sdk`, pinned exactly (`=0.1.0-alpha.5`). The core
owns envelope validation, canonical JSON and context identity, verdict
validation, transform application and composition; every other language SDK
binds to it over FFI. We do not re-implement any of it (ADR 0008). The pin
is exact because the contract is pre-1.0: a bump is a deliberate re-read of
the spec, with this ADR updated when the contract moves.

OpenSesame is not a host here. It runs no agent loop that this ADR wires; a
host is the framework that does, and it registers OpenSesame's interceptor
in process (Rust) or runs `opensesame hooks intercept` per emission
(everything else).

### 2. One verdict from two controls

`OpenSesameInterceptor` returns one verdict per emission:

- **Tool rules at `pre_tool_call`.** An operator policy allows, escalates or
  denies each tool by exact name or literal prefix. An exact name beats any
  prefix; the longest prefix beats a shorter one. A tool no rule names
  **escalates** by default — refused unless a person lifts it, so an empty
  policy fails closed without making every agent unusable to a person
  standing by.
- **The secret guard at every content seam** (`input`, `pre_model_call`,
  `post_model_call`, `post_tool_call`, `output`). A credential-shaped string
  is rewritten to `[redacted:<kind>]` by a `transform` of the whole
  `$target`, so the model never reads it and the caller never receives it.
  In **tool arguments** it is a plain deny instead: a rewrite would hand the
  tool garbage, and an agent passing a raw secret to a tool is what a
  `ConnectionRef` exists to prevent. The deny is plain even for a tool that
  would otherwise escalate: a person shown redacted arguments could not know
  what they were approving.

Nothing is decided at `agent_startup` or `agent_shutdown`: there is no
content to guard, and the spec forbids a transform there.

### 3. The policy is data, strictly parsed

The policy is a JSON document with a closed shape (`deny_unknown_fields`,
typed enums, version `1`), per the hooks research: a config file that
causes execution is code, and most gates are predicates data can express.
There are no globs and no regular expressions — nothing whose cost or
meaning depends on the input matched. Ambiguity is refused at load: a rule
with both or neither selector, a repeated name or prefix, or a `reason`
beginning `host_error:` (reserved to hosts, §11). Errors name a rule's
position, never its content.

```json
{
  "version": 1,
  "unlisted_tools": "escalate",
  "secret_guard": "redact",
  "tools": [
    { "prefix": "github.", "decision": "allow" },
    { "name": "shell", "decision": "deny", "message": "no shell on this agent" },
    { "name": "deploy", "decision": "escalate", "reason": "acme:change_window" }
  ]
}
```

`secret_guard` is `redact` (default), `deny` (deny every emission carrying
one), or `off`.

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
`context_unreadable`, `approval_declined`, `approval_not_bound`) or the
operator's own. Messages name credential kinds and counts
(`github_token×2`), never text from the target (§14). The record a host
persists keeps `reason` and a truncated `message` and drops
`transform.value`, so neither the secret nor its redacted surroundings
reach the audit trail.

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
- an approval lifts the deny to a plain `allow`, never a `transform`: an
  approver that could rewrite the action would be its second author, and an
  approval only narrows (ADR 0046 D11);
- no answer — a timeout, a broken channel — is `unresolved`.

`redact_for_approver` is the emitter's approval redactor: credential shapes
become markers before the context leaves for an approver, and because the
host computes `context_identity` over the redacted context (§9), what a
person's proof binds to is what they saw — which held no secret.

### 7. A CLI verb for out-of-process hosts

`opensesame hooks intercept [--policy FILE]` reads one `AgentContext` from
standard input and writes one `Verdict` to standard output. It needs no
Host, daemon or network. A context over 5 MiB (§12.3), not UTF-8, or
failing the SDK's §4 envelope check is answered with a deny — the
interceptor fails closed on its own, never relying on the host having
validated. A policy it cannot load exits non-zero with nothing on standard
output, which a conformant host turns into `deny
host_error:interceptor_failed` (§6.3). `opensesame hooks check` prints a
policy with every default filled in. `OPENSESAME_HOOK_POLICY` names the file
for both.

Both are CLI-only capabilities in `packages/capability-registry`
(`agent_hooks.intercept`, `agent_hooks.policy.check`). They are excluded on
the MCP servers and WebMCP — the agent is the subject of a verdict, never
its caller, and a tool it could call would let it probe or pre-clear its own
policy — and on Pages, the extension and Android, which run no agent loop.

## Consequences

- Any framework with an agent-hooks adapter gets OpenSesame's tool rules
  and secret guard without an OpenSesame-specific integration, and the
  framework's composition profile, timeouts and records apply unchanged.
- The secret guard is defence in depth, not the authority boundary. A host
  that ignores verdicts voids it (§1.4); the Host API's `ConnectionRef`
  authorization does not depend on it.
- Shape recognition misses credentials without a distinctive shape (a
  random database password). That is the price of not rewriting code; the
  answer to such a secret is to never give it to the agent at all.
- A redacted tool result changes what the model sees. The marker names the
  kind, so an agent can tell a credential was withheld and ask for a
  `ConnectionRef` instead.
- The upstream core is alpha. The exact pin, and this ADR, move together.

## Not done here

- **An `Interaction`-backed `HumanApprover`.** The port and its binding
  rules land here; the adapter that opens an ADR 0086 interaction with
  `requestDigest = context_identity` and waits on its settlement is the next
  step, and needs the Identity plane's interaction client.
- **A Host API route.** A remote interceptor endpoint (`AgentContext` in,
  `Verdict` out, over the Host's authenticated transport) would serve hosts
  that cannot spawn a process. It is a new gateway capability and gets its
  own review.
- **OpenSesame as a host.** The sandboxed runs of ADR 0081 are an agent
  loop; emitting agent-hooks from them, with CTK conformance, is separate
  work.
- **Result labels.** `result_labels` (§5.4) could mark a tool result that
  carried credential material for label-flow tracking. Nothing consumes
  them yet.
