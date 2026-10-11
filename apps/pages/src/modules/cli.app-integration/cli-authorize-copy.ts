/** Authorize CLI sheet copy (kept in the capability chunk, not app-core policy). */
export const cliAuthorizeCopy = {
  sheetTitle: "Authorize CLI",
  sheetLead: "OpenSesame CLI wants to access your vault from this terminal.",
  terminalLabel: "Terminal session",
  commandLabel: "Command",
  targetLabel: "Item",
  allowKey: "Authorize",
  denyKey: "Deny",
  confirmPin: "Confirm with PIN",
  pinPlaceholder: "PIN",
} as const;

export const cliVerbLabels = {
  read: "Read a secret",
  run: "Run a command",
  "env-resolve": "Resolve environment variables",
  "pass-reveal": "Reveal from the password store",
} as const;
