/**
 * What the device identity tests share: acting as one of two devices with the
 * device host reading that device's vault and body, asking for its principal,
 * opening a session, and syncing it with a drive.
 */
import { overlapCast } from "@opensesame/os-domain";
import { deviceIdentityFetch } from "../device-identity-host.js";
import { readDeviceIdentityKey } from "../device-identity-key.js";
import { deviceVaultSeams } from "../device-identity-vault.js";
import {
  bodyPortOf,
  installDeviceKeyCarrier,
} from "../vault/store-device-key.js";
import { type Device, as } from "./devices.fixture.js";
import type { MemoryDrive } from "./drive.fixture.js";
import { PAIRING } from "./drive.fixture.js";
import { syncOnce } from "./engine.js";

export const PASSWORD = "correct horse battery staple";
export const TOMB = "personal";

/** Act as `on`, with the device host reading that device's vault and body. */
export function acting<T>(on: Device, act: () => Promise<T>): Promise<T> {
  return as(on, async () => {
    installDeviceKeyCarrier(() => bodyPortOf(on.store));
    deviceVaultSeams.view = () => ({
      kind: "unlocked",
      tomb: TOMB,
      guest: false,
    });
    return act();
  });
}

export const principalOf = (on: Device) =>
  acting(on, async () => (await readDeviceIdentityKey(TOMB))?.principalId);

/** Open a provisional session on `on`: its principal, and its own bearer. */
export async function connect(
  on: Device,
): Promise<{ principalId: string; token: string }> {
  return acting(on, async () => {
    const res = await deviceIdentityFetch("/v1/principals/provisional", {
      method: "POST",
      body: "{}",
    });
    const body = overlapCast(await res.json());
    return {
      principalId: String(body.principalId),
      token: String(body.accessToken),
    };
  });
}

export function whoAmI(on: Device, token: string): Promise<Response> {
  return acting(on, () =>
    deviceIdentityFetch("/v1/principals/me", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

export function sync(on: Device, drive: MemoryDrive) {
  return as(on, () => syncOnce(on.store, PAIRING, drive));
}
