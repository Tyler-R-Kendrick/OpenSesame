# ADR 0080 — One security-event feed, with built-in notification and alerting

- Status: Accepted
- Date: 2026-08-31
- Supersedes: nothing. Generalizes [ADR 0074](0074-expiry-lifecycle-hooks.md).

## Context

ADR 0074 established a rule worth keeping: a deadline is a fact the platform
detects **once** and publishes **once**, on a feed anyone can subscribe to, and
`OpenSesame`'s own rotation consumes that feed rather than a private trigger. If
the feed breaks, our rotations break with it, which is the only reliable way to
keep a published event contract honest.

That rule was written for expiry. It generalizes, and it needs to, because
expiry is not the only security fact the platform can detect about the secrets
it holds. A stored password that has appeared in a public breach corpus, and a
provider that has announced a breach, are the same *kind* of fact: something an
operator has to act on, discovered by the platform, about a specific subject.

Three things were missing:

1. **A second detector had nowhere to publish.** Everything about who receives
   an event and how lived in `apps/gateway/src/lifecycle/`, keyed to
   `LifecycleEvent`. Adding breach detection meant either teaching that module
   about breaches or standing up a parallel copy. The second option is how the
   new detector ends up with no alerting, which is exactly the failure ADR 0074
   was written to prevent.
2. **The feed had no default subscriber.** A newly deployed gateway published
   events to nobody until an operator registered a webhook. An expiry notice
   with no subscriber is a missed renewal; a breach finding with no subscriber
   is a live credential in a public dump that nobody hears about.
3. **Delivery spoke one dialect.** Standard Webhooks is the right choice for a
   subscriber writing their own integration, and the wrong one for an operator
   who already runs Alertmanager and `PagerDuty` and simply wants the page.

## Decision

### 1. One envelope, one feed

`crates/security-events` defines `SecurityNotice` — the normalized, value-blind
shape every security fact becomes: who it is about, how loud it is, whether it
is firing or resolving, one line a human reads, and the detector's own payload
carried through.

`apps/gateway/src/security/dispatch.rs` publishes a notice to the `TaskBus`,
to every matching subscription, and to the built-in subscribers. It names no
event family. Expiry (`crate::lifecycle`) and breach exposure (`crate::breach`)
both publish through it, and neither knows the other exists.

A new detector implements a conversion into `SecurityNotice` and inherits the
subscription model, the delivery ledger, the notifier, the alerter, and every
sink. It does not get a private notification path.

### 2. Severity, and firing versus resolving

A notice carries a `Severity` (`info`/`warning`/`error`/`critical`) and a state.
Both are new, and both exist because alerting without them is unusable:

- **Severity** is what lets a paging integration subscribe to everything loud
  without also subscribing to every 30-day expiry notice. Subscriptions carry a
  `severity_min` floor. The ladder is `PagerDuty`'s own vocabulary so no sink
  has to collapse it and quietly disagree with another.
- **State** is what closes a page. A notice carries a per-subject `alert_key`,
  so `lifecycle.renewal.succeeded` resolves the alert
  `lifecycle.expiry.urgent` opened, and `breach.finding.cleared` resolves the
  one `breach.password.compromised` opened. Without this an on-call rotation
  accumulates pages for problems that were fixed hours ago and learns to ignore
  the feed.

An automated renewal coming due is only a `Warning`, even though it is the
actionable rung: the platform's own responder is about to handle it, and paging
a human for that is how alert fatigue starts. Its *failure* is an `Error`.

### 3. Two subscribers that are always there

Every organization is seeded with two `internal` subscription rows:

- **`notify`** — every event, every severity, written as an RFC 5424 line to the
  host's log stream, where journald, rsyslog, and any SIEM that ingests syslog
  pick it up with no adapter. It needs no endpoint, no secret, and no network,
  so on the day a gateway is first deployed a compromised credential still lands
  somewhere a human can find it.
- **`alert`** — events at `Warning` and above. It records that the event was
  alert-worthy and which sinks it was routed to, and when an organization has
  **no** alerting sink configured it says so, at `error`, once per event. An
  alerting system that is quiet because nothing is wrong and one that is quiet
  because it is unplugged look identical from the outside; this is the
  difference.

They are ordinary rows, not hidden code paths, so they appear in the same list
as every other subscription and an operator can disable them. They are seeded
by insert only — a row somebody deliberately disabled is never revived.

The guarantee does not depend on seeding having run, though. When a row for a
built-in exists it is honoured exactly, disabled included; when none exists its
default definition applies. Otherwise an event published from a route on a
freshly started gateway — before either scanner's first tick — would reach no
notifier at all, and a `critical` finding landing nowhere is the silence this
whole subsystem exists to prevent. Turning one off is `enabled: false`.

The alerter deliberately sends nothing itself. Alertmanager and `PagerDuty` are
ordinary hook rows on the same retry ledger as every other outbound delivery, so
an alert that cannot be delivered right now is retried and dead-lettered
visibly. Two code paths to one sink is how one of them ends up untested.

### 4. The sinks operators already run

`delivery` widens from `webhook`/`internal` to add:

- **`alertmanager`** — Prometheus Alertmanager v2, `POST /api/v2/alerts`. The
  operator's existing routing tree, silences, and inhibition rules apply to our
  events with nothing to configure on our side. Resolution is by an `endsAt` in
  the past.
- **`pagerduty`** — Events API v2 `enqueue`, with our alert key as `dedup_key`
  so one subject is one incident and a resolve closes it.

There is deliberately **no `syslog` delivery kind**. RFC 5424 is a line format,
not a transport worth inventing egress for: shipping one over plaintext TCP to
an arbitrary host would put credential metadata on the wire in the clear, and
the collectors that want syslog already read the host's log stream. So the
notifier emits RFC 5424 *locally* and every outbound sink is HTTPS, sharing one
egress fence and one ledger.

### 5. Breach detection that tells the source nothing

`crates/breach-intel` is the first new detector. Two checks, chosen because
neither requires disclosing anything about a tenant:

- **Passwords** use the Pwned Passwords range API's k-anonymity: the value is
  hashed with SHA-1, **five hexadecimal characters** of that hash are sent, the
  response is padded on request, and the match happens on the host. The service
  learns that somebody asked about one bucket in 2²⁰ and never which member.
- **Providers** fetch the public breach catalogue **whole** and match watched
  domains locally. The request carries nothing at all. Watched domains come from
  each connection's egress authorities, so a connection added last week is
  covered this pass without anyone maintaining a list.

**The breached-account API is deliberately not used.** It answers "has *this
address* been breached" and therefore requires sending the address. `OpenSesame`
holds accounts on behalf of other people; disclosing which addresses a tenant
manages, to anyone, is not ours to do for a convenience. Catalogue matching
gives the operationally useful half — *your provider was breached, go rotate* —
and discloses nothing.

### 6. Periodic, and at the moment it matters

Provider disclosure is scanned on a six-hour tick. The catalogue is published,
not streamed, and gains entries on the order of days; a tighter loop adds no
coverage and makes us an unusually rude client of somebody else's free service.

Password checking is exposed as `POST /api/v1/security/breach-check`, which is
the only route in the product that accepts a secret value. It exists because
NIST SP 800-63B asks that a chosen password be checked against breached corpora
**at the moment it is set** — the check that prevents the exposure rather than
reporting it afterwards. The value is hashed, five characters leave, and it is
never stored, logged, or returned. A match publishes
`breach.password.compromised` against the named subject; a clean result clears
any open finding, which resolves the alert an earlier check opened, making the
route the confirmation step after rotating an exposed secret.

The scanner deliberately does **not** open sealed credentials at rest on a
timer. That would materially widen what the gateway does with secret material,
on a schedule, unattended, and it is not required to get the value: the check
that matters happens where a plaintext is legitimately in hand already.

### 7. A failed scan is an event

`breach.scan.failed` is published — per tenant, on the feed — when a corpus
cannot be consulted. An unreachable source and a clean source produce identical
silence otherwise, and silently downgrading "we could not check" to "nothing
found" is the single outcome this whole subsystem exists to prevent.

## Consequences

- **Migration 0020 rebuilds two tables.** `lifecycle_hooks` and
  `lifecycle_deliveries` become `security_hooks` and `security_deliveries`,
  with the widened `delivery` check and the new `severity_min`. SQLite cannot
  alter a `CHECK`, so a rebuild was required regardless; doing it under names
  that describe what the tables now carry was the cheap part. Rows carry over
  with `severity_min = 'info'`, which admits everything — exactly their previous
  behaviour. `lifecycle_watermarks` keeps its name: a ladder watermark really is
  specific to a deadline.
- **The seal scope string does not change.** `SECURITY_HOOK_SECRET_SCOPE` is
  still `"lifecycle_hook_secret"`. A scope is bound into the AAD of every blob
  sealed under it; renaming the value would make every secret registered before
  this change permanently unopenable.
- **`/api/v1/lifecycle/*` paths stay.** They are a published contract with
  registered subscribers behind them. `/api/v1/security/hooks` and
  `/api/v1/security/deliveries` serve the same table under the name that now
  describes it, and breaking a working URL to tidy it would be a poor trade.
- **The webhook body grew, additively.** A subscriber written against the expiry
  feed keeps working unchanged: the detector's payload is still at the top
  level, with `severity`, `state`, `summary`, and `alert_key` added beside it.
- **`breach_findings` records state, not a high-water mark.** An expiry rung is
  monotonic; a breach finding can become false again when a secret is rotated or
  a source withdraws an entry, and that transition is itself an event. No column
  can hold a value, and there is deliberately no column for a hash or a hash
  prefix: a stored SHA-1 of a password is a crackable artifact, and keeping one
  to save a re-check next pass would be a bad trade for a system whose whole
  claim is that it does not hold recoverable copies of what it protects.
- **Deliveries queued before the migration still deliver.** Rows written by the
  previous version hold a detector's flat payload, not the envelope, and
  decoding one as an envelope fails permanently — so without a distinction the
  upgrade would dead-letter exactly the notifications somebody was already
  waiting on. A legacy row is delivered byte for byte as it was written, and is
  only ever a webhook, because the alerting sinks did not exist before the
  migration that produced it.
- **The alert key is bounded to 255 characters.** `PagerDuty` rejects a longer
  `dedup_key` with a 400, which the delivery worker reads as permanent; a
  subject id alone is allowed to be 256. Over the cap the key is truncated with
  a digest of the whole key appended, so two long subjects sharing a prefix stay
  two incidents rather than merging into one page nobody reads twice.
- **Syslog output neutralizes control characters.** Labels are operator-supplied
  names — a certificate common name, a store path — and every transport that
  carries these lines is line-oriented, so a newline in one would end the record
  early and let what follows be read as a second, forged log line.
- **A built-in subscriber cannot be rewritten over the API.** `internal` rows
  cannot be created through it, so they must not be overwritable through it
  either: seeding only ever inserts, so a row rewritten into a webhook would
  never be restored. Turning one off is `enabled: false`.
- **`security.breach_check.run` is excluded from every agent surface.** It is
  the one capability that carries a secret value, and an agent surface must
  never be the thing that carries one — even to have it vetted.
