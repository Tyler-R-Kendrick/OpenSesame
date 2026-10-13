/** Pages-visible copy and polling for CLI app-integration (ADR 0186). */
export const cliAppIntegrationUi = {
  pollIntervalMs: 500,
  messages: {
    pending: "Allow CLI integration in OpenSesame.",
  },
  sheetTitle: "Authorize CLI",
  allowKey: "Authorize",
} as const;
