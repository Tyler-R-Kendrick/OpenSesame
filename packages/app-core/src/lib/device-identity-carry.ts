/**
 * Keeping the device identity key and the vault body that carries it as one
 * (ADR 0160 §5).
 *
 * The principal is the thumbprint of a key sealed in the tomb. A copy rides in
 * the sealed body so a backup, a sync or a restore brings it along. The two
 * copies drift whenever the body changes under the tomb: a vault opened with
 * no tomb key (restored, or first synced here), a merge that brought another
 * device's key, an import. `reconcileDeviceIdentityKey` brings them level:
 *
 * | tomb  | body  | does                                                      |
 * | ----- | ----- | --------------------------------------------------------- |
 * | none  | none  | nothing; the first use mints                              |
 * | none  | key   | the tomb takes the body's (a restore, a second device)    |
 * | key   | none  | the body takes the tomb's (a vault from before keys moved) |
 * | key   | same  | nothing                                                   |
 * | key A | key B | the older `createdAt` wins, then the smaller key id       |
 *
 * When the tomb's key loses, its principal is gone from this device: every
 * session bound to it ends on its next use (the binding checks the key id),
 * and a notice says so. A record either side holds that this build cannot
 * trust is left exactly as it is, on both sides.
 *
 * A restore may name the body's key the winner (`prefer: "carried"`): putting
 * a backup into a vault that has done nothing yet is the person asking for the
 * backup's principal, not for whichever key is older.
 */

import { type JsonObject, isJsonObject } from "@opensesame/os-domain";
import {
  type DeviceIdentityKeyRecord,
  deviceKeyField,
  mergeDeviceKeyFields,
  readDeviceIdentityKeyRecord,
  winningDeviceKey,
} from "@opensesame/vault-core";
import {
  deviceKeyIsGenuine,
  readStoredDeviceIdentityKey,
  withDeviceIdentityFence,
  writeStoredDeviceIdentityKey,
} from "./device-identity-key.js";
import { setStatusNotice } from "./notices.js";

/** What the store lends the reconcile: its open tomb and the body's key field. */
export type KeyCarryHost = Readonly<{
  tomb: string;
  /** False for a guest or scratch tomb: nothing there is exported or synced. */
  carries: boolean;
  field(): JsonObject | undefined;
  /** Put a key in the body, ranked against what it holds, and persist. */
  publish(field: JsonObject): Promise<void>;
}>;

export type KeyCarryOutcome =
  | "skipped"
  | "none"
  | "same"
  | "adopted"
  | "published"
  | "replaced"
  | "kept";

const CHANGED_ID = "device-identity-changed";

/** Tell the person, in the bell, that this vault's principal is not what it was. */
export function noteDeviceIdentityChanged(
  cause: "replaced" | "restored-without-key",
): void {
  setStatusNotice(
    cause === "replaced"
      ? {
          id: CHANGED_ID,
          tone: "info",
          title: "Device identity changed",
          body: "This vault already carried an older identity key, so this device uses it now. Sessions that used the previous one have ended.",
        }
      : {
          id: CHANGED_ID,
          tone: "info",
          title: "Restored without an identity key",
          body: "That backup carries no identity key, so this vault keeps its own. Its principal differs from the one the backup was made under.",
        },
  );
}

/** The carried record, when this build can read it and trust it. */
async function trustedCarried(
  field: JsonObject | undefined,
): Promise<DeviceIdentityKeyRecord | null | "untrusted"> {
  if (field === undefined) return null;
  const record = readDeviceIdentityKeyRecord(field);
  return record && (await deviceKeyIsGenuine(record)) ? record : "untrusted";
}

async function reconcileLocked(
  host: KeyCarryHost,
  prefer: "older" | "carried",
): Promise<KeyCarryOutcome> {
  let local: DeviceIdentityKeyRecord | null;
  try {
    local = await readStoredDeviceIdentityKey(host.tomb);
  } catch {
    return "kept";
  }
  const carried = await trustedCarried(host.field());
  if (carried === "untrusted") return "kept";
  if (local === null) {
    if (carried === null) return "none";
    await writeStoredDeviceIdentityKey(host.tomb, carried);
    return "adopted";
  }
  if (carried === null) {
    await host.publish(deviceKeyField(local));
    return "published";
  }
  if (local.keyId === carried.keyId) return "same";
  if (prefer === "carried" || winningDeviceKey(local, carried) === carried) {
    await writeStoredDeviceIdentityKey(host.tomb, carried);
    noteDeviceIdentityChanged("replaced");
    return "replaced";
  }
  await host.publish(deviceKeyField(local));
  return "published";
}

export type KeyCarryOptions = Readonly<{ prefer?: "carried" }>;

/** Bring the tomb's key and the body's level. Idempotent; safe in two tabs. */
export async function reconcileDeviceIdentityKey(
  host: KeyCarryHost,
  options: KeyCarryOptions = {},
): Promise<KeyCarryOutcome> {
  if (!host.carries) return "skipped";
  return withDeviceIdentityFence(host.tomb, () =>
    reconcileLocked(host, options.prefer ?? "older"),
  );
}

/** What a restore does with the key: what the body holds after, and whether it came without one. */
export type RestoreKeyPlan = Readonly<{
  field: JsonObject | undefined;
  withoutKey: boolean;
  /** Take the body's key over the tomb's, whichever is older. */
  prefer: "older" | "carried";
}>;

/**
 * The key a restore leaves in the body.
 *
 * - **The same vault** (a backup of this very vault, an older or newer copy):
 *   the two keys are ranked as any merge ranks them.
 * - **Another vault into one that has done nothing yet** (a fresh vault on a
 *   new device, then the backup): the backup's key becomes this vault's, so
 *   its principal carries over. A backup with no key readable here leaves the
 *   vault its own and reports that it came without one.
 * - **Another vault into one with content**: items are merged, identity is
 *   not. The vault keeps its key.
 */
export function keyForRestore(input: {
  local: JsonObject | undefined;
  incoming: JsonObject | undefined;
  sameVault: boolean;
  fresh: boolean;
}): RestoreKeyPlan {
  const { local, incoming, sameVault, fresh } = input;
  if (sameVault) {
    return {
      field: mergeDeviceKeyFields(local, incoming),
      withoutKey: false,
      prefer: "older",
    };
  }
  if (!fresh) return { field: local, withoutKey: false, prefer: "older" };
  const readable =
    incoming !== undefined &&
    isJsonObject(incoming) &&
    readDeviceIdentityKeyRecord(incoming) !== null;
  return readable
    ? { field: incoming, withoutKey: false, prefer: "carried" }
    : { field: local, withoutKey: true, prefer: "older" };
}
