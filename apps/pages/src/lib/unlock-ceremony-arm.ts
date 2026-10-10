import { unlockCeremonyStore } from "./unlock-ceremony-store.js";

/** Hold the unlock gate before the vault store emits `unlocked` (lock-v5). */
export async function withUnlockCeremony<T>(
  run: () => Promise<T>,
): Promise<T> {
  unlockCeremonyStore.begin();
  try {
    return await run();
  } catch (caught) {
    unlockCeremonyStore.end();
    throw caught;
  }
}

export function cancelUnlockCeremony(): void {
  unlockCeremonyStore.end();
}
