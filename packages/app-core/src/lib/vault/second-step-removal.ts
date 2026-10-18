/** Header transformation only; the Store retains mutation and publication admission. */
import type { VaultHeader } from "@opensesame/vault-core";
import {
  type CodeChannel,
  type VaultUnlocks,
  hasSecondStep,
} from "./unlock-methods.js";
export function headerWithoutSecondStep(
  header: VaultHeader,
  step: "totp" | CodeChannel,
): VaultHeader {
  const { [step]: _removed, ...rest } = header.unlocks ?? {};
  let unlocks: VaultUnlocks = { ...rest };
  if (
    !hasSecondStep({ ...header, unlocks }) &&
    unlocks.recovery !== undefined
  ) {
    const { recovery: _codes, ...withoutCodes } = unlocks;
    unlocks = withoutCodes;
  }
  return {
    ...header,
    unlocks: Object.keys(unlocks).length ? unlocks : undefined,
  };
}
