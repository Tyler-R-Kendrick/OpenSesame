/**
 * CLI app-integration classification.
 *
 * Split out of `classification-lib.ts` for the 400-line module budget.
 */

import { core } from "./classification-rule.js";

export const CLI_APP_INTEGRATION_RULES = [
  core(
    "src/lib/cli-app-integration/",
    "shell.navigation",
    "CLI app-integration protocol; the Pages module lands in #1084",
  ),
];
