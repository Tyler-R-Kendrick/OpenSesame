/**
 * Keeping the device identity key and the vault body that carries it as one
 * (ADR 0160 §5a).
 *
 * The principal is the thumbprint of a key sealed in the tomb. A copy rides in
 * the sealed body so a backup, a sync or a restore brings it along. The two
 * copies drift whenever the body changes under the tomb: a vault opened with
 * no tomb key (restored, or first synced here), a merge that brought another
 * device's key. `reconcileDeviceIdentityKey` brings them level:
 *
 * | tomb  | body  | does                                                      |
 * | ----- | ----- | --------------------------------------------------------- |
 * | none  | none  | nothing; the first use mints                              |
 * | none  | key   | the tomb takes the body's (a restore, a second device)    |
 * | key   | none  | the body takes the tomb's (a vault from before keys moved) |
 * | key   | same  | nothing                                                   |
 * | key A | key B | the older `createdAt` wins, then the smaller key id       |
 *
 * Only a key that passes `device-identity-trust.ts` is a key: a forged or
 * malformed record in the body is the same as none (the tomb's key replaces it
 * on the next publish), and never wins. A record of a newer version is left
 * exactly as it is on both sides.
 *
 * The tomb's file is this device's own and is read as written, but what is
 * ranked and published is its date brought inside the vault's window (never
 * later than now, never a day before the vault existed): a key dated beyond
 * what the body's readers accept would be published and read back as poison,
 * and the next unlock would publish it again. A pass that finds the body
 * already carrying the tomb's key writes nothing.
 *
 * Ranking happens here and in an authenticated merge (`mergeSnapshot`), where
 * a body is sealed under this vault's own key. It never happens for a backup:
 * a backup's header and body are whatever its author wrote, so an import takes
 * the backup's key only when the person says so (`store-import.ts`).
 */

import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import {
  type DeviceIdentityKeyRecord,
  type DeviceKeyTimeBounds,
  clampDeviceKeyTime,
  deviceKeyField,
  winningDeviceKey,
} from "@opensesame/vault-core";
import {
  readStoredDeviceIdentityKey,
  withDeviceIdentityFence,
  writeStoredDeviceIdentityKey,
} from "./device-identity-key.js";
import { vetCarriedKey } from "./device-identity-trust.js";
import { setStatusNotice } from "./notices.js";

/** What the store lends the reconcile: its open tomb and the body's key field. */
export type KeyCarryHost = Readonly<{
  tomb: string;
  /** False for a guest or scratch tomb: nothing there is exported or synced. */
  carries: boolean;
  field(): BoundaryValue;
  /**
   * The window a key of this vault's is dated in: from a day before the vault
   * was made to now. The body's key is read inside it, and a key dated outside
   * it is brought in before it is ranked or published.
   */
  bounds(): DeviceKeyTimeBounds;
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

/**
 * `held`: the caller already holds the tomb's identity lock (a merge writes
 * the body and levels the key in one step), so this does not take it again.
 */
export type KeyCarryOptions = Readonly<{ held?: boolean }>;

const CHANGED_ID = "device-identity-changed";

/** Why a person is told this vault's principal is not what it was, or is not the backup's. */
export type IdentityChange =
  | "ranked"
  | "restored"
  | "restored-without-key"
  | "restored-unusable"
  | "own-unreadable";

const NOTICES = {
  ranked: {
    title: "Device identity changed",
    body: "This vault already carried an older identity key, so this device uses it now. Sessions that used the previous one have ended.",
  },
  restored: {
    title: "Device identity changed",
    body: "You took the backup's identity key, so this device uses it now. Sessions that used the previous one have ended.",
  },
  "restored-without-key": {
    title: "Restored without an identity key",
    body: "That backup carries no identity key, so this vault keeps its own. Its principal differs from the one the backup was made under.",
  },
  "restored-unusable": {
    title: "Identity key not taken",
    body: "That backup's identity key is one this device cannot use, so this vault keeps its own. Its principal differs from the one the backup was made under.",
  },
  "own-unreadable": {
    title: "Identity key not taken",
    body: "This device's own identity key could not be read, so the backup's was not taken and the record was left as it was.",
  },
} as const satisfies Record<IdentityChange, { title: string; body: string }>;

/** Tell the person, in the bell, what became of the principal. */
export function noteDeviceIdentityChanged(cause: IdentityChange): void {
  setStatusNotice({ id: CHANGED_ID, tone: "info", ...NOTICES[cause] });
}

async function reconcileLocked(host: KeyCarryHost): Promise<KeyCarryOutcome> {
  let local: DeviceIdentityKeyRecord | null;
  try {
    local = await readStoredDeviceIdentityKey(host.tomb);
  } catch {
    return "kept";
  }
  const bounds = host.bounds();
  const vetted = await vetCarriedKey(host.field(), bounds);
  if (vetted.kind === "future") return "kept";
  // Poison is no key: the body is treated as holding none.
  const carried = vetted.kind === "trusted" ? vetted.record : null;
  if (local === null) {
    if (carried === null) return "none";
    await writeStoredDeviceIdentityKey(host.tomb, carried);
    return "adopted";
  }
  const mine = clampDeviceKeyTime(local, bounds);
  if (carried === null) {
    await host.publish(deviceKeyField(mine));
    return "published";
  }
  if (mine.keyId === carried.keyId) return "same";
  if (winningDeviceKey(mine, carried) === carried) {
    await writeStoredDeviceIdentityKey(host.tomb, carried);
    noteDeviceIdentityChanged("ranked");
    return "replaced";
  }
  await host.publish(deviceKeyField(mine));
  return "published";
}

/** Bring the tomb's key and the body's level. Idempotent; safe in two tabs. */
export async function reconcileDeviceIdentityKey(
  host: KeyCarryHost,
  options: KeyCarryOptions = {},
): Promise<KeyCarryOutcome> {
  if (!host.carries) return "skipped";
  return options.held
    ? reconcileLocked(host)
    : withDeviceIdentityFence(host.tomb, () => reconcileLocked(host));
}
