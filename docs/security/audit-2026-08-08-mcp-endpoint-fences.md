# Audit tick 52 — MCP servers aimed by their environment

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

An MCP server's environment is routinely supplied by whatever project the agent has
open, so an unchecked base URL is a way to aim a local secret at a remote listener.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `mcp-host` took `OPENSESAME_SERVER` / `OPENSESAME_HOST_API` / `OPENSESAME_DAEMON_URL` verbatim and attached `Bearer operator:<token>` to whatever they named. A base URL pointing anywhere sent the local operator secret — the credential that authorizes device approval, claim completion and L1 invoke — to that host in cleartext. | Base URLs are normalized and refused unless https or loopback; embedded credentials are rejected. The operator bearer is offered only to a loopback target, and the daemon must be loopback outright. |
| Medium | `mcp-client` took `OPENSESAME_HOST_API` and `OPENSESAME_ISSUER` verbatim while sending the session bearer on every call, so plain `http://` to a remote host leaked the session to the network. | Both are validated at startup with a shared `normalizeHttpBaseUrl` (https anywhere, http only on loopback), failing before the first call rather than on it. |
| Medium | `daemonFetch` sent no `Authorization` at all, but every daemon `/v1/*` route requires the operator bearer, so `operator_invoke_l1` and `daemon_status` could only ever answer 401 — the fenced frozen-intent path from tick 43 was unreachable from MCP. | The daemon bearer is attached (loopback-enforced), making the tool work as documented. |

## Notes

- `normalizeLoopbackBaseUrl` only accepted `127.0.0.1`; it now covers all of
  127.0.0.0/8, which the loopback interface actually answers for.
- A remote Host API is still supported — it just has to be https and is reached with
  a session bearer, never the operator secret.

## Verification

- `pnpm --filter @opensesame/mcp-host test` — 8 passed (3 new: base refusal, operator
  token withheld from remote, daemon auth + loopback)
- `pnpm --filter @opensesame/api-client test` — 8 passed (1 new)
- `pnpm run typecheck`, `pnpm test` — clean
- semgrep, gitleaks, cargo-audit, cargo-deny, osv-scanner, cve-lite, ast-grep — clean
