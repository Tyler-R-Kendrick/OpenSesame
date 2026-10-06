import {
  type PasskeyProbeOptions,
  probePasskeyCeremony,
} from "./passkey-unlock-session.js";
import type { GuardedUnlockHost } from "./primary-unlock-session.js";
import {
  type ProtectorUnlockInput,
  probeProtectorRoot,
} from "./protector-unlock-session.js";

export async function probeGuardedPasskey(
  host: GuardedUnlockHost,
  options?: PasskeyProbeOptions,
) {
  const probe = await probePasskeyCeremony(host, options);
  try {
    host.assertCurrent();
    return probe;
  } catch (error) {
    new Uint8Array(probe.prfOutput).fill(0);
    throw error;
  }
}

export async function probeGuardedProtector(
  host: GuardedUnlockHost,
  input: ProtectorUnlockInput,
) {
  const root = await probeProtectorRoot(host, input);
  try {
    host.assertCurrent();
    return root;
  } catch (error) {
    new Uint8Array(root).fill(0);
    throw error;
  }
}
