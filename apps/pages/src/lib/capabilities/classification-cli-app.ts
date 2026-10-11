/**
 * CLI app-integration classification.
 *
 * Split out of `classification-lib.ts` for the 400-line module budget.
 */

import { core } from "./classification-rule.js";

export const CLI_APP_INTEGRATION_RULES = [
  core(
    "src/modules/cli.app-integration/",
    "cli.app-integration",
    "CLI authorize sheet and loopback daemon client",
  ),
];
