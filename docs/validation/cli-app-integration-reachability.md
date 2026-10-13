# CLI app integration reachability (ADR 0186 round 4)

## Same machine (loopback)

1. Operator mints a pairing code on the daemon (`POST /v1/operator/cli-app-integration/pair`).
2. On loopback Pages, Identity › Devices › **Terminal CLI**, paste the
   `opensesame-cli-app:v1:` code. The browser confirms at
   `POST /v1/cli/app-integration/pairing/confirm`, then exchanges at
   `POST /v1/cli/app-integration/pairing` with `pageBinding`, and keeps the
   bearer in session storage plus `daemonApi` in settings.
3. When the CLI blocks on reveal, the tray notice links to
   `/identity/authorize?cli=1`. Approve with PIN or passkey; the daemon receives
   `POST /v1/cli/app-integration/respond` with `humanProof`.

No relay, Host API, or Identity API is required on this path.

## Remote PWA

The static GitHub Pages deployment cannot reach a loopback daemon. Remote
reachability uses **live join** (session invite code) plus **OAuth device
flow** approved in the PWA, then PIN or passkey scoped per terminal session —
the GitHub CLI model described in ADR 0186. That path is not the loopback
pairing UI.

## Verification

| Layer | Command |
|-------|---------|
| Pairing parse + exchange | `pnpm exec vitest run packages/app-core/src/lib/cli-app-integration/pairing.test.ts` |
| Daemon pending fetch (app-core client) | `pnpm exec vitest run packages/app-core/src/lib/cli-app-integration/client.test.ts` |
| Authorize CLI pairing | `pnpm exec vitest run packages/app-core/src/lib/cli-app-integration/pairing.test.ts` |
| Daemon session vectors | `pnpm exec vitest run packages/app-core/src/lib/cli-app-integration/session.test.ts` |
| Rust daemon routes | `cargo +1.88.0 test -p opensesame-cli cli_app_integration` |

Bundle budgets: no new optional modules; pairing UI ships with `identity.local-iam`.
