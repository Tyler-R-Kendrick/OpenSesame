# Audit tick 70 — the CLIs printed and stored tokens more freely than they meant to

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, osv-scanner, cargo-deny). Read
the two command-line surfaces that hold credentials on disk: `packages/cli`
(identity CLI) and `apps/cli` (Rust CLI).

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | The Rust CLI printed the operator token inside a copy-and-paste `curl` line on every device login. That is a machine-wide shared secret written to terminal scrollback, pipes, and CI logs. | The line names `$OPENSESAME_OPERATOR_TOKEN` and lets the shell read it. |
| High | The same login printed the whole session object, access token included. | Tokens redacted from what is printed; the file still holds the real thing. |
| High | Both CLIs wrote the session file and *then* chmod'd it to 0600, so it existed world-readable for a window — long enough for another account to open it and keep the handle. `writeFile`'s `mode` also does nothing to a file that already exists, so one left at 0644 by an earlier version stayed there. | Rust: `OpenOptions::mode(0o600)` at creation, then set the mode again for a pre-existing file. Node: write a temp file at 0600 and rename over the target. |
| Medium | The identity CLI read whatever session file it found. A bearer token in a group-readable or group-writable file is one every account on the box holds — or gets to choose. | The file is refused, loudly, if any bits outside the owner's are set. |
| Medium | A session saved for one issuer was sent to whatever `--api`/`OPENSESAME_API_URL` named, and its `expiresAt` was never consulted. | `sessionFor` hands back a session only for the issuer that minted it, and only before it expires. |
| Medium | The Rust CLI passed the server's `expires_in` straight to `chrono::Duration::seconds`, which panics rather than errors on an out-of-range count. `interval` was likewise unbounded. | Both clamped. |
| Low | `directories`-derived config dir aside, `sessionPath()` in the Node CLI preferred the ambient `XDG_RUNTIME_DIR` over the explicit `OPENSESAME_STATE_DIR`. | Explicit setting wins. |
| Low | The daemon log file was created at the umask's mode although the daemon's own output lands in it. | Created 0600. |
| Low | `device_login` unwrapped `device_code`, `user_code`, and `verification_uri` out of the response, so a malformed answer panicked the CLI. | Each is a named error now. |

## Tests

`packages/cli/src/session.test.ts` (new) drives `runCli` against a temp state dir: the
session lands at 0600, a 0644 file left by an earlier version has its bits taken back,
a file others can reach is refused out loud, one issuer's token is never sent to
another, and an expired session is not reused. `apps/cli` gains unit tests for
`write_private` over a pre-existing 0644 file and for the device-code TTL clamp,
including a pinned demonstration that chrono panics on `i64::MAX`.
