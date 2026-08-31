# Security alerting

Every security fact `OpenSesame` detects — a certificate about to expire, a
credential due for rotation, a stored password found in a public breach corpus,
a provider that announced a breach, an agent that got stuck changing somebody's
password at 04:00 — is published on one feed, with one subscription model. This
page is how you point that feed at whatever your team already watches.

Design rationale is in [ADR 0080](../adr/0080-security-event-hooks.md); the
expiry half is [ADR 0074](../adr/0074-expiry-lifecycle-hooks.md), and the agent
half is [ADR 0081](../adr/0081-live-session-observation.md).

## The families

| Family | Detects | Subject kinds |
|--------|---------|---------------|
| `lifecycle.*` | deadlines: certificates, CAs, brokered credentials, store paths, signers, web logins, session grants | every kind |
| `breach.*` | a stored password in a public corpus; a provider that announced an incident; a corpus that could not be consulted | `store_path`, `connection_credential`, `source` |
| `agent.*` | a sandboxed run rotating a web login: started, blocked, waiting for you, control taken and handed back, resumed, completed, failed | `web_login` |

`agent.*` is the only family that names a *person* — the run's owner — which is
what makes it the only one an A2H subscription can carry.

Subscribe by exact name, by family wildcard (`agent.*`), or by `*` for
everything the platform detects, now and later. `GET /api/v1/lifecycle/expiring`
advertises the full vocabulary; anything it lists is registrable.

An `agent.*` subscription is metadata about a run — an origin, a phase, a
reason it stopped. It is never the run's observation log: what the agent saw is
sealed to the credential owner's viewer key and the gateway cannot read it, let
alone forward it to your pager (ADR 0081 §9).

## What you get without configuring anything

Two subscribers are seeded per organization and need no endpoint, no secret,
and no network:

| Responder | Fires on | What it does |
|-----------|----------|--------------|
| `notify`  | every event | Writes an RFC 5424 line to the gateway's log stream under the `opensesame::security` target |
| `alert`   | `warning` and above | Records that the event was alert-worthy and which sinks it went to — or, if you have none, says so at `error` |

So a freshly deployed gateway already lands a compromised credential somewhere
a human can find it. If you ship the gateway's logs anywhere, you are already
collecting security events; `authpriv` is the facility, so most default syslog
configurations route them somewhere more restricted than application logs.

Both are ordinary subscription rows. They show up in `opensesame security` /
`opensesame lifecycle hooks` alongside everything else, and you can disable
either one — re-seeding never revives something you deliberately turned off.

Turning one off means `enabled: false`, not deleting it and not rewriting it:
a deleted row is re-seeded on the next pass, and a `PUT` carrying a built-in's
id is refused, because seeding only ever inserts and a rewritten row would
never be restored.

Set `OPENSESAME_HOSTNAME` to control the `HOSTNAME` field on those lines (in a
container the kernel's idea of it is a random hex string), and
`OPENSESAME_SYSLOG_ENTERPRISE_NUMBER` if you have a registered IANA enterprise
number; the default is 32473, which IANA reserves for examples.

## Routing to your own alerting

Register a subscription per sink. Owner/admin session or the operator token.

### Prometheus Alertmanager

```bash
curl -sS -X PUT http://127.0.0.1:8787/api/v1/security/hooks \
  -H "authorization: Bearer $OPENSESAME_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name": "alertmanager",
    "event_types": ["*"],
    "delivery": "alertmanager",
    "endpoint_url": "https://alertmanager.internal.example/api/v2/alerts",
    "severity_min": "warning"
  }'
```

Alerts arrive with `alertname` set to the event type and labels for
`severity`, `subject_kind`, `subject_id`, `organization`, and `alert_key`, so
your existing routing tree, silences, and inhibition rules apply with nothing
to change on our side. Alertmanager's ingest API is unauthenticated by design;
if you front it with a proxy, pass a `secret` and it is sent as a bearer token.

### PagerDuty

```bash
curl -sS -X PUT http://127.0.0.1:8787/api/v1/security/hooks \
  -H "authorization: Bearer $OPENSESAME_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name": "oncall",
    "event_types": ["*"],
    "delivery": "pagerduty",
    "endpoint_url": "https://events.pagerduty.com/v2/enqueue",
    "severity_min": "error",
    "secret": "<integration routing key>"
  }'
```

`secret` is the Events API v2 routing key. It is sealed at rest and returned
exactly once, in the registration response — losing it means re-registering,
not recovering it.

### A person's phone, over A2H

The one sink whose audience is a human rather than an on-call system. `OpenSesame`
is an A2H v1.0 *client*: it hands an intent to whichever gateway you configure —
Twilio's, or a self-hosted one — and that gateway owns channel selection,
failover, quiet hours and evidence collection. `endpoint_url` is the gateway's
base URL; intents go to `/v1/intent` under it.

```bash
curl -sX PUT "$HOST/api/v1/lifecycle/hooks" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "name": "on-call phone",
    "delivery": "a2h",
    "endpoint_url": "https://a2h.example",
    "event_types": ["agent.*"],
    "secret": "whsec_..."
  }'
```

Three things differ from the other sinks:

- **It must name at least one `agent.*` event.** Only an agent run carries the
  principal to reach; a lifecycle or breach notice names a certificate or a
  store path, not a person. A subscription that could never render an intent is
  refused at registration rather than dead-lettering rows at 04:00.
- **Its severity floor defaults to `error`,** not `info`. Registering a phone
  should not sign somebody up for a text every time an agent takes a page. Pass
  `"severity_min": "info"` if you do want the quiet phases.
- **The secret runs both ways.** Every other sink is fire-and-forget; an A2H
  gateway posts the person's reply back to `/api/v1/a2h/callback`, and the
  `whsec_` secret verifying `X-A2H-Signature` is the only thing separating that
  from a stranger claiming somebody answered.

A reply may only *narrow* what is happening: acknowledge, or cancel the run. It
can never grant the control lease or resume autonomy, at any assurance level —
taking the page needs the viewer key the observation log is sealed to, and
resuming needs the run's preconditions re-asserted against the live page. A
phone has neither.

`ERR.QUIET_HOURS` and `ERR.RATE_LIMITED` are **not** delivery. A gateway that
suppressed a message has told nobody, so the row stays in the ledger and is
retried rather than being recorded as sent — otherwise a blocked run's response
window expires with the person it was waiting for never hearing about it.

### Your own service

`"delivery": "webhook"` (the default) sends a Standard Webhooks POST and mints
a `whsec_` signing secret, returned once. Verify with any off-the-shelf
Standard Webhooks library; `webhook-id` doubles as your idempotency key, which
matters because the ledger is at-least-once.

## Severity, and why pages close

| Severity | Examples |
|----------|----------|
| `info` | expiry within 30 days; a renewal that succeeded; a finding that cleared; an agent run starting, resuming, finishing, or handed to you |
| `warning` | expiry within 7 days; a renewal coming due; a corpus that could not be reached; a run parked with a person nominally in the loop |
| `error` | expiry within 24 hours; a renewal that failed; a provider breach that exposed passwords; a run blocked or failed |
| `critical` | something already expired; a stored secret found in the password corpus |

`severity_min` is a floor, so a paging integration can take everything loud
without also taking every 30-day notice. A renewal *coming due* is only a
warning — our own responder is about to handle it; its *failure* is an error.

Events carry a per-subject alert key, and resolutions carry it too. A
successful renewal closes the page its approaching deadline opened, a cleared
breach finding closes the one the finding opened, and somebody taking the page
from a stuck agent closes the one that asked them to. You should not have to
manually resolve anything `OpenSesame` fixed itself.

**The floor applies to problems, not to their endings.** A resolution reaches
every subscription whose event filter and subject kinds select it, whatever its
`severity_min` — otherwise a `critical`-floor pager would take the fire and
never the `info`-severity clear, and the incident would sit open until somebody
closed it by hand. A resolution for an alert your sink never opened is a no-op
at both Alertmanager and `PagerDuty`; a resolution that never arrives is a page
your on-call learns to ignore.

## Breach scanning

Provider disclosure is scanned every six hours
(`OPENSESAME_BREACH_TICK_SECONDS`, minimum 60). Watched domains come from the
hosts your connections are bound to reach, so a connection added last week is
covered on the next pass with no list to maintain.

```bash
opensesame security findings        # what is exposed, and what has cleared
opensesame security scan            # run a pass now
opensesame security check Dev/api-token   # vet a candidate before storing it
```

`security check` reads the secret from a no-echo prompt or standard input —
never an argument, which would land in shell history and in `ps`. It composes
with a password manager:

```bash
pass show personal/new-token | opensesame security check Dev/api-token
```

### What leaves your host

Nothing that identifies you.

- **Passwords** use the Pwned Passwords range API's k-anonymity: the value is
  hashed with SHA-1, **five hexadecimal characters** of that hash are sent, the
  response is padded on request, and the match happens locally. The service
  learns that somebody asked about one bucket in a million.
- **Provider disclosure** fetches the public breach catalogue whole and matches
  locally. The request carries nothing at all.
- The **breached-account API is deliberately not used.** It would require
  sending the addresses you manage, which are not ours to disclose.

A corpus that cannot be reached publishes `breach.scan.failed` rather than
reporting a clean result. If you see nothing from breach scanning, check for
that event before concluding you are clear.

## When something is not arriving

```bash
opensesame lifecycle deliveries   # attempts, backoff, last error, dead letters
```

The ledger is the source of truth; the bus only accelerates. A delivery retries
with exponential backoff and dead-letters visibly rather than disappearing.
Endpoints must be absolute `https://` and are refused if they resolve to a
loopback, private, link-local, or metadata address — checked again at send
time, not only at registration.

If your logs show `security alert has no configured route`, the alerter fired
and had nowhere to send it. Register a sink above.
