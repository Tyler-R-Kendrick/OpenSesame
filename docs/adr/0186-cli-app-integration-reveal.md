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
2. **Terminal session id** — the daemon derives it from the kernel-attested peer
   pid over the Unix socket (Linux `/proc/<pid>/stat` session + tty; macOS
   `ps`). The JSON body’s `terminalSessionId` is ignored on UDS. Over TCP
   loopback the client sends only a per-attempt correlation id; approvals are
   single-use (no cross-command reuse). Client env overrides are forbidden.
3. **Daemon holds state** — `POST /v1/cli/app-integration/ensure` blocks until
   approved, denied, or timeout; `GET …/pending` and `POST …/respond` let the
   OpenSesame app (Pages) approve with PIN or passkey. Loopback only. Browser
   routes require a pairing bearer (`POST …/pairing`, prefix
   `opensesame-cli-app:v1:`); the operator mints codes at
   `POST /v1/operator/cli-app-integration/pair`. Each pending row carries a
   one-time `respondNonce`; approve also requires `humanProof` from the unlock
   ceremony.
4. **Two-layer gate** — `cli-reveal-gate.json` keeps TTY, `--reveal`, and
   `--desktop` rules for direct plaintext; app integration is required afterward
   for `read`, `env-resolve`, `pass-reveal`, and desktop `run` / `env run`.
5. **Refuse closed** — if the daemon is down or the person denies, the CLI exits
   with the spec messages (app unavailable, denied, expired, wrong session).
   Production binaries never read a seam environment variable; journey tests
   inject `HumanRevealRequest.appIntegration` or point `OPENSESAME_DAEMON_API` at
   a loopback fake daemon. The Rust `test-seams` feature (tests only) may still
   read the legacy seam name for harnesses that opt in.

## Consequences

- Pages must surface pending CLI integration requests and call `respond` (follow-up
  UI work; daemon API is stable for that wiring).
- **Reachability (round 4):** same-machine CLI ↔ PWA approval is direct (local
  pairing, no relay). Remote PWA: join with a session invite code, then OAuth
  device flow approved in the PWA (GitHub CLI model). PIN or passkey still
  required, scoped per terminal session.
- **Hard limit:** `hardLimitSeconds` in the spec is **43200** (12 h).
- **`run` / `env run`:** every desktop and non-desktop injection path requires
  app approval after D4-6 (no unapproved injection lane).
- Service-account paths remain token-gated where the reveal gate already
  excludes them.
- Agent-context env markers are removed from `cli-reveal-gate.json`; do not reintroduce
  them as a parallel gate.
