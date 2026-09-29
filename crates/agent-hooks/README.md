# opensesame-agent-hooks

OpenSesame as an [agent-hooks/0.1](https://github.com/responsibleai/agent-hooks/blob/main/spec/AGENT-HOOKS-0.1.md)
interceptor. agent-hooks is a framework-neutral control contract: an agent
framework (the host) builds an `AgentContext` at eight fixed points of its
loop, asks every registered interceptor for a `Verdict` — `allow`, `deny` or
`transform` — and must honour the combined result. This crate is the
OpenSesame judgement on the interceptor's side. Host / authority plane.

It does not re-implement the contract. The canonical Rust core,
[`agent-hooks-sdk`](https://crates.io/crates/agent-hooks-sdk) (MIT, pinned
exactly to `=0.1.0-alpha.5`, re-exported as `sdk`), owns envelope validation,
canonical JSON, context identity, verdict validation and composition.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli) — `opensesame hooks intercept`
  (context on stdin, verdict on stdout) and `opensesame hooks check`.
- **Builds on:** `agent-hooks-sdk` for the contract, `regex` for credential
  shapes. No Host, daemon or network is needed to decide.
- It is defence in depth, not the authority boundary: agent-hooks is a
  cooperative contract (spec §1.4), and the Host API's `ConnectionRef`
  authorization (ADR 0005) does not depend on it.

## What it decides

| Point | Decision |
|---|---|
| `pre_tool_call` | The policy's rule for the tool (exact name, else longest prefix, else `unlisted_tools`, default `escalate`). Plain denies, in this order: the rule's `deny`; a credential in the arguments (`opensesame:raw_secret`); inputs whose `extensions.opensesame.source_labels` meet the rule's or the policy-wide `refuse_labels` (`opensesame:label_flow_denied`, naming the labels). Only then does `escalate` apply. `source_labels` that is not an array of strings is `opensesame:context_unreadable` |
| `input`, `pre_model_call`, `post_model_call`, `output` | Credential shapes become `[redacted:<kind>]` by a `transform` of `$target` carrying `result_labels: ["opensesame:credential_material"]` (`secret_guard: redact`, the default), or a deny (`deny`) |
| `post_tool_call` | As above, and every permit also carries the matching rule's `labels` (rule labels first, then carried labels, then the built-in one, each once) |
| `agent_startup`, `agent_shutdown` | `allow` |

Reasons are fixed `opensesame:*` identifiers; messages name credential kinds
and counts, never content. A deny never carries `result_labels` (spec §5.4:
nothing is persisted for an action that did not proceed).

### Result labels (spec §5.4)

The host persists a permit's `result_labels` beside the data the action
produced and resurfaces them as `extensions.opensesame.source_labels` on a
later emission whose `target` derives from it. A policy uses both ends:

```json
{
  "version": 1,
  "refuse_labels": ["opensesame:credential_material"],
  "tools": [
    { "prefix": "crm.", "decision": "allow", "labels": ["acme:pii"] },
    { "name": "email.send", "decision": "allow", "refuse_labels": ["acme:pii"] }
  ]
}
```

A label is `namespace:name` (`^[a-z][a-z0-9_]*:[a-z0-9_.:-]+$`), at most 64
bytes, at most 16 per list, no repeats. A bad label is refused at load by
position (`tools[1].refuse_labels[0]`), never echoed. A verdict message only
ever names labels from the policy; a context's own labels are compared, not
repeated.

Labels are sticky. Every permit at a content seam, and an allowed
`pre_tool_call` (the tool's result derives from its arguments), also carries
each resurfaced `source_labels` entry the policy knows — the built-in label or
one a list names — so a host that resurfaces one hop at a time still refuses
`email.send` two hops after the CRM lookup (result → model → tool call). A
string the policy never names is not carried: the record keeps
`result_labels` verbatim. Malformed `source_labels` is
`opensesame:context_unreadable` at every seam that reads it.

## Surface

| Item | What it is |
|---|---|
| `OpenSesameInterceptor` | `new(policy)`, `decide(&ctx)`, `decide_json(&str)`; implements the SDK's `Interceptor` |
| `HookPolicy`, `ToolRule`, `ToolDecision`, `SecretGuard`, `PolicyError` | The policy document: `parse`, `check`, `tool(name)`; `labels` / `refuse_labels` on a rule, policy-wide `refuse_labels`; `PolicyError::Label` / `RuleLabel` name a bad label by position |
| `labels` | `is_label`, `LABEL_CREDENTIAL_MATERIAL`, `REASON_LABEL_FLOW_DENIED`, `MAX_LABELS`, `MAX_LABEL_BYTES`, `LABEL_NAMESPACE`, `SOURCE_LABELS` (the first three also at the crate root) |
| `secrets` | `redact`, `scan`, `Findings`, `CredentialKind`, `marker` |
| `BoundApprovalResolver`, `HumanApprover`, `HumanDecision`, `ApprovalPrompt`, `ApproverError` | The approval seam, with `context_identity` as ADR 0086's request digest |
| `redact_for_approver` | An approval redactor for `InterceptionEmitter::set_approval_redactor` |
| `sdk` | The re-exported `agent_hooks` core |

## Develop

```bash
cargo +1.88.0 test -p opensesame-agent-hooks
cargo +1.88.0 test -p opensesame-cli --test hooks_intercept
```

`tests/emitter.rs`, `tests/labels.rs`, `tests/label_propagation.rs` and
`tests/approval.rs` drive the interceptor through the SDK's own
`InterceptionEmitter`, so every verdict passes the canonical §5 validation
and record projection. Credential fixtures are assembled at run time so no
source file holds a string a secret scanner would flag.

## Related

- [ADR 0150](../../docs/adr/0150-agent-hooks-interceptor.md) — this crate
- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) — agents
  hold `ConnectionRef`s, never secrets
- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — digest-bound
  approvals
- [`docs/research/hooks-ecosystem.md`](../../docs/research/hooks-ecosystem.md) —
  why the policy is data
