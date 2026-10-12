/**
 * Allowing a device in a test (ADR 0196, ADR 0178): through the same
 * `allowDevice` the page uses, so the proof comes from the real prover and is
 * never forged. The vault is a fresh unlocked tomb with nobody assigned, which
 * is what a lone owner has.
 */
import { mintVaultKey } from "@opensesame/vault-core";
import { unlockTomb } from "../vfs.js";
import { allowDevice } from "./device-allow.js";
import type { DeviceBroker } from "./device-broker.js";
import type { Approval, ApproveResult } from "./device-types.js";

export async function approveAs(
  broker: DeviceBroker | null | undefined,
  id: string,
  approval: Approval,
): Promise<ApproveResult> {
  const tomb = `device-approval-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  return allowDevice(broker ?? null, tomb, id, approval);
}
