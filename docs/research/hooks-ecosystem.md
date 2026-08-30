# Hooks as an extensibility mechanism — ecosystem research

Research input for [ADR 0061](../adr/0061-connector-hook-architecture.md).
This document records *what other ecosystems did and what happened to them*,
maps their lessons onto OpenSesame's existing surfaces, and derives the
use-case tiers the ADR turns into rules. It is research, not a decision
record: where this document and ADR 0061 disagree, the ADR wins.

The question under study: OpenSesame wants communities to extend its
brokered capabilities — a user missing a connector should be able to write
one — without the extension mechanism becoming the vulnerability firehose
it became everywhere else. The product's premise (agents hold opaque
ConnectionRefs and intents, never raw secrets — ADR 0005) constrains the
answer more than most platforms' premises do, and, as it turns out, also
makes a safe answer more reachable.

## 1. What OpenSesame already has

There is no plugin runtime today, but the load-bearing parts of one exist
as contracts and enforcement:

- `wit/connector/world.wit` — the connector world (`opensesame:connector@1.0.0`)
  already defines the value-blind guest interface: exports `describe`/`invoke`
  over opaque `connection-handle`/`credential-handle` resources; imports only
  `host-http.authorized-request`, purpose-bound `host-crypto.sign`, and
  `host-oauth.acquire`. There is intentionally no `secrets.get` import, and
  `crates/connector-sdk` plus `crates/host-core` carry structural tests that
  fail the build if one appears.
- `crates/connector-host` — `trait Connector`, `HostRuntime` with
  `register_connector`/`bind_connection` (only a mock registered today),
  `HostPolicy { allowed_hosts, require_signature, trusted_digests,
  max_invoke_level }`, an SSRF fence (`is_blocked_host`), and a refusal
  vocabulary (`HostError::{DestinationDenied, PrivateAddress, DigestMismatch,
  UntrustedComponent, …}`) that reads like a hook host's error enum because it
  was designed as one. The `wasm_guest` module is a stub;
  a wasmtime workspace pin sat unused until this work activated it (on
  the 36 LTS line; the original 33 pin carried RUSTSEC advisories).
- `connectors/mock/connector.yaml` — a fully specified, unparsed declarative
  connector manifest: OCI component digest, WIT world, `signaturesRequired`,
  `outbound.hosts`, per-operation `risk`/`sideEffect`/`approvalRecommended`.
- The **outbox → claim-lease → deliver → compensate → dead-letter** saga
  (ADR 0039, implemented twice: `apps/gateway/src/backup.rs` and
  `apps/worker`), and **signed digest-only webhooks** (ADR 0046 D12,
  `packages/webhooks`, Standard Webhooks HMAC): "the event is a doorbell,
  not the door."
- ADR 0046 D11's **approval hook** — the closest existing hook security
  model: a registered agent may decide only inside an envelope its owner
  pre-authorized (request class ⊆, scope ⊆, budget, TTL), may never decide a
  high-risk action, and may never approve a request that would widen its own
  authority.
- **Data-not-code extensibility precedent**: the provider catalog is data
  (ADR 0032 D3), custom providers are org-scoped metadata rows
  (`migrations/0014_custom_providers.sql`), identity providers are flat-env
  descriptors behind a single trust fence (ADR 0055).
- **Default-off surfaces with mechanical gates**: per-surface cargo features
  and `scripts/daemon-deps-gate.sh` (ADR 0053); MCP servers with static tool
  manifests and negative assertions (`assertsNoSecretTools`,
  `assertsNoMaterializeTool`).

Third-party plugins were explicitly deferred "until allowed" (ADR 0006 §6,
`REUSE.md`). This research is the homework for allowing them.

## 2. Ecosystem survey

Nine ecosystems, each reduced to: the hook model, the isolation story, the
incident record, and the one transferable lesson.

### 2.1 Claude Code hooks and plugin marketplaces

~35 lifecycle events; handlers range from arbitrary shell commands through
HTTP endpoints to model-evaluated predicates. Blocking `PreToolUse` hooks
can rewrite tool calls; per-event timeout tiers with per-event failure
policy (a timed-out `PreToolUse` fails open, a timed-out `PreModelSwitch`
fails closed). No sandbox for command hooks — mitigations are configuration
tier: an enterprise `allowManagedHooksOnly` switch, an egress allowlist for
HTTP hooks, and an env-var allowlist gating what may be interpolated into
headers.

Incidents: CVE-2025-59536 — a repo's `.claude/settings.json` defined hooks
that executed on project open, i.e. cloning a repository was remote code
execution; a sibling flaw let project files override the API base URL and
exfiltrate keys. A 2026 marketplace audit found 76 malicious skill payloads.
Plugins bundle skills + MCP servers + hooks + binaries under one consent
click with no capability declaration.

**Lesson: a config file that causes execution is code, and is evaluated
before any trust decision the user meaningfully made. Manifests must be
inert data, parsed with unknown-field rejection, and capability-bearing
artifacts must be consented to individually, by digest.**

### 2.2 Git hooks and npm lifecycle scripts

Client-side git hooks live outside the object graph, so they are advisory;
frameworks (husky, pre-commit) reinstall them from tracked config at
`npm install` time — converting a versioned data file into code execution.
That is the same pattern as npm `postinstall`, which produced the axios
compromise (RAT via a transitive install script) and Shai-Hulud (500+
infected packages); GitHub has since disabled automatic install-script
execution. CVE-2026-3854: GitHub Enterprise treated hook-directory paths in
user-influenced metadata as trusted, so path traversal turned hook
resolution into an execution primitive.

**Lesson: never let user-influenced data steer *which code runs*; hook
resolution must go through operator-pinned identity (a digest, not a
path or a name).**

### 2.3 Webhooks (GitHub / Stripe / Slack)

Async, out-of-process, observe-only — structurally the safest hook shape.
Converged practice: HMAC-SHA256 over the raw body, timing-safe compare,
signed timestamp with a small tolerance (Stripe: 5 minutes), delivery GUID
as idempotency key, outbox + at-least-once + consumer idempotency. Two SSRF
directions: attacker-supplied callback URLs aiming the provider's egress at
metadata services or intranets (mitigation: destination allowlists and
DNS-rebind-safe resolution), and receiver-side provider IP pinning. Thin
payloads (ID + event type, receiver fetches with its own credentials) beat
fat payloads: the fetch re-authorizes the read.

OpenSesame already implements almost all of this (ADR 0046 D12,
`packages/webhooks`); the one gap found during this research is that webhook
registration validates only `https://` and lacks a private-IP/DNS-rebind
fence — `connector-host`'s `is_blocked_host` exists but is not applied
there.

**Lesson: thin, digest-shaped payloads make a hook channel structurally
incapable of exfiltration; the receiver's own credentials re-authorize
every read.**

### 2.4 WordPress actions/filters

The canonical in-process hook system: every plugin callback runs in the
same PHP process with the web server's full authority, and authorization is
a convention *inside* the callback (`current_user_can()`, nonces) that the
dispatcher never enforces. The result is proportional to ecosystem size and
permanent: 11,334 new ecosystem vulnerabilities in 2025, 91% in plugins,
43% unauthenticated-exploitable, mass exploitation observed within hours of
disclosure. The canonical bug is a `nopriv` AJAX handler that forgets the
capability check and consumes `$_POST` into `set_role()`.

**Lesson: the dispatcher must enforce authorization before invoking the
hook. A hook system whose safety depends on every callback author
remembering a check will produce vulnerabilities at ecosystem scale,
indefinitely.**

### 2.5 Kubernetes admission webhooks → CEL; GitHub Actions

Admission webhooks are out-of-process gates on the API server's critical
path. Their two primitives — `timeoutSeconds` (hard-capped) and
`failurePolicy` — expose an unresolvable dilemma: `Fail` turns an unhealthy
webhook into a cluster-wide outage; `Ignore` lets an attacker disable the
policy by DoS-ing the webhook. Kubernetes' answer was architectural:
`ValidatingAdmissionPolicy` (GA 1.30) replaces the webhook with CEL
expressions evaluated in-process — a non-Turing-complete language with
guaranteed termination and bounded cost. No network hop, no cert rotation,
no timeout, no DoS-to-bypass.

GitHub Actions supplies the ambient-authority counterexample:
`pull_request_target` runs attacker-influencable workflows with
write-scoped tokens and secrets ("pwn requests"), and `${{ }}`
interpolation into `run:` blocks is shell injection by construction.

**Lesson: most hooks in the wild are predicates, and predicates should be
declarative data, not code. Where a gate must exist, the platform — never
the hook author — fixes the timeout and the failure policy.**

### 2.6 Wasm plugin systems

The capability baseline: wasmtime + WASI component model — guests start
with zero capabilities, all outside interaction flows through explicitly
granted typed imports, and WIT makes the grant set a reviewable,
machine-checkable artifact. **Shopify Functions** is the strongest
production posture and the reference for this ADR: no network, no
filesystem, no cross-invocation memory (fresh instance per run), a
tightly-cut WASI subset, deterministic by construction, fuel-metered with a
hard instruction cap. Result: computable worst-case latency and guaranteed
tenant non-interference. Envoy's proxy-wasm shows the residual risk — a
sandboxed filter still DoS'd its host through resource contention — and
Cloudflare Workers shows the microarchitectural limit: a 2026 demonstration
leaked a JWT from a co-located Worker via Spectre at ~12 bits/second.
Wasmtime itself documents Spectre as unresolved.

**Lesson: Wasm isolation is a strong logical boundary and a weaker
microarchitectural one. Give guests zero ambient authority, meter fuel and
wall-clock, start every invocation with empty memory — and never co-locate
guest execution with raw credential material; the credential stays on the
host side of the boundary.**

### 2.7 eBPF

The verified-hook model: a static verifier proves termination and memory
safety before load — the strongest safety property surveyed. But the
verifier is a blocklist of prohibited behaviors, not a positive proof, and
it became the attack surface: CVE-2020-27194 and successors turned verifier
range-tracking bugs directly into kernel read/write, and speculative type
confusion bypasses the logical guarantees entirely. A large verifier for a
general language costs a permanent CVE stream.

**Lesson: prefer a small, total, analyzable language (CEL/Cedar-shaped)
over a big verifier for a general one; where general computation is
needed, prefer a sandbox with metering (Wasm) over verification.**

### 2.8 Browser extensions vs. VS Code extensions; Cedar/Rego

Chrome MV3 is the good example: a declarative permission manifest surfaced
at install, isolated worlds for content scripts, and — the key move —
content scripts lost cross-origin fetch and must ask the privileged
background worker to perform network I/O under policy. That is the broker
pattern, and it is ConnectionRef's pattern. VS Code is the anti-example: no
permission model at all, a theme has the same authority as a debugger,
silent post-trust updates (rug pull by design), and hundreds of millions of
malicious-extension installs to show for it. On policy languages: Rego is
expressive and error-prone; Cedar deliberately trades expressiveness for
analyzability — default-deny, forbid-overrides-permit, order-independent,
side-effect-free, formally specified.

**Lesson: the untrusted component never performs I/O itself; it asks a
mediator that applies policy. And permission fields must be restrictive
declarations, never permissive auto-approvals.**

### 2.9 MCP ecosystem (2025–2026)

Threats that materialized: tool poisoning (malicious instructions in tool
descriptions the user never sees), rug pulls (a tool approved when clean
silently updates), confused deputy (server acts with its own broader
privileges), token passthrough, and the "lethal trifecta" (private data +
untrusted content + an egress channel). Converged mitigations: hash tool
definitions at approval and re-verify before every execution; audience-bound
tokens (RFC 8707 resource indicators); per-server scoped ephemeral
credentials; strict schemas with `additionalProperties: false`; fail closed
on verification failure.

**Lesson: consent binds to a content digest, not a name — and is
re-verified on every use, not once at install.**

## 3. Failure modes and mitigations

Recurring failure modes across the survey:

| # | Failure mode | Canonical instance |
|---|---|---|
| F1 | Ambient authority — the hook inherits the host's privileges | WordPress, VS Code, Actions `pull_request_target`, npm scripts |
| F2 | Config-file-as-code, evaluated before trust | CVE-2025-59536, `.git/hooks`, `postinstall`, CVE-2026-3854 |
| F3 | Blocking-hook DoS / failure-policy dilemma | K8s `failurePolicy`, Coraza-on-Envoy hang |
| F4 | Hook-output injection into a trusting consumer | Actions `${{ }}`, MCP tool poisoning |
| F5 | Supply-chain trust transitivity (one consent, N authors) | Claude plugins, npm transitive scripts |
| F6 | Update rug-pull — consent bound to a mutable name | MCP, VS Code silent updates, unpinned Action tags |
| F7 | Secret exfiltration via hook egress | base-URL override exfil, Shai-Hulud, lethal trifecta |
| F8 | Consent-view / execution-view divergence | Unicode-concealed MCP descriptions, permissive `allowed-tools` |
| F9 | Convention-based authorization in the callback | WordPress (91% of ecosystem vulns) |
| F10 | Verifier/parser complexity as the new attack surface | eBPF verifier CVEs |
| F11 | Microarchitectural leakage across co-tenants | Workers Spectre JWT leak |
| F12 | Mutating hooks composing non-deterministically | K8s mutating-webhook re-invocation, filter priority wars |

Mitigations that demonstrably worked, each mapped to what OpenSesame
already has:

1. **Capability-based sandboxing, zero ambient authority** (WASI/WIT) — the
   connector world already grants exactly three imports. (F1, F7)
2. **Declarative over code** (K8s CEL, Cedar) — the provider catalog,
   custom-provider rows, and identity descriptors are already this. (F1,
   F3, F10, F12)
3. **Deterministic, bounded, I/O-free guests** (Shopify Functions) — fuel +
   epoch deadline + fresh memory per invoke. (F3, F7, F11)
4. **Broker-mediated I/O** (MV3, ConnectionRef) — all egress through
   `ConnectionBroker`, host-side credential injection, exact-host
   allowlists, no redirects. (F1, F7)
5. **Thin, value-blind payloads** — digests and handles, never values;
   already the audit and webhook doctrine (`DENY_KEY`, doorbell-not-door).
   (F7)
6. **Digest-pinned consent, re-verified per use** (MCP lesson, sigstore
   direction) — `HostPolicy::trusted_digests` is the seat for it. (F5, F6,
   F8)
7. **Platform-fixed failure policy** — gating paths fail closed with
   platform-set budgets; observers are async and outbox-delivered; the hook
   author never chooses which they are. (F3)
8. **Dispatcher-enforced authorization** — the broker checks policy before
   the connector runs; a connector cannot forget a check it never owned.
   (F9)
9. **Manifests as inert, strictly-parsed data** — `deny_unknown_fields`,
   typed enums, a fuzz target per parser (existing repo rule). (F2, F10)

## 4. Use-case tiers

The survey sorts community-extension use cases into four tiers by the
authority they require. The tier vocabulary is used by ADR 0061 and by the
per-family rules below.

**Tier 1 — data-only descriptors.** The extension is a reviewable data
file; the platform executes. No code, no runtime risk. Examples: identity
provider descriptors (endpoints, scopes, subject field — ADR 0055 shape),
attachment-upload request shapes, certificate-issuer rows, provider catalog
entries, notification routing rules.

**Tier 2 — catalog-driven constrained HTTP.** The extension declares
operations and egress; the platform's broker executes constrained HTTP with
host-injected credentials (`ConnectionBroker::invoke_network_json` /
`authorized_bytes`). This tier already ships and carries the custom-provider
path.

**Tier 3 — Wasm components.** For logic that data cannot express: request
canonicalization, pagination/cursor arithmetic, exotic auth signature
string construction (the *key* stays host-side; the guest emits the
string-to-sign), protocol adapters. Shopify-Functions rules: the three WIT
imports only, fresh memory per invoke, fuel + deadline + memory caps,
digest-pinned, fail closed.

**Tier X — never community-pluggable.** Raw credential receipt or return;
private-CA key custody; TrustClass/trust-semantics assignment; identity
token-exchange code; password-manager plaintext reads (human plane,
ADR 0052, forever); arbitrary shell/subprocess hooks; hooks that can
*grant* or widen authorization (community hooks are deny/annotate-only, per
ADR 0046 D11's never-self-widening rule); independent network egress; free
text injected into an agent's LLM context.

## 5. The six capability families

How OpenSesame's first-party brokered capabilities map onto the tiers —
ordered by (value ÷ secret-exposure risk), which is also the recommended
migration order:

| Family | Today | Seam | Tier | Exposure at seam |
|---|---|---|---|---|
| Backup / file storage | GitHub-hardcoded saga (`apps/gateway/src/backup.rs`); Dropbox-hardcoded attachment replication (`routes/attachments.rs`) | `SnapshotFile` values; `attach_replication_units()` | 1–2 now, 3 later (`backup.commit` op) | Ciphertext only, by construction |
| Certificates | Three issuers hardcoded in closed matches; not even a catalog category | `Dns01Provisioner` trait; issuer descriptor rows | 1–2 (issuer rows, brokered DNS-01) | ACME creds/keys stay host-side |
| Identity | Flat-env descriptors + BYO rows behind `resolveTrustedIssuer` | `ProviderDescriptor` | 1 only — descriptors, never code | Descriptors carry client secrets → files carry env *references*, never values |
| Cloud secret storage | Catalog rows are `configuration`-mode (not server-executable); human-plane argv table | `trait Connector` + WIT world | 2, then 3 after catalog promotion | Metadata at the seam; credentials host-injected |
| Local storage | Concrete `StoreRoot`; `TombBackend` enum | A future `ObjectStore` **under** `path::confined_*` | 3 (deferred) | Ciphertext-only iff below `confined_*`; plaintext at `StoreRoot` — forbidden level |
| Password managers | Bespoke by design (ADR 0052/0053), plaintext human plane | Split: agent-safe metadata ops (WIT) vs native bridge trait | 3 for metadata ops; Tier X for plaintext | Plaintext is the product; never enters a guest |

Client-side, `apps/pages/src/lib/vault/import/types.ts` (`ImportAdapter`,
13 registered adapters) is already a genuine community-shaped TS plugin
interface for password-manager *imports* — plaintext stays inside the
user's browser vault, which is the one place it belongs. It is the
template for client-plane community surfaces.

## 6. Invariants any hook system inherits

Restated from the survey and the repo's own gates; ADR 0061 turns these
into decisions:

- No `secrets.get`/materialize affordance reachable from any extension, in
  any world, manifest, tool name, or route (ADR 0005; structural tests).
- Hooks see digests and handles: `parameters-digest`, `connection-ref`,
  `receipt-summary` — never values. Audit metadata stays digest-shaped
  (`DENY_KEY` runs first).
- All egress is the host's: exact-host, https-only, no wildcards, no
  redirect following, allowlist intersection of policy ∩ manifest.
- Authority is ratchet-only: community hooks narrow, deny, or annotate;
  they never allow, mint, or widen — and never touch `HIGH_RISK_ACTIONS`.
- Consent = operator-pinned content digest, re-verified before every
  instantiation.
- Fail closed on every parse, load, bind, and verification failure.
- The daemon's dependency tree gains nothing (`daemon-deps-gate`); any
  runtime is a default-off cargo feature on the gateway side.
- Every new parser gets a fuzz target; every negative rule gets a
  structural test.

## 7. Sources

Claude Code / marketplaces: code.claude.com/docs/en/hooks;
research.checkpoint.com (CVE-2025-59536);
sonarsource.com/blog/claude-arbitrary-code-execution;
sentinelone.com (marketplace skills audit).
Git/npm: wiz.io (CVE-2026-3854); safedep.io (axios compromise);
infoworld.com (npm install-script removal).
Webhooks: docs.stripe.com/webhooks; webhooks.fyi; svix.com webhook security.
WordPress: patchstack.com State of WordPress Security 2026; wordfence.com
request-architecture series.
Kubernetes/CI: kubernetes.io ValidatingAdmissionPolicy GA;
securitylab.github.com (pwn requests, untrusted input);
outshift.cisco.com (admission-webhook dark side).
Wasm: docs.wasmtime.dev/security; wasi.dev; shopify.engineering
(Wasm outside the browser); blog.cloudflare.com (Workers security model,
revisiting Spectre).
eBPF: Linux Foundation / NCC Group verifier audit (2024);
google/security-research advisory GHSA-hfqc-63c7-rj9f.
Extensions/policy: developer.chrome.com content-scripts;
code.visualstudio.com extension-runtime-security; Cedar (OOPSLA 2024,
dl.acm.org/doi/full/10.1145/3649835); goteleport.com policy-language
benchmarking.
MCP: OWASP MCP Security Cheat Sheet; simonwillison.net (lethal trifecta);
modelcontextprotocol.io authorization spec; workos.com (RFC 8707).
