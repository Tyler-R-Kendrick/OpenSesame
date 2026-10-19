/** Existing primary entrypoints retain the private Store callbacks and configured factors. */
import {
  type PasskeyUnlockSessionHost,
  probePasskeyCeremony,
  unlockVaultWithHeldPrf,
  unlockVaultWithPasskey,
} from "./passkey-unlock-session.js";
import {
  type ProtectorUnlockInput,
  probeProtectorRoot,
  unlockVaultWithHeldRoot,
  unlockVaultWithProtector,
} from "./protector-unlock-session.js";
export function createStorePrimaryApi(current: () => PasskeyUnlockSessionHost) {
  return {
    probePasskeyCeremony: (
      options?: Parameters<typeof probePasskeyCeremony>[1],
    ) => probePasskeyCeremony(current(), options),
    unlockWithHeldPrf: (prfOutput: ArrayBuffer) =>
      unlockVaultWithHeldPrf(current(), prfOutput),
    unlockWithPasskey: (signal?: AbortSignal) =>
      unlockVaultWithPasskey(current(), signal),
    unlockWithProtector: (input: ProtectorUnlockInput) =>
      unlockVaultWithProtector(current(), input),
    probeProtector: (input: ProtectorUnlockInput) =>
      probeProtectorRoot(current(), input),
    unlockWithHeldProtectorRoot: (
      root: ArrayBuffer,
      { method }: Pick<ProtectorUnlockInput, "method">,
    ) => unlockVaultWithHeldRoot(current(), root, method),
  };
}
