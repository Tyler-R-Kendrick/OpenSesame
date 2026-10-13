/** Runtime slice of `spec/conformance/cli-app-integration.json` (timing + daemon paths only). */
export const cliAppIntegrationPolicy = {
  version: 1,
  idleTimeoutSeconds: 600,
  hardLimitSeconds: 43200,
  requestTimeoutSeconds: 120,
  pollIntervalMs: 500,
  daemonPinProbeVerb: "daemon-pin-probe",
  daemonPaths: {
    ensure: "/v1/cli/app-integration/ensure",
    respond: "/v1/cli/app-integration/respond",
    pending: "/v1/cli/app-integration/pending",
    daemonAttest: "/v1/cli/app-integration/daemon-attest",
    pairingChallenge: "/v1/cli/app-integration/pairing/challenge",
    pairingConfirm: "/v1/cli/app-integration/pairing/confirm",
    pairingExchange: "/v1/cli/app-integration/pairing",
    pairingIssue: "/v1/operator/cli-app-integration/pair",
  },
} as const;
