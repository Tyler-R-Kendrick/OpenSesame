/** Runtime slice of `spec/conformance/cli-app-integration.json` (timing + daemon paths only). */
import { cliAppDaemonPaths } from "./daemon-paths.js";

export const cliAppIntegrationPolicy = {
  version: 1,
  idleTimeoutSeconds: 600,
  hardLimitSeconds: 43200,
  requestTimeoutSeconds: 120,
  pollIntervalMs: 500,
  daemonPaths: cliAppDaemonPaths,
} as const;
