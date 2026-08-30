# ADR 0069 — Certificate syncs to external destinations

Status: Accepted
Date: 2026-08-30
Supplements: ADR 0005 (ConnectionRef / authority handles),
ADR 0032 §3 (catalog is data), ADR 0039 (outbox and compensating retries),
ADR 0053 ([pm-bridge binaries](0053-pm-bridge-binaries.md), feature-gated
default-off surfaces), ADR 0065
([agent-surface parity](0065-agent-surface-parity.md)),
ADR 0066 (Certificate Manager domain model)
Supersedes in part:
[ADR 0052 — automatic certificate authority selection](0052-automatic-certificate-authority-selection.md)
§ "ACME profile", **only** its refusal of automatic certificate deployment, and
only under the constraints of §2 below.
Plan: [docs/superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md](../superpowers/plans/2026-08-30-infisical-cert-manager-parity-swarm.md)

## Context

A certificate that has been issued is not yet doing anything. Somebody has to
put it on a load balancer, in a key vault, on a device. Today that is entirely
manual: OpenSesame delivers leaf material once, to the authenticated creator,
into their encrypted vault (ADR 0052-cert), and the last mile is a human with a
copy-paste. At the renewal cadences ADR 0066 makes possible, that last mile is
where certificates expire in production.

ADR 0052-cert refused to close it, listing "automatic certificate deployment"
alongside HTTP-01 and arbitrary ACME directories as "unsupported rather than
partially implemented". The refusal was correct at the time and for a specific
reason: automatic deployment means the gateway unseals a private key and hands
it to a third party over the network, on a schedule, without a human present.
That is the single most dangerous thing this system can do, and in 2026-08 there
was no mechanism that made it defensible.

Three mechanisms have landed since. Broker-fenced egress
(`ConnectionBroker::authorized_json`) means an outbound call goes to a
pre-registered connection's allowlisted hosts with host-injected credentials, not
to a URL from a request body. The outbox with compensating retries (ADR 0039)
means a delivery attempt is a durable, auditable, retryable record rather than a
fire-and-forget. And ADR 0065's parity registry means a capability can be
excluded from every agent surface mechanically, with a test that fails if
someone later maps it.

Those three, together, are what this ADR spends to buy the supersession.

## Decision

### 1. Supersession

**The exact supersession language.**

> ADR 0052-cert's "ACME profile" section refuses "HTTP-01, TLS-ALPN-01,
> arbitrary ACME directory URLs, and automatic certificate deployment … as
> unsupported rather than partially implemented." This ADR supersedes exactly
> one clause of that sentence — **automatic certificate deployment** — and
> replaces the blanket refusal with the bounded capability defined here:
> **certificate syncs**, which push an issued certificate, its chain, and where
> applicable its private key to an administrator-configured destination through
> a brokered connection. The supersession is conditional on every constraint in
> §2 holding; if any one of them is removed, this decision is void and the
> refusal stands. ADR 0052-cert's refusals of upstream HTTP-01 and TLS-ALPN-01
> are untouched here (see ADR 0068 §6); its refusal of arbitrary ACME directory
> URLs is superseded separately and on its own terms by ADR 0068 §5. Everything
> else in ADR 0052-cert — generated-key custody, deterministic issuer
> resolution, no trust downgrade, sealed storage with organization/purpose AAD,
> and one-time acknowledged human delivery — remains in force, and syncs are an
> **additional** delivery path, never a replacement for it.

### 2. The four constraints that make the supersession acceptable

These are not implementation notes. They are the terms of the trade, and each is
mechanically enforced rather than documented.

**(a) Destinations are administrator-configured connections, never request
data.** A sync row names a `connection_id` and a `destination_kind`. Every push
goes through `ConnectionBroker::authorized_json`, so the target host must be in
that connection's egress allowlist and the credential is injected host-side. A
sync request body cannot contain a URL, a hostname, a token, or a header. The
attack "create a sync pointing at my server" requires first creating a
connection to that server, which is an admin action, audited, and visible in the
connection list. Redirects are responses, not chases — the same fence
`BrokeredDns01` (`apps/gateway/src/cert_issuers/registry.rs`) already sits
behind.

**(b) Key material is unsealed only inside the sync actor pass, and never
returned to any caller.** The sealed leaf key is opened inside the destination
adapter's execution, held in a non-`Clone`, non-`Serialize` carrier with a
redacting `Debug` (the `SealedCertificateMaterial` pattern in
`crates/storage/src/lib.rs`), written into the outbound request body by the
adapter, and dropped. No route response, no run record, no log line, no error
string, and no audit payload contains it. `POST /api/v1/certmgr/syncs/{id}/run`
returns a run outcome, not a payload. This is the constraint that keeps a sync
from becoming an export-by-another-name: there is no code path from a sync to a
caller-visible key.

**(c) Every push emits an outbox audit event.** A sync run appends a
`sync_runs` row and a `certmgr.sync.ran` outbox event in the same transaction as
its state change (ADR 0066 §5), carrying the sync id, destination kind,
connection id, certificate id, outcome and a payload digest — never the payload.
Retries ride ADR 0039's compensation ladder, so a failed push is a visible,
bounded, retried record rather than a silent gap. "The certificate went
somewhere and nobody knows" is not a reachable state.

**(d) Syncs are excluded from every agent surface.** `certmgr.sync.*` capability
rows are excluded on `mcp_host`, `mcp_client`, and `webmcp`, citing this ADR.
No MCP act tool creates, edits, enables, or runs a sync. The reason is direct:
sync configuration is the one certificate operation whose effect is "the private
key leaves this system", and an agent that can create a sync can exfiltrate a
key without ever holding one. `packages/capability-registry`'s parity test fails
if a future change maps one of these onto an agent surface, so the exclusion
cannot rot.

Gate: `pnpm --filter @opensesame/capability-registry test`

### 3. What a sync is

A `cert_syncs` row binds one certificate to one destination:

| Field | Meaning |
|---|---|
| `certificate_id` | the certificate being pushed; must be OpenSesame-managed |
| `destination_kind` | which adapter runs (§4) |
| `connection_id` | the brokered connection carrying credentials and egress |
| `name_schema` | how the object is named at the destination |
| `remove_on_expiry` | delete the pushed object when the certificate expires |
| `include_root` | include the root in the pushed chain |
| `options_json` | destination-specific settings |
| `enabled`, `last_run_at` | scheduling state |

`name_schema` is a template over a fixed variable set —
`{{certificateId}}` (32 chars), `{{shortCertificateId}}` (22),
`{{commonName}}`, `{{profileId}}`, `{{applicationId}}`, `{{applicationName}}` —
with per-destination sanitization, because destination naming rules differ
(character classes, length caps, uniqueness scopes) and a name that a
destination silently truncates or rewrites breaks the mapping between our
inventory and theirs. Unknown variables are a validation error at write time,
not a literal at run time.

Only **OpenSesame-managed** certificates can be synced. An imported certificate
whose key we do not hold has nothing to push; a discovered certificate is
someone else's. Restricting to managed certificates also means the key that
leaves is one we generated under ADR 0052-cert's custody rules.

When the lifecycle actor renews a certificate, its active syncs re-run against
the successor automatically. Automatic re-sync is the entire point: a renewal
that does not reach the destination is worse than no renewal, because the
operator believes they are covered.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 4. Destination kinds, and the two that are feature-gated off by default

HTTP destinations, all broker-fenced, all with recorded-fixture contract tests
asserting the exact push payload (forthcoming
`apps/gateway/src/cert_syncs/`):

AWS Certificate Manager, AWS Elastic Load Balancing, AWS Secrets Manager,
Azure Key Vault, GCP Certificate Manager, Cloudflare, Chef, Citrix NetScaler,
Kemp LoadMaster, F5 BIG-IP, Nutanix Prism.

Two destinations are not HTTP and are treated differently:

- **Linux (SSH)** and **Windows (WinRM)** executors write the certificate onto a
  target machine and run a reload command. They are compiled behind per-surface
  cargo features, **default off**, exactly as the pm-bridge binaries are
  (ADR 0053). The reason is the same reason ADR 0053 gives: these surfaces
  execute commands on a remote host, which is a categorically larger capability
  than "POST a JSON body to an allowlisted API", and a capability of that size
  should be absent from a default build rather than merely disabled by
  configuration. An operator who needs it opts in at build time, which is a
  decision with a reviewer.

An adapter never invents its own HTTP client. Every one calls
`ConnectionBroker::authorized_json`; a new `reqwest` dependent would violate
ADR 0048 D5 and fails the dependency gate.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

### 5. Configuration and execution are both admin-scoped, and both human-driven

Creating, editing, deleting, enabling, or manually running a sync requires
application `admin` (ADR 0066 §3) — not `operator`. An operator can obtain
certificates; deciding where a private key is allowed to go is an
administrator's decision.

Manual runs (`POST /api/v1/certmgr/syncs/{id}/run`) exist so an administrator
can test a configuration and re-drive a failed push. Automatic runs happen only
on renewal and on the lifecycle actor's schedule. There is no
"sync everything" bulk route: each run names one sync, so the audit trail has
one event per push and a mis-click has a bounded blast radius.

Gate: `cargo +1.88.0 test -p opensesame-gateway`

## Alternatives considered

- **Keep the refusal.** The status quo. Rejected because the manual last mile is
  where automated renewal stops being useful, and because the three mechanisms
  in §Context now let us bound the risk in code rather than in prose. Keeping a
  refusal after its rationale has been addressed is not conservatism, it is
  staleness.
- **A pull model — destinations fetch from OpenSesame.** Attractive: no outbound
  key movement, no stored destination credentials. Rejected because it does not
  exist at the destinations. AWS ACM, Azure Key Vault, F5 and NetScaler have
  import APIs, not "call out to a CA" hooks, and building the pull side means
  building an agent for every platform.
- **Deliver only to the daemon, never to third parties.** This is the local
  credential-helper model (ADR 0049) and it is genuinely safer. It also does not
  reach a managed load balancer or a cloud key vault, which is where most of
  these certificates need to be. The two coexist; syncs cover the part the
  daemon cannot.
- **Allow agents to trigger syncs but not configure them.** Rejected. A
  triggerable sync plus a pre-existing misconfigured destination is still
  exfiltration, and the distinction between "configure" and "trigger" is exactly
  the kind of subtlety that erodes across refactors. Excluding the whole
  namespace is the version that stays true.

## Consequences

- Renewal becomes end-to-end. This is the capability that makes short-lived
  certificates practical for the destinations OpenSesame does not itself
  terminate.
- The gateway now has a code path that unseals a private key and sends it over
  the network without a human in the loop. It is the most sensitive path in the
  system. §2(b)'s "never returned to a caller" and §2(a)'s broker fence are the
  two invariants a security review should check first, and both have
  test anchors.
- Thirteen destination adapters are validated against recorded fixtures only —
  no live third-party calls in CI. A provider that changes its API breaks in
  production before it breaks in CI. This is recorded as a residual risk in
  `docs/validation/certificate-manager.md`.
- The SSH and WinRM executors are absent from default builds, so most operators
  never compile them. The cost is that their behavior is validated only in
  feature-gated tests against fakes.
- ADR 0052-cert's one-time human delivery is unchanged and remains the only way
  a *person* gets key material. Syncs move keys to machines; they never move
  keys to callers.
