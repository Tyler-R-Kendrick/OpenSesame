/** Daemon routes for CLI app-integration (ADR 0186). */
export const cliAppDaemonPaths = {
  ensure: "/v1/cli/app-integration/ensure",
  respond: "/v1/cli/app-integration/respond",
  pending: "/v1/cli/app-integration/pending",
  pairingConfirm: "/v1/cli/app-integration/pairing/confirm",
  pairingExchange: "/v1/cli/app-integration/pairing",
  pairingIssue: "/v1/operator/cli-app-integration/pair",
} as const;
