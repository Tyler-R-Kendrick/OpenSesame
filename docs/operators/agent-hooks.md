# Agent hooks: policy, approvers and the audit

How to run OpenSesame as an [agent-hooks/0.1](https://github.com/responsibleai/agent-hooks/blob/v0.1.0-alpha.5/spec/AGENT-HOOKS-0.1.md)
interceptor and host: write the policy that decides what an agent may do, say
who is asked when it needs a person, and read what was decided. The decision
and its reasons are in [ADR 0159](../adr/0159-agent-hooks-interceptor.md); what
was run to check the host side is in
[Agent Hooks 0.1 conformance](../validation/agent-hooks-conformance.md).

Two things use the same policy and the same interceptor:

- **A framework you run** asks OpenSesame for a verdict at each point of its
  loop, through `opensesame hooks intercept` (a process per emission) or
  `POST /api/v1/agent-hooks/intercept` (the Host, under the organization's
  stored policy).
- **A run the Host executes** (a hosted web-login rotation, ADR 0076) emits the
  same points itself, with the organization's interceptor registered, and
  persists a payload-free record of every verdict.

Nothing here is an authority boundary. agent-hooks is a cooperative contract
(spec §1.4): the Host API still authorizes every use of a `ConnectionRef`
(ADR 0005), and the hook is defence in depth at the places an agent loop moves
content.

## The policy

A policy is a JSON document with a closed shape. There are no globs and no
regular expressions: a rule names a tool exactly or by a literal prefix.

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
    {
      "name": "crm.lookup",
      "decision": "allow",
      "labels": ["acme:pii"],
      "refuse_labels": ["acme:untrusted"]
    }
  ]
}
```

| Member | Meaning |
|---|---|
| `version` | Must be `1`. Any other version is refused. |
| `tools[]` | Rules, each with exactly one of `name` (exact) or `prefix` (literal start of the tool name), and a `decision`. A repeated name or prefix is refused. |
| `tools[].decision` | `allow`; `escalate` (refused unless a person lifts it, below); `deny` (nothing lifts it). |
| `tools[].reason` | A machine identifier for the verdict, 1 to 128 visible ASCII characters, never starting `host_error:` (reserved to hosts). Defaults to `opensesame:tool_denied` or `opensesame:tool_requires_approval`. |
| `tools[].message` | Text shown with the verdict. |
| `tools[].labels` | Labels this tool's results carry (below). |
| `tools[].refuse_labels` | Labels this tool's inputs may not derive from. |
| `unlisted_tools` | What a tool no rule names gets. Default `escalate`: an empty policy refuses until a person lifts it, so it fails closed without making an agent unusable to someone standing by. |
| `secret_guard` | `redact` (default), `deny` (deny every emission carrying a credential shape), `off`. |
| `refuse_labels` | Labels no tool's inputs may derive from, on top of each rule's own. |

An exact `name` beats any `prefix`; the longest matching `prefix` beats a
shorter one. Errors name a rule by position (`tools[2] must set exactly one of
name and prefix`), never by echoing text from the document.

The secret guard recognises credentials by the shapes their issuers made
distinctive (`ghp_`, `glpat-`, `AKIA`, `xox?-`, `sk_live_`, `sk-ant-`, `sk-`,
`AIza`, `npm_`, signed JWTs, PEM private keys, OpenSesame's own `secret://`
references), never by a label such as `password=`: agent content is full of
code. At `input`, `pre_model_call`, `post_model_call`, `post_tool_call` and
`output` a match is rewritten to `[redacted:<kind>]` by a `transform` of the
whole target. In **tool arguments** it is a plain deny
(`opensesame:raw_secret`) instead, and the deny is plain even for a tool that
would otherwise escalate: a person shown redacted arguments could not know what
they were approving.

### Label flow

A permit can carry labels (spec §5.4), and the host resurfaces them on later
emissions as `extensions.opensesame.source_labels`:

1. Whenever the guard rewrites content, the data that action produced carries
   `opensesame:credential_material`. The redaction removed the value; the label
   keeps the fact.
2. A tool rule's `labels` mark that tool's results (`acme:pii` on a CRM lookup).
3. A label is sticky: a permit also names every resurfaced label the policy
   knows, so data derived from labelled data stays labelled.
4. At `pre_tool_call`, inputs deriving from a label the rule's `refuse_labels`
   or the policy's `refuse_labels` names are a plain deny
   (`opensesame:label_flow_denied`). Putting `opensesame:credential_material` in
   `refuse_labels` refuses every tool call once credential material has flowed
   into its inputs.

The order at `pre_tool_call` is fixed and every refusal is a plain deny until
the last step: a rule's `deny`, then a credential in the arguments, then label
flow, then a rule's `escalate`. A `source_labels` this build cannot read is
`opensesame:context_unreadable`, so a host that garbles provenance cannot
launder it. Labels ride permits only, never a deny.

### Presets

Start from a named policy rather than a blank page. They are the files under
[`spec/agent-hooks/presets/`](../../spec/agent-hooks/presets/README.md), compiled
into the CLI and served by the Host.

| Preset | For |
|---|---|
| `rotation-web-login` | Hosted web-login rotation and capture runs: the eleven verbs of the tool boundary allowed, page reads labelled `opensesame:untrusted_page`, everything else denied, credential flow refused. |
| `strict` | Deny every tool no person has named; deny credential-shaped content anywhere. |
| `observe` | Allow every tool and keep the audit; credential shapes are still redacted. |

```bash
opensesame hooks policy preset ls                      # no Host needed
opensesame hooks policy preset show rotation-web-login
opensesame hooks check --policy ./policy.json          # parse; print with defaults filled
```

### Replacing the policy on the Host

```bash
opensesame hooks policy get                            # the policy, its version, its ETag
opensesame hooks policy put ./policy.json --if-version 3
opensesame hooks policy put --preset rotation-web-login --if-version 3
```

`put` is compare-and-set: `--if-version` is the version `get` printed (0 when
none is stored), and a policy someone else replaced since is refused with the
version it is now. The replacement and its `agent_hooks.policy.updated` outbox
event (carrying the policy's SHA-256, not the policy) commit together. Reading
is owner/admin or the operator. **Replacing takes a step-up** (ADR 0146): the
operator token (`OPENSESAME_OPERATOR_TOKEN`), or a human's native session with a
passkey step-up from the last five minutes. An administrator's plain session is
refused (`403 step_up_required`, with the remedy in `hint`) because the loop the
policy governs may be running under that very session. A session whose ceiling
carries agent capabilities is refused the same way (`403 step_up_required`,
reason `delegated_credential`), however fresh its evidence.

The passkey branch is implemented and tested against constructed claims, but no
session in this repository carries step-up evidence today (device approval is
operator-only), so **only the operator token satisfies it**. The same holds for
the approver setting and for pinning a recipe signer, which share the guard.

## Putting an interception to the policy

### The Host route

`POST /api/v1/agent-hooks/intercept` takes one `AgentContext` and answers one
`Verdict` under the caller organization's stored policy, with the policy version
in the `opensesame-hook-policy-version` header. The caller is the **agent
framework**: a native session of any role in the organization, or the operator.
An agent capability or a browser grant is refused, because an agent that could
call the route could probe the policy that governs it. A context over 5 MiB, not
UTF-8, or failing the spec's envelope check is answered `200` with a deny
verdict (a verdict endpoint answers with verdicts). Every decision is recorded
before it is handed out, and one that cannot be recorded is not handed out.

### The CLI

```bash
echo "$CONTEXT" | opensesame hooks intercept --policy ./policy.json   # one verdict on stdout
```

It needs no Host, daemon or network: the judgement is the local policy file and
the secret guard. `OPENSESAME_HOOK_POLICY` names the file. A context it cannot
read is answered with a deny; a policy it cannot load exits non-zero with
nothing on standard output, which a conformant host turns into
`deny host_error:interceptor_failed` (spec §6.3).

## Who is asked: approvers

A tool rule that escalates is a liftable deny. Only the host's approval seam
(spec §9) lifts it: it raises an Identity-plane interaction to a person, bound to
the request's `context_identity`, and the person answers with a passkey-backed
approval. Until that seam is configured **every escalation is a denial**, which
is the conformant reading of an unresolved approval.

What a person approves is bound to the request. The `context_identity` (a digest
of the context after every credential shape was replaced by a marker, so what
they were shown held no secret) travels inside the authorization details the
Identity API digests, and the approver recomputes that digest itself before it
believes an approval. An approval is spent exactly once, before it counts, so one
approval cannot lift two emissions; and it lifts to a plain `allow`, never a
rewrite.

### 1. Deployment: which Identity API, and as whom

The operator configures the requester once, in the environment
([`.env.schema`](../../.env.schema) is authoritative):

| Variable | |
|---|---|
| `OPENSESAME_AGENT_HOOKS_APPROVER_URL` | The Identity API origin. `https` only, loopback `http` allowed; no userinfo, query or fragment. |
| `OPENSESAME_AGENT_HOOKS_APPROVER_BEARER` | The requester's bearer on it. Sensitive; never logged, returned or audited. |
| `OPENSESAME_AGENT_HOOKS_APPROVER_REF` | Optional default approver handle, for an organization that has set none. |
| `OPENSESAME_AGENT_HOOKS_APPROVER_TTL_SECONDS` | How long a request stays answerable, 30 to 3600. Default 300. |
| `OPENSESAME_AGENT_HOOKS_APPROVER_POLL_MS` | How often to ask whether there is an answer. Default 2000. |
| `OPENSESAME_AGENT_HOOKS_APPROVER_DEADLINE_SECONDS` | How long one escalation waits before the action stays denied and the request is withdrawn. Default: the TTL. |

It is all or nothing, and checked at startup with the same constructor a run
uses: a URL without a bearer, a bearer without a URL, any other variable set
beside neither, an `http` URL to a real host, or a TTL out of range stops the
gateway from starting, naming the variable and never its value. Nothing set at
all is a valid deployment; escalations are simply denied.

**The requester bearer must belong to a principal distinct from every
approver.** The Identity API refuses a requester that asks itself, and refuses
to let a requester ask anybody but the request's addressee. Give the Host its own
service principal on the Identity API and use that principal's bearer here. It
also rate-limits prompts (20 per approver and 5 per requester and approver pair
in five minutes); a request over the budget is refused, which is a denial.

### 2. Organization: who is asked

Each approver gets their handle from their own session:

```bash
curl -H "authorization: Bearer $APPROVER_TOKEN" "$IDENTITY/v1/authorization-requests/inbox-ref"
# {"approverRef":"inbox_…"}
```

The organization's owner/admin then names it. The handle is stored beside the
policy, not in it (the policy document is strictly parsed and compared against
presets), with its own version and audit:

```bash
opensesame hooks approver get                          # asks, version, transport_configured
opensesame hooks approver put --ref inbox_… --if-version 0
opensesame hooks approver put --clear --if-version 1   # ask nobody
```

`GET|PUT /api/v1/agent-hooks/approver` is the same, compare-and-set on `If-Match`
like the policy, with the same step-up for `put`. `get` says who is asked in
one word: `organization` (this setting's handle), `operator_default` (the
deployment's, which it never shows) or `nobody`; and `transport_configured`,
whether the deployment has an Identity API at all. `--clear` is a decision to ask
nobody, not a fall back to the default. The `agent_hooks.approver.updated`
outbox event carries the handle's SHA-256, never the handle.

### 3. What a run does

Each hosted run builds its own seam when it starts: the organization's handle (or
the operator's default), through the deployment's Identity API, with
`redact_for_approver` registered as the approval redactor. The run is **held**
at the escalated step, with nothing enqueued for the driver, until the person
approves (the step proceeds), declines (`opensesame:approval_declined`), or the
deadline passes (the action stays denied and the interaction and request are
withdrawn). The whole run is still bounded by its own deadline.

### Approving from the CLI interceptor

`opensesame hooks intercept` can put its own escalation to a person, for a host
that spawns it per emission and has no seam of its own:

```bash
export OPENSESAME_HOOK_APPROVER_BEARER=…              # environment only, never argv
echo "$CONTEXT" | opensesame hooks intercept \
  --policy ./policy.json \
  --approver-url https://identity.example.com \
  --approver-ref inbox_…
```

(`OPENSESAME_HOOK_APPROVER_URL` and `OPENSESAME_HOOK_APPROVER_REF` are the
environment forms; `--approver-timeout-seconds`, default 300, is 30 to 3600.)
The bearer has no flag at all, so it is never on a command line, and standard
input already carries the context. All three are required together: a partial
configuration exits non-zero before reading anything. Approved is a plain
`allow`; declined or bound to another request is a `deny`
(`opensesame:approval_declined`, `opensesame:approval_not_bound`); no answer in
time leaves the escalation itself in place for the host to resolve, never a
`host_error:*` reason, which belongs to hosts.

## The audit

### Decisions

Every verdict the Host's intercept route answers is a row in
`agent_hook_decisions`: the interception point, the decision, whether it
escalated, a reason that is a short machine identifier, the policy version, who
asked, and when. Never a tool name, a target, a transform value or a message
(spec §14). It is an append-only table, not an outbox event; retention trims it
(`OPENSESAME_AGENT_HOOK_DECISION_RETENTION_DAYS`, default 90).

```bash
opensesame hooks decisions --decision deny --point pre_tool_call --limit 50
opensesame hooks decisions --escalated true --since 2026-10-01T00:00:00Z --all
```

Filters match exactly on `--decision`, `--point`, `--caller`, `--reason`,
`--escalated`, `--policy-version`, and a time window (`--since`, `--until`).
Newest first; a page prints its `next_cursor` to pass as `--cursor`, and `--all`
follows it to the end.

### Hook records of a hosted run

A run the Host opened has no viewer key to seal a log to, so its observation is
the payload-free record of every interception: point, decision, machine reason,
whether it escalated, and the `sha256:` identities of the context before and
after. `GET /api/v1/agent/runs/{id}/hook-records` reads them, and
`opensesame access connectors rotate hooks <run> [--follow]` prints them (`rotate watch` falls back
to them for these runs). They are readable by the run's owner and nobody else.
Records outlive neither their run nor its retention.

### Recipes

The runs the `rotation-web-login` preset governs replay signed change-password
recipes ([ADR 0076](../adr/0076-autonomous-web-login-rotation.md),
[recipe schema](../architecture/rotation-recipe-schema.md),
[teaching and replay](../architecture/rotation-teaching-and-replay.md)). A recipe
chooses the steps; the policy decides whether each step may be taken. A run with
no verified recipe, no owner, or a policy the Host cannot read is parked with the
reason, never started.

## What fails closed

| Situation | What happens |
|---|---|
| Tool no rule names | `unlisted_tools` (default `escalate`) |
| Credential shape in tool arguments | Plain deny `opensesame:raw_secret`, even for an escalating tool; no approval is raised |
| Context over 5 MiB, not UTF-8, or failing the envelope | Deny `opensesame:context_unreadable` |
| Policy it cannot load (CLI) | Exit non-zero, nothing on stdout |
| Stored policy the build cannot parse (Host) | The route answers 500 and a run parks "the organization's agent-hooks policy could not be read"; never the default |
| A decision that cannot be recorded | The route answers 500; the verdict is not handed out |
| Hook records that cannot be written | The run is settled as unaudited |
| Escalation, deployment has no approver configured | Stays a denial |
| Escalation, organization names nobody (or a default is not set) | Stays a denial; no request leaves the Host |
| Approver store unreadable, or stored handle unusable | Stays a denial |
| Person declines | Deny `opensesame:approval_declined` |
| Approval bound to another request | Deny `opensesame:approval_not_bound` |
| No answer by the deadline, Identity API down, approval withdrawn or already spent | Unresolved, which the host enforces as a deny; the interaction and request are withdrawn |
| Request with no `context_identity` | Never put to a person; unresolved |
| Partial approver configuration | Gateway does not start; CLI exits non-zero before reading standard input |
| Policy or approver replaced without a step-up | `403 step_up_required` |
| Agent capability or browser grant on any of these routes | Refused |
| A hosted run past its deadline | Stopped; settled as not submitted, or for reconciliation if a submit went out |

## Conformance claim

OpenSesame claims Agent Hooks 0.1 as an **interceptor** (the policy and guard
above) and as a **host** for its own agent-driven runs, in two separately stated
claims with what each does and does not show:
[Agent Hooks 0.1 conformance](../validation/agent-hooks-conformance.md). The
upstream contract is pinned exactly (`agent-hooks-sdk =0.1.0-alpha.5`); a bump is
a deliberate re-read of the spec with ADR 0159 updated.
