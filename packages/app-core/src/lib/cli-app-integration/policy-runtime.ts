/** Runtime slice of `spec/conformance/cli-app-integration.json` (timing + daemon paths + tray copy). */
export const cliAppIntegrationPolicy = {
  version: 1,
  idleTimeoutSeconds: 600,
  hardLimitSeconds: 43200,
  requestTimeoutSeconds: 120,
  pollIntervalMs: 500,
  messages: {
    pending: "Waiting for you to allow CLI integration in OpenSesame…",
  },
  ui: {
    sheetTitle: "Authorize CLI",
    allowKey: "Authorize",
  },
  daemonPaths: {
    ensure: "/v1/cli/app-integration/ensure",
    respond: "/v1/cli/app-integration/respond",
    pending: "/v1/cli/app-integration/pending",
    pairingConfirm: "/v1/cli/app-integration/pairing/confirm",
    pairingExchange: "/v1/cli/app-integration/pairing",
    pairingIssue: "/v1/operator/cli-app-integration/pair",
  },
} as const;
