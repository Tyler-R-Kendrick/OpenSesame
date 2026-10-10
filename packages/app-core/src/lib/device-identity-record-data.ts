/** Existing identity record IO and error contracts; extraction preserves original producer lock order. */
import {
  DEVICE_IDENTITY_KEY_PATH,
  DEVICE_KEY_CLOCK_MARGIN_MS,
  type DeviceIdentityKeyRecord,
} from "@opensesame/vault-core";
import { lockManager } from "../ports.js";
import { trustedDeviceKey } from "./device-identity-trust.js";
import { kvRefresh } from "./kv.js";
import {
  VfsError,
  deleteFile,
  readFile,
  tombFileKey,
  writeFile,
} from "./vfs.js";
const PATH = DEVICE_IDENTITY_KEY_PATH;
const MAX_BYTES = 8192;
/**
 * Why a key could not be had. `unreadable`: a record is there and cannot be
 * trusted (unknown version, wrong shape, a key id that is not its key's
 * thumbprint), and it is never overwritten. `no-fence`: there is no record and
 * no cross-tab lock to mint one under, so none is minted.
 */
export type DeviceIdentityKeyFault = "unreadable" | "no-fence";

export class DeviceIdentityKeyError extends Error {
  readonly code: DeviceIdentityKeyFault;
  constructor(code: DeviceIdentityKeyFault, message: string) {
    super(message);
    this.name = "DeviceIdentityKeyError";
    this.code = code;
  }
}

export function refuseUnreadableIdentityRecordData(
  message = "The device identity key is unreadable.",
): never {
  throw new DeviceIdentityKeyError("unreadable", message);
}

function parseBytes(
  bytes: Uint8Array,
): Promise<DeviceIdentityKeyRecord | null> {
  try {
    return trustedDeviceKey(JSON.parse(new TextDecoder().decode(bytes)), {
      now: Number.MAX_SAFE_INTEGER - DEVICE_KEY_CLOCK_MARGIN_MS,
    });
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * The tomb's own copy, verified; null when there is none. Throws
 * `VfsError("locked")` while the tomb is shut and
 * `DeviceIdentityKeyError("unreadable")` for a record it cannot trust.
 */
export async function readStoredDeviceIdentityKey(
  tomb: string,
): Promise<DeviceIdentityKeyRecord | null> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(tomb, PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
  // A record that is not genuine (a key id that is not its public key's
  // thumbprint, a private half that is not its public key's) is corrupt, and a
  // principal must never be derived from a record that lies.
  const stored = bytes.length > MAX_BYTES ? null : await parseBytes(bytes);
  if (!stored) {
    refuseUnreadableIdentityRecordData(
      "The device identity key record is not one this build trusts.",
    );
  }
  return stored;
}

/** Seal `record` as the tomb's key. The caller holds the fence or has no mint to race. */
export async function writeStoredDeviceIdentityKey(
  tomb: string,
  record: DeviceIdentityKeyRecord,
): Promise<void> {
  await writeFile(tomb, PATH, new TextEncoder().encode(JSON.stringify(record)));
}

/**
 * Put the tomb's key back as it was (`null`: there was none), after a step that
 * replaced it could not finish. A failure here is not swallowed: a tomb left
 * holding a key its body does not carry is worse than a loud error.
 */
export async function restoreStoredDeviceIdentityKey(
  tomb: string,
  previous: DeviceIdentityKeyRecord | null,
): Promise<void> {
  if (previous) await writeStoredDeviceIdentityKey(tomb, previous);
  else await deleteFile(tomb, PATH);
}

/**
 * Run `work` inside the tomb's identity lock, or bare when the browser has
 * none. Minting needs the lock (the caller refuses without it); adopting and
 * reconciling are deterministic and idempotent, so two tabs doing them agree.
 */
export function withDeviceIdentityFence<T>(
  tomb: string,
  work: () => Promise<T>,
): Promise<T> {
  const locks = lockManager();
  return locks
    ? locks.request(`opensesame-device-identity-${tomb}`, work)
    : work();
}
