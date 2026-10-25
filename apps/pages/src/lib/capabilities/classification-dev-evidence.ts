/**
 * Dev-only classification entries (visual evidence, reference harnesses).
 *
 * Split out of `classification-lib.ts` for the 400-line module budget.
 */

import { core, shared } from "./classification-rule.js";

export const DEV_EVIDENCE_RULES = [
  shared(
    "src/test-support/lock-manager.ts",
    "test-only Web Locks fixture shared by guest, local IAM and vault UI tests",
  ),
  core(
    "src/lib/ai-completion-observation.ts",
    null,
    "internal observation types and optional seam have no runtime imports or credentials",
  ),
  core(
    "src/verification/ai-completion-verifier.ts",
    null,
    "explicit AI verifier build entry observes only the neutral seam; absent from normal builds",
  ),
  core(
    "src/dev/",
    null,
    "LockV5Demo dev route for lock-v5 geometry reference (Vite dev only)",
  ),
];
