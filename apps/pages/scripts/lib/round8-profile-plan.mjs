/**
 * Round 8 install-profile evidence: the constants and the capture plan.
 *
 * The galleries pair two builds each:
 *
 *   P8-1 before  40681647c  parent of merge #1457
 *   P8-1 after   51f27bc95  portable drop on main
 *   P8-2 before  51f27bc95  (the same build)
 *   P8-2 after   the capturing branch's tip
 *
 * `ROUND8_ONLY=p8-1` or `p8-2` captures one gallery. The trees, the browser
 * walks and the sheets live beside this module; the entry point is
 * `apps/pages/scripts/capture-round8-profile-evidence.mjs`.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
export const ORIGIN = "https://opensesame-labs.github.io";
export const BASE = "/OpenSesame/";
export const P8_1_BEFORE = "40681647c9ea585c6ec5fb920e81e2c7a70b12da";
export const P8_1_AFTER = "51f27bc95716afda76eeae4629a18abfd03115ba";
export const WT_ROOT = "/tmp/p8-ev-wt";
export const SHOT_ROOT = path.join(os.tmpdir(), "p8-round8-shots");
export const SECRET = "correct-horse-battery-staple-2026";
export const JOINER = "Ada Lovelace";

export function log(message) {
  console.error(`[round8] ${new Date().toISOString()} ${message}`);
}

/** `ROUND8_ONLY` narrows the run to one gallery; unset captures both. */
export function selectedFeatures(only) {
  if (!only) return ["p8-1", "p8-2"];
  if (only !== "p8-1" && only !== "p8-2") {
    throw new Error("ROUND8_ONLY must be p8-1 or p8-2");
  }
  return [only];
}

/** The commits to build, in order, with the shared middle build once. */
export function shasFor(features, afterP2) {
  const shas = [];
  const add = (sha) => {
    if (!shas.includes(sha)) shas.push(sha);
  };
  if (features.includes("p8-1")) {
    add(P8_1_BEFORE);
    add(P8_1_AFTER);
  }
  if (features.includes("p8-2")) {
    add(P8_1_AFTER);
    add(afterP2);
  }
  return shas;
}
