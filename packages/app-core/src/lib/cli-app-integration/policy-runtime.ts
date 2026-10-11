/** Runtime slice of `spec/conformance/cli-app-integration.json` (no test vectors). */
export const cliAppIntegrationPolicy = {
  version: 1,
  idleTimeoutSeconds: 600,
  requestTimeoutSeconds: 120,
  pollIntervalMs: 500,
  daemonPaths: {
    ensure: "/v1/cli/app-integration/ensure",
    respond: "/v1/cli/app-integration/respond",
    pending: "/v1/cli/app-integration/pending",
  },
  messages: {
    appUnavailable:
      "OpenSesame is not running. Unlock OpenSesame and allow CLI integration to reveal secrets from this terminal.",
    denied: "CLI integration was denied in OpenSesame.",
    expired:
      "CLI integration for this terminal expired due to inactivity. Allow it again in OpenSesame.",
    pending: "Waiting for you to allow CLI integration in OpenSesame…",
    wrongSession:
      "CLI integration is approved for a different terminal session.",
  },
  ui: {
    sheetTitle: "Authorize CLI",
    sheetLead: "OpenSesame CLI wants to access your vault from this terminal.",
    terminalLabel: "Terminal session",
    commandLabel: "Command",
    targetLabel: "Item",
    fieldLabel: "Field",
    allowKey: "Authorize",
    denyKey: "Deny",
    confirmPasskey: "Confirm with passkey",
    confirmPin: "Confirm with PIN",
    pinPlaceholder: "PIN",
  },
  verbLabels: {
    read: "Read a secret",
    run: "Run a command",
    "env-resolve": "Resolve environment variables",
    "pass-reveal": "Reveal from the password store",
  },
} as const;
