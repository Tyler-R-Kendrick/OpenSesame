# DNS enforcement — what was measured, and what may be claimed

Validation record for `crates/dns-enforcement` (swarm **DNS**, work items
`DNS-INSTANCE`, `DNS-SCOPE`, `DNS-LIFETIME`, `DNS-TEST`, `DNS-TRUTH`).

Every behavioural claim in the crate's documentation comes from this file, and
every claim here comes from a measurement against a real binary. Where Blocky's
documentation and the running server disagreed, the server won and the
disagreement is recorded below rather than smoothed over.

## 1. What was measured

| | |
|---|---|
| Backend | [Blocky](https://github.com/0xERR0R/blocky) |
| Version | `v0.35.0` (latest release at time of measurement) |
| Pinned by | `go install github.com/0xERR0R/blocky@v0.35.0` |
| Version injected with | `-X github.com/0xERR0R/blocky/util.Version=v0.35.0`, the ldflag Blocky's own `Makefile` uses |
| Self-reported | `blocky Version: v0.35.0` |
| Binary sha256 | `1e836631ff010d1262aa4c3ef525588a222104c92d18b8c1c54cc15749d280e7` |
| Built with | `go1.26.5 linux/arm64`, on `Linux aarch64` |
| Environment | Disposable tree under `/tmp`, high ports (DNS `55353`, HTTP `54780`), no elevation, nothing installed system-wide |

The sha256 is specific to this architecture and toolchain; it records *what was
measured here*, not a value to assert elsewhere. The module version and the
injected self-report are the portable part of the pin.

`blocky version` reports `Build time: undefined` and `Architecture: undefined`
because `go install` does not apply the other two ldflags. Only the version
matters for pinning a claim, so the harness injects that one and leaves the rest
honest rather than fabricating them.

Reproduce with:

```bash
eval "$(crates/dns-enforcement/harness/blocky-env.sh up)"
cargo +1.88.0 test -p opensesame-dns-enforcement -- --test-threads=1
crates/dns-enforcement/harness/blocky-env.sh probe-isolation
crates/dns-enforcement/harness/blocky-env.sh down
```

`--test-threads=1` is required: the protocol tests mutate one instance's
allowlists and blocking state, so running them concurrently makes them fight.

## 2. The measurements

### 2.1 A bare disable turns off everything, indefinitely

The hazard the crate is shaped around. `GET /api/blocking/disable` with no
`groups` parameter:

```
$ curl -s "$API/blocking/disable"; curl -s "$API/blocking/status"
{"disabledGroups":["default","unit-alpha","unit-beta"],"enabled":false}
```

Every group went down. **No `autoEnableInSec`** — nothing was scheduled to turn
it back on, so the filter stayed off until `enable` was called by hand. Blocky's
documentation says only *"If empty, disable all groups"*; that it is also
indefinite is the part that had to be measured.

A scoped disable behaves differently, and correctly:

```
$ curl -s "$API/blocking/disable?groups=unit-alpha&duration=30s"; curl -s "$API/blocking/status"
{"autoEnableInSec":29,"disabledGroups":["unit-alpha"],"enabled":false}
```

**Consequence in the crate.** `DisableGroups` cannot be constructed empty, and no
function maps an allowance onto a disable. An allowance is a list entry plus
`POST /api/lists/refresh`, and `blocking/status` reads `enabled: true` for the
whole life of one — asserted by `granting_a_domain_never_turns_the_filter_off`.

### 2.2 An unknown group is refused, and changes nothing

```
$ curl -s -o /dev/null -w '%{http_code}' "$API/blocking/disable?groups=no-such-group"
400
$ curl -s "$API/blocking/status"
{"enabled":true}
```

Fail-closed on a name it does not know. The adapter surfaces this as a capability
gap rather than treating a `400` as "done".

### 2.3 List groups do not isolate; client identities do

This one contradicts the natural reading of the configuration format, and it is
the finding the whole topology design rests on.

`blocking.allowlists` is documented as *"entries here take precedence over
denylists in the same group"*. With **one client subscribed to two groups**, that
precedence turned out not to be confined to the group:

| Setup | `both.example.org` denied by | allowed in | Result for that client |
|---|---|---|---|
| one client in `unit-alpha` + `unit-beta` | `unit-alpha` | `unit-beta` | **not blocked** — `failed to resolve allowlisted domain both.example.org` |

An allowance granted to one unit released a name the *other* unit denied. Two
units sharing a client share each other's allowances.

Binding each client to exactly one group fixes it. Measured with real DNS queries
from two source addresses (`harness/dns-probe.py`, because `POST /api/query`
always resolves as a single client and so cannot show this):

```
--- baseline: both.example.org is denied by both units ---
both.example.org         from 127.0.0.1    -> BLOCKED(0.0.0.0)
both.example.org         from 127.0.0.2    -> BLOCKED(0.0.0.0)
--- allow both.example.org in unit-beta only ---
both.example.org         from 127.0.0.1    -> BLOCKED(0.0.0.0)
both.example.org         from 127.0.0.2    -> NOT_BLOCKED(rcode=2)
```

`127.0.0.1` is bound to `unit-alpha`, `127.0.0.2` to `unit-beta`. Beta's
allowance released the name for beta's client and left alpha's client blocked. No
leak.

**Consequence in the crate.** `Topology::audit` refuses any arrangement binding
one client to more than one unit, and `client_groups_block` will not render such
a config. The leaky arrangement compiles, starts, and serves traffic without
complaint, so a type-level refusal is the only thing that catches it.

### 2.4 A client in no group is unfiltered

A client matched by no `clientGroupsBlock` entry is filtered by no group.
Fail-open, and there is no safe default to choose on a caller's behalf — hence
`Unmatched::Unfiltered` versus `Unmatched::FallBackTo`, so the choice is recorded
where a reviewer sees it.

### 2.5 An admitted name is not a healthy resolver, and not a broken one

A name the filter *admits* is forwarded upstream. With the harness's deliberately
dead upstream, `POST /api/query` answers `HTTP 500`:

```
query failed for 'both.example.org' (type A): query resolution failed:
failed to resolve allowlisted domain both.example.org: upstream ... connection refused
```

The first implementation read that as "DNS enforcement is unavailable", which was
wrong twice: the filter ran, and it let the name through. `Resolution` now keeps
the filter verdict and the resolution outcome apart, and
`admitted_but_unresolved` requires both prose markers so an unrelated `500` stays
a capability gap. The classification reads error prose because the API offers no
structured signal — pinned to `v0.35.0` and covered by the protocol tests, which
is what would catch the wording changing.

### 2.6 `customDNS` resolves before blocking

An early fixture put its test names in `customDNS.mapping` and saw nothing
blocked at all: `customDNS` answers ahead of the filter, so those names never
reached it. This invalidated a first reading of §2.3, which was re-measured
without `customDNS`. Recorded because it is an easy way to build a filter test
that proves nothing.

Correspondingly, only `responseType == "BLOCKED"` counts as a block.
`CUSTOMDNS`, `SPECIAL` (a special-use domain such as anything under `.test`),
`FILTERED` and `NOTFQDN` are not the denylist doing anything, and reading them as
blocks would report a filter working when it had not run.

## 3. Coverage — the DNS-TRUTH statement

DNS filtering answers exactly one question: **when this client asks this resolver
for this name, does it get an address.**

### 3.1 Claims this mechanism supports

| Claim | Enforced by |
|---|---|
| `domain_resolution_blocked` | The recursive resolver the client is configured to use |
| `time_boxed_domain_allowance` | The same, plus whoever reconciles the lists (§4) |
| `per_unit_isolation` | The same, given the client binding of §2.3 |

Each arrives from `Coverage::attest` with the gaps below attached. There is no
way to obtain an attestation without them, because the caveats are what gets
dropped when a screen gets built.

### 3.2 Gaps that apply to every one of those claims

None of these are hypotheticals to be closed by a better adapter. Each is outside
what a recursive resolver can observe, so each survives any amount of work on
this crate.

- **`ip_literal`** — the subject connects to an address; no lookup happens.
- **`foreign_resolver`** — the subject asks a different resolver, configured,
  hardcoded, or handed out by DHCP on another network.
- **`encrypted_dns_elsewhere`** — DNS-over-HTTPS or DNS-over-TLS to somewhere
  else, which this resolver cannot see and a browser may prefer by default.
- **`vpn_or_proxy`** — a tunnel carries the query and the traffic past it.
- **`cached_answer`** — the answer is already in the subject's cache, so no query
  is made and a revoked allowance keeps working until the record's TTL runs out.
- **`non_dns_transport`** — peer-to-peer, mesh, relay.
- **`time_spent_unobserved`** — a resolver sees a lookup, not a session.

### 3.3 Claims this mechanism refuses

`Coverage::attest` refuses these outright rather than approximating them. Each
refusal carries its mechanical reason, so it can be shown to a person instead of
being a boolean.

| Refused claim | Because |
|---|---|
| `network_egress_blocked` | A resolver withholds a name; it is not on the path to the socket, and an address obtained any other way still connects. |
| `screen_time` | A resolver observes a lookup, not a session; it sees nothing at all once the answer is cached, and cannot distinguish four hours of use from none. |
| `application_usage_limited` | A resolver cannot attribute a query to an application, nor measure how long that application ran. |
| `in_app_content_filtered` | A resolver decides whole names; it cannot see inside a connection it never carried. |
| `device_supervised` | A resolver is not a device authority: it cannot tell that it was replaced, bypassed, or that the device left the network. |

**On screen time specifically.** This is not an overstatement of the mechanism,
it is a different subject. A device can sit on a filtered network all day, and a
device can be handed back after four hours of a cached video stream; DNS tells
those apart not at all. No surface built on this crate may describe it as screen
time, usage limits, or time enforcement.

## 4. Expiry — who holds the deadline

Blocky has exactly one autonomous timer: the whole-group disable of §2.1, which
this crate refuses to use for an allowance. So **nothing in the resolver expires a
list entry.** An allowance ends when something rewrites the list and calls
`lists/refresh`.

`ExpiryHolder` puts that in the type system: allowances are
`ExpiryHolder::ListReconciler`, whose `survives_our_absence()` is `false`. A
caller needing an unattended deadline is told no rather than handed one that
depends on a process staying up.

The crate runs no timer. `reconcile` is a pure function of the allowances and a
clock reading the caller supplies, and `ReconciledLists::is_settled` reports the
window between an allowance lapsing in the record and the resolver being brought
into step. `MAX_ALLOWANCE_SECONDS` is 24h — a forcing function, not a safety
property: an allowance that outlives its reason is indistinguishable from a
permanent hole.

### Open coordination item — lifecycle wiring

`INV-GA-05` requires an expiry to be detected by the lifecycle scanner and
published on `lifecycle.*`, with no private due-check. This crate holds up its
end by running no scheduler at all, but it is **not yet wired to the feed**:
`lifecycle::SubjectKind` is a closed enum (`ALL: [Self; 7]`) in a crate ADR 0074
describes as frozen vocabulary, and a DNS allowance has no variant there.

Adding one is GA-H's call, not this swarm's, so per the escalation rule in
`docs/implementation/general-authority/ownership.md` it is recorded here and left
undone rather than decided locally. Until then, allowance expiry depends on
whatever the caller drives, and that is the honest description of it.

## 5. Test inventory

| Suite | Count | Needs Blocky |
|---|---|---|
| `cargo test -p opensesame-dns-enforcement --lib` | 51 | no |
| `--test blocky_protocol` | 6 | 5 of 6 |

`a_bare_disable_is_unconstructible` runs either way, because the guarantee it
checks is structural rather than behavioural.

### Behaviour when Blocky is absent

Verified in both directions, because "do not fake success" is the requirement
these paths exist for:

- **Not configured** (`OPENSESAME_BLOCKY_API` unset) — each behavioural test
  prints `SKIP … This is missing coverage, not a passing protocol check.` and
  returns. Nothing is mocked in its place.
- **Configured but absent** (instance stopped, env still set) — all 5 behavioural
  tests fail loudly; `1 passed; 5 failed`. Every failure is a
  `Refusal::CapabilityUnavailable`, and `Refusal::is_capability_gap()` is `true`
  for each, so a caller can tell "we did not look" from "we looked and said no".

`transport::tests::an_absent_instance_is_a_capability_gap_never_an_answer` pins
the same property without any harness at all: against a dead port, `status`,
`preflight`, `resolve` and `refresh_lists` each return a capability gap, and none
returns "not blocked".

## 6. Gates run

```bash
cargo +1.88.0 test -p opensesame-dns-enforcement -- --test-threads=1   # 51 + 6 pass
cargo +1.88.0 clippy -p opensesame-dns-enforcement --all-targets --all-features \
  -- -D warnings -D clippy::pedantic -D clippy::complexity                # clean
cargo +1.88.0 fmt -p opensesame-dns-enforcement -- --check                # clean
```

Largest source file is 338 lines, within ADR 0093's 400-line budget, so every
file in the crate has a recorded baseline of zero and meets the budget outright.
