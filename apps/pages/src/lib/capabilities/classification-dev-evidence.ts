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
    "LockV5Demo dev route for lock-v5 geometry reference (Vite dev only)",
  ),
];
