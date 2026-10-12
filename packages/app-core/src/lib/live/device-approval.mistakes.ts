/**
 * Mistakes the type checker must keep refusing (ADR 0178, ADR 0196): letting a
 * device use the owner's connections without the `manage_grants` proof.
 * `tsc` fails the build if one starts to compile. Nothing here runs.
 */

import { name } from "@gdp-ts/core";
import { requireManageGrants } from "../proofs/share-write.js";
import type { DeviceBroker } from "./device-broker.js";

export async function approvalMistakes(broker: DeviceBroker): Promise<void> {
  const approval = { connections: ["c-1"], minutes: 5 };
  await name("tomb-a", async (vault) => {
    // The honest path compiles.
    broker.approve("request", approval, await requireManageGrants(vault));

    // @ts-expect-error — allowing a device needs the proof, not just the request.
    broker.approve("request", approval);

    // @ts-expect-error — a word is not a proof.
    broker.approve("request", approval, "manage_grants");
  });
}
