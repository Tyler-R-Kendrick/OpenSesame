import { name } from "@gdp-ts/core";
import { requireManageGrants } from "../proofs/share-write.js";
import type { DeviceResetBroker } from "./device-reset-broker.js";
import type { ApproveResult } from "./device-types.js";

export function allowDeviceReset(
  broker: DeviceResetBroker | null,
  tomb: string,
  id: string,
): Promise<ApproveResult> {
  return name(tomb, async (vault) => {
    const authority = await requireManageGrants(vault);
    return broker?.approve(id, authority) ?? "unavailable";
  });
}
