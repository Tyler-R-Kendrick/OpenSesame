/**
 * The deployment of one's own that the live walks use for a carrier or relay
 * on this machine or a private address. The shared GitHub Pages origin may not
 * reach a loopback or LAN address at all (`mayPairLocalAuthority`), whichever
 * way it asks, so those walks run on a build stamped `dedicated_origin` for
 * this origin (`pnpm --filter @opensesame/pages build:live-dedicated`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEDICATED_ORIGIN = "https://opensesame.example.test";
export const DEDICATED_DIST = path.resolve(here, "../../dist-live-dedicated");

/** `{ origin, dist }` of the dedicated build, or a refusal naming how to make it. */
export function dedicatedSite() {
  if (!fs.existsSync(DEDICATED_DIST))
    throw new Error(
      "no dedicated build: run `pnpm --filter @opensesame/pages build:live-dedicated`",
    );
  return { origin: DEDICATED_ORIGIN, dist: DEDICATED_DIST };
}
