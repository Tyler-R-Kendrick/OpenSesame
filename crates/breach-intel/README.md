# opensesame-breach-intel

Value-blind breach-exposure detection for the Host / authority plane. A stored
secret that has turned up in a public dump, or a provider that has announced a
breach, is detected once and published once as a `breach.*` event on the same
security-event feed that carries `lifecycle.*`. The crate does no I/O: the
gateway fetches, this crate builds the queries, matches the responses and
decides what to publish.

```text
secret  →  PwnedDigest  →  prefix (5 hex chars leave the host)
                        →  range::occurrences (matched locally)
                        →  BreachEvent  →  SecurityNotice
domain  →  catalogue::matches (fetched whole, matched locally)
                        →  BreachEvent  →  SecurityNotice
```

## Where it fits

- **Used by:** [`apps/gateway`](../../apps/gateway) — `src/breach/`
  (scanner, sources, subjects) and the `security` and `lifecycle` routes.
- **Builds on:** [`opensesame-security-events`](../security-events) —
  `BreachEvent` converts into a `SecurityNotice` and inherits that feed's
  subscriptions and sinks.
- The source learns nothing about the tenant. Passwords go through the Pwned
  Passwords range API's k-anonymity (five hex characters of a SHA-1). The
  breach catalogue is fetched whole and matched locally. The breached-account
  API is deliberately unused.
- A subscriber learns nothing about the value. `BreachSubject` has no field
  able to carry one, and `BreachEvent::payload` is built key by key.
- The source set is closed (`BreachSource::HibpPasswords`, `HibpBreaches`): a
  source is a trust decision, not configuration.

## Surface

| Module | Main items |
|---|---|
| `digest` | `PwnedDigest` (zeroized), `PREFIX_CHARS` = 5, `SUFFIX_CHARS`, `DIGEST_CHARS` |
| `range` | `range_url`, `occurrences`, `occurrences_for_suffix`, `RANGE_URL_BASE`, `PADDING_HEADER` / `PADDING_VALUE` (padding is requested; a zero count is a decoy) |
| `catalogue` | `CATALOGUE_URL`, `parse_catalogue`, `matches`, `domain_matches`, `Breach` |
| `event` | Frozen names `breach.password.compromised`, `breach.provider.disclosed`, `breach.finding.cleared`, `breach.scan.failed`; `BREACH_EVENT_TYPES`, `EVENT_WILDCARD`, `BreachEvent` |
| `source` | `BreachSource` |
| `subject` | `BreachSubject`, `BreachSubjectKind` (`StorePath`, `ConnectionCredential`, `Domain`, `Source`) |

## Develop

```bash
cargo +1.88.0 test -p opensesame-breach-intel
```

Event names are additive only and pinned by a unit test. A test in `subject`
(`subject_fields_carry_no_secret_shaped_names`) fences the subject's field
names.

## Related

- [ADR 0080](../../docs/adr/0080-security-event-hooks.md) §5 — security-event
  hooks and the breach-check disclosure rules
- [ADR 0074](../../docs/adr/0074-expiry-lifecycle-hooks.md) — the lifecycle feed
  this mirrors
