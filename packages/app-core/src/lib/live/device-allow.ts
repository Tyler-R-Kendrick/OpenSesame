/**
 * The owner allowing a device (ADR 0195, ADR 0178): the vault's own
 * `manage_grants` check, then the broker's approval under the proof it passed.
 *
 * Letting a process use saved connections is handing out authority, the same
 * kind of act as a share or a model key, so it meets the same check — the
 * operator rule once an operator is assigned, and the duress ceilings — and
 * rejects with the vault's own refusal when the person may not. Nothing is
 * allowed on a refusal.
 */

import { name } from "@gdp-ts/core";
import { requireManageGrants } from "../proofs/share-write.js";
import type { DeviceBroker } from "./device-broker.js";
import type { Approval, ApproveResult } from "./device-types.js";

export function allowDevice(
  broker: DeviceBroker | null,
  tomb: string,
  id: string,
  approval: Approval,
): Promise<ApproveResult> {
  return name(tomb, async (vault) => {
    const authority = await requireManageGrants(vault);
    return broker?.approve(id, approval, authority) ?? "unavailable";
  });
}
