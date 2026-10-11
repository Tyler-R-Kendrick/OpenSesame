# ADR 0186 — CLI app integration for plaintext reveal

- **Status:** Accepted
- **Date:** 2026-10-10
- **Supersedes:** environment-marker agent context checks on the CLI reveal gate (round-3 C1)
- **Uses:** [ADR 0139](0139-one-definition-every-target.md), [ADR 0157](0157-logs-and-events-carry-no-secrets.md)

## Context

The parity CLI (`opensesame-id` / `os`) and native `opensesame password-agent` can
print or inject vault plaintext when a person explicitly asks (`read --reveal`,
`env resolve`, sealed-store reveal) or when a child process receives resolved
references (`run`, `env run`). An earlier gate treated “agent context” environment
markers as a stand-in for human approval; that was brittle, spoofable from the
same shell, and unlike 1Password’s CLI ↔ app integration model.

## Decision

1. **One conformance spec** — `spec/conformance/cli-app-integration.json` defines
   idle timeout (600 s, 1Password-style), daemon routes, UX copy, and session
   vectors for approve, deny, expiry, and per-terminal scoping.
2. **Terminal session id** — derived from `OPENSESAME_CLI_TERMINAL_SESSION_ID` when
   set, otherwise a hash of `OPENSESAME_CLI_TTY` and `OPENSESAME_CLI_SHELL_PID`
   (shell parent), matching the “this terminal tab” mental model.
3. **Daemon holds state** — `POST /v1/cli/app-integration/ensure` blocks until
   approved, denied, or timeout; `GET …/pending` and `POST …/respond` let the
   OpenSesame app (Pages) approve with PIN or passkey. Loopback only; no operator
   token on these routes.
4. **Two-layer gate** — `cli-reveal-gate.json` keeps TTY, `--reveal`, and
   `--desktop` rules for direct plaintext; app integration is required afterward
   for `read`, `env-resolve`, `pass-reveal`, and desktop `run` / `env run`.
5. **Refuse closed** — if the daemon is down or the person denies, the CLI exits
   with the spec messages (app unavailable, denied, expired, wrong session). Tests
   use `OPENSESAME_CLI_APP_INTEGRATION_SEAM=approve|deny|unavailable` without
   weakening production gates.

## Consequences

- Pages must surface pending CLI integration requests and call `respond` (follow-up
  UI work; daemon API is stable for that wiring).
- Service-account `run` without `--desktop` does not poll app integration (token
  auth remains the service-account path).
- Agent-context env markers are removed from `cli-reveal-gate.json`; do not reintroduce
  them as a parallel gate.
