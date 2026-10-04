/**
 * What the vault store lends so the device identity key can ride in its body
 * (ADR 0160 §5).
 *
 * Split out of `store.ts`: the store holds the body and its write chain; this
 * file turns that into the two things the key needs, a host to reconcile
 * against at unlock, merge and restore (`device-identity-carry.ts`) and the
 * carrier port the device host mints through (`device-identity-carrier.ts`).
 */

import type { JsonObject } from "@opensesame/os-domain";
import {
  type VaultBody,
  type VaultHeader,
  mergeDeviceKeyFields,
} from "@opensesame/vault-core";
import {
  type DeviceKeyCarrier,
  deviceKeyCarrier,
} from "../device-identity-carrier.js";
import type {
  KeyCarryHost,
  KeyCarryOptions,
  KeyCarryOutcome,
} from "../device-identity-carry.js";

/** The open vault, as far as the key and a restore need to see it. */
export type VaultBodyPort = Readonly<{
  tomb: () => string;
  /** The vault key is held, so the body is loaded and can be written. */
  open: () => boolean;
  /** False for a guest or scratch session: nothing there is exported or synced. */
  carries: () => boolean;
  header: () => VaultHeader | null;
  body: () => VaultBody;
  mutate: (change: (body: VaultBody) => void) => Promise<void>;
}>;

export function keyCarryHost(port: VaultBodyPort): KeyCarryHost {
  return {
    tomb: port.tomb(),
    carries: port.open() && port.carries(),
    field: () => port.body().deviceIdentityKey,
    publish: async (field: JsonObject) => {
      // Ranked against what the body holds, and not written when that changes
      // nothing: a read of the principal must not cost a sync.
      const held = port.body().deviceIdentityKey;
      if (mergeDeviceKeyFields(held, field) === held) return;
      await port.mutate((body) => {
        body.deviceIdentityKey = mergeDeviceKeyFields(
          body.deviceIdentityKey,
          field,
        );
      });
    },
  };
}

/**
 * Level the tomb's key with the body's. Never throws: a vault that opens, merges
 * or restores must not fail over its identity, and the next unlock tries again.
 */
export async function levelDeviceKey(
  port: VaultBodyPort,
  options: KeyCarryOptions = {},
): Promise<KeyCarryOutcome> {
  try {
    // Loaded when a vault opens, merges or restores, not with the store.
    const { reconcileDeviceIdentityKey } = await import(
      "../device-identity-carry.js"
    );
    return await reconcileDeviceIdentityKey(keyCarryHost(port), options);
  } catch {
    return "kept";
  }
}

/** The carrier for whichever store `port` reads; it answers only for the tomb open there. */
export function installDeviceKeyCarrier(port: () => VaultBodyPort): void {
  const answers = (tomb: string): VaultBodyPort | null => {
    const now = port();
    return now.open() && now.carries() && now.tomb() === tomb ? now : null;
  };
  const carrier: DeviceKeyCarrier = {
    carried: (tomb) => answers(tomb)?.body().deviceIdentityKey,
    publish: (tomb, field) => {
      const now = answers(tomb);
      return now ? keyCarryHost(now).publish(field) : Promise.resolve();
    },
  };
  Object.assign(deviceKeyCarrier, carrier);
}
