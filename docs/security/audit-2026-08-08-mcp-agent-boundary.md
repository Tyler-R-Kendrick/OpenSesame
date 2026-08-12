# Audit 2026-08-08 — what the MCP host hands back to the model

Date: 2026-08-08
Scanners: cve-lite, osv-scanner, cargo-audit, cargo-deny, gitleaks, semgrep,
ast-grep, clippy, task-security-battle-test — all clean. This came from reading
`apps/mcp-host`.

## Finding

| Severity | Finding | Fix |
| --- | --- | --- |
| High | Every tool relayed the Host API or daemon response body to the model verbatim (`textContent(JSON.stringify(body))`). This process is the one holding `OPENSESAME_OPERATOR_TOKEN`, so anything upstream that echoed what it received — a 401 quoting the Authorization header, a validation error printing the request, a debug field — put the machine's operator secret into the model's context. A model that reads that token no longer needs the tools; it can call the daemon directly. | New `forAgent` fence on every relayed payload, plus `scrubLocalSecrets` on tool error text. |

The catalog check that already existed (`assertsNoSecretTools`) covers tool *names*.
Nothing covered tool *output*, even though the Rust host enforces exactly that at
the same boundary with `assert_no_secret_in_agent_payload`.

## What the fence does

Two different jobs, in this order:

- **Secrets this process holds are scrubbed by value.** No pattern guessing and no
  false positives: `OPENSESAME_OPERATOR_TOKEN`, `OPENSESAME_ACCESS_TOKEN` (with and
  without its `opaque-session:` prefix, since `hostAuthHeaders` accepts either) and
  `OPENSESAME_CLAIM_PEPPER` are replaced with `[REDACTED]` wherever they appear.
  Values under 8 characters are ignored — a two-character "secret" would scrub half
  the payload for no gain.
- **Payloads still carrying credential shape are refused.** `secret://`,
  `bearer operator:`, `client_secret`, `refresh_token`, `access_token`,
  `private_key`, `-----BEGIN`, `ghp_` — the same list the Rust host uses, so both
  boundaries agree on what a secret looks like. Nothing these tools legitimately
  return contains one, so its presence means the response is not what we think it
  is, and the model gets a refusal rather than a redaction.

Scrubbing runs first deliberately. A body whose only offence was quoting our own
token is perfectly usable once the token is gone, and refusing it would turn a leak
into an outage.

## Not fixed here

- The fence sees text, not intent. A secret an upstream service invented a new name
  for is not on the marker list, and only the by-value scrub is exhaustive — for
  secrets this process happens to hold.
- `hostFetch` still concatenates a caller-supplied path onto the base URL. Every
  call site interpolates ids through `encodeURIComponent`, so nothing traverses
  today, but the helper does not enforce it.

## Verification

- `apps/mcp-host` — 13 passed (3 new: token echo scrubbed, credential-shaped
  payloads refused, echo preferred scrubbed over refused)
- `pnpm -r typecheck`, full workspace tests — green
- cve-lite, osv-scanner, cargo-audit, cargo-deny, gitleaks, semgrep, ast-grep,
  clippy, task-security-battle-test — clean
