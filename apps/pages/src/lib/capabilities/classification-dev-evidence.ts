/**
 * Dev-only classification entries (visual evidence, reference harnesses).
 *
 * Split out of `classification-lib.ts` for the 400-line module budget.
 */

import { core } from "./classification-rule.js";

export const DEV_EVIDENCE_RULES = [
  core(
    "src/dev/",
    null,
    "lock-v5 reference harness for visual evidence captures",
  ),
  core(
    "src/lock-v5-reference-main.tsx",
    null,
    "lock-v5 reference HTML entry for visual evidence captures",
  ),
];
