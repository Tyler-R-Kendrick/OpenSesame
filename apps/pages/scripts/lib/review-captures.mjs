/**
 * Where a browser gate puts the design-review captures that the impeccable
 * surface notes cite (`apps/pages/.impeccable/review/`).
 *
 * Those files are committed evidence, so a routine run of `verify:keyboard`
 * or `verify:local-iam` must not rewrite them and leave the tree dirty. By
 * default the captures go to the gitignored `artifacts/impeccable-review/`.
 * `UPDATE_REVIEW_CAPTURES=1` writes the committed set instead, for a change
 * that means to refresh it.
 */

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMMITTED = new URL("../../.impeccable/review/", import.meta.url);
const SCRATCH = new URL(
  "../../../../artifacts/impeccable-review/",
  import.meta.url,
);

/** The capture directory for this run, created if missing. */
export function reviewCaptureDir(env = process.env) {
  const dir = fileURLToPath(
    env.UPDATE_REVIEW_CAPTURES === "1" ? COMMITTED : SCRATCH,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
