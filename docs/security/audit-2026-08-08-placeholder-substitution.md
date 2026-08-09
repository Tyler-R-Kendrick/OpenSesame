# Audit tick 65 — placeholder substitution is bound to the placeholder that was issued

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny). Read
`crates/env-spec`, `crates/domain` placeholder placement, `crates/connector-host`
substitution, `apps/credential-agent`, `apps/callback-edge`.

Placeholder delivery is the mode that lets a legacy SDK hold a fake token while the
host swaps in the real credential at egress. The swap keys off the placeholder's text,
which makes the text itself the authorization: whatever string is named gets a secret
written behind it.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | Every legacy projection shared one placeholder. `resolve_for_delivery` shaped it with the constant suffix `"opensesame0"`, and `shaped_placeholder` returned a wildcard-free pattern verbatim. Two connections with the same pattern were indistinguishable at the swap. | Fresh 128-bit suffix per projection; a wildcard-free pattern also takes the suffix. |
| High | Substitution never checked that the placeholder belonged to the projection. Any caller-named string — a bare `"a"`, or a neighbour's placeholder — was substituted. | `LegacyProjection::accepts_placeholder`, checked first in `substitute_placeholder` (`HostError::PlaceholderMismatch`). Binds to the recorded issued placeholder when known, otherwise to pattern shape with a minimum fill. |
| Medium | `max_occurrences` counted request parts, not appearances. Substitution replaces every occurrence, so one allowed header carrying the placeholder ten times passed a bound of 1 and shipped ten copies of the credential. | Count occurrences. |
| Medium | `allowed_hit` was a single global flag, so an appearance in an allowed site excused an appearance in a denied one. | Every site the placeholder appears at must be allowed; the denied site is named in the error. |
| Medium | A named query location (`Query { name: Some(..) }`) allowed the placeholder anywhere in the query string — the guard read `name.is_none() \|\| q.contains(placeholder)`, whose second arm is always true there. | Count occurrences inside the named parameter's value and require they account for every appearance in the query. |
| Low | An empty placeholder passed every `contains` check, and `replace("", secret)` writes the secret between every character. | Rejected in both `assert_allowed` and `accepts_placeholder`. |

## Tests

- `crates/domain`: pattern acceptance and rejection, exact binding to a recorded
  placeholder, occurrence counting inside one header, a denied second site beside an
  allowed one, named-query scoping, empty placeholder.
- `crates/connector-host`: a foreign placeholder is refused, a repeated one trips the
  bound, and a same-shape neighbour is refused once the issued placeholder is recorded.
- `crates/env-spec`: two resolutions of one schema yield different placeholders, and
  each projection admits only its own.

## Not fixed

- ~~`HostRuntime::invoke_l2_placeholder` still takes `placeholder` and `material` from
  request parameters~~ — closed in `audit-2026-08-08-authority-bounds.md`: the host
  holds a projection and credential per connection reference, refuses a request that
  names `material`, refuses a placeholder other than the issued one, and refuses a
  connection it holds nothing for.
