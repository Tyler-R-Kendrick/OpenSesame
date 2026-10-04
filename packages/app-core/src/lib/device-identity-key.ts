/**
 * The device identity key (ADR 0160, ADR 0138 §1): a P-256 key sealed in the
 * vault's VFS whose RFC 7638 thumbprint is this vault's principal.
 *
 * One key per tomb, created the first time the device host needs a principal
 * for that vault and then read back. The private half never leaves this file
 * as anything but a ciphertext in the tomb (`config/device-identity-key`); the
 * public record carries the thumbprint and public JWK only. The record has the
 * same JWK shape as a `siop-keys` record, so a later change that signs with
 * it (ADR 0138) is not a migration. Nothing here prompts a passkey: it runs
 * inside a vault the person has already unlocked.
 *
 * `siop-keys` holds *pairwise* keys, one per (person, application), minted
 * for a relying party; the principal needs the root they are derived beside,
 * so it is its own record. This file cannot import `@opensesame/siop-v2`
 * (owned by `identity.siop`), so the thumbprint is computed here and a test
 * pins it to siop-v2's.
 *
 * The key travels (ADR 0160 §5): a copy rides in the sealed vault body, so an
 * offline backup, a sync and a restore carry it, and a device that opens the
 * vault with no key of its own adopts the carried one instead of minting. The
 * body is reached through `device-identity-carrier.ts`; reconciling the two
 * copies at unlock, merge and restore is `device-identity-carry.ts`.
 */

import { isString } from "@opensesame/os-domain";
import {
  DEVICE_IDENTITY_KEY_PATH,
  DEVICE_KEY_CLOCK_MARGIN_MS,
  type DeviceIdentityKeyRecord,
  deviceKeyField,
} from "@opensesame/vault-core";
import { lockManager } from "../ports.js";
import { deviceKeyCarrier } from "./device-identity-carrier.js";
import {
  p256JwkThumbprint,
  trustedDeviceKey,
  vetCarriedKey,
} from "./device-identity-trust.js";
import { kvRefresh } from "./kv.js";
import {
  VfsError,
  deleteFile,
  readFile,
  tombFileKey,
  writeFile,
} from "./vfs.js";

export { p256JwkThumbprint };

const PATH = DEVICE_IDENTITY_KEY_PATH;
const MAX_BYTES = 8192;

/** The public half, in the shape a JWK carries it. */
export type DevicePublicJwk = Readonly<{
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}>;

export type DeviceIdentityKey = Readonly<{
  /** `prn_` + the RFC 7638 thumbprint of the public key. */
  principalId: string;
  /** The thumbprint alone. */
  keyId: string;
  publicJwk: DevicePublicJwk;
  createdAt: number;
}>;

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

function unreadable(message = "The device identity key is unreadable."): never {
  throw new DeviceIdentityKeyError("unreadable", message);
}

function parseBytes(
  bytes: Uint8Array,
): Promise<DeviceIdentityKeyRecord | null> {
  try {
    return trustedDeviceKey(
      JSON.parse(new TextDecoder().decode(bytes)),
      Number.MAX_SAFE_INTEGER - DEVICE_KEY_CLOCK_MARGIN_MS,
    );
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
    unreadable("The device identity key record is not one this build trusts.");
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

async function mint(): Promise<DeviceIdentityKeyRecord> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!isString(pub.x) || !isString(pub.y) || !isString(priv.d)) unreadable();
  const publicJwk = { kty: "EC", crv: "P-256", x: pub.x, y: pub.y } as const;
  return {
    version: 1,
    keyId: await p256JwkThumbprint(publicJwk),
    publicJwk,
    privateJwkJson: JSON.stringify({ ...publicJwk, d: priv.d, alg: "ES256" }),
    createdAt: Date.now(),
  };
}

function view(stored: DeviceIdentityKeyRecord): DeviceIdentityKey {
  return {
    principalId: `prn_${stored.keyId}`,
    keyId: stored.keyId,
    publicJwk: stored.publicJwk,
    createdAt: stored.createdAt,
  };
}

/**
 * Read the key if there is one; never mints. Throws `VfsError("locked")` while
 * the tomb is shut and `DeviceIdentityKeyError("unreadable")` for a record it
 * cannot trust.
 */
export async function readDeviceIdentityKey(
  tomb: string,
): Promise<DeviceIdentityKey | null> {
  const stored = await readStoredDeviceIdentityKey(tomb);
  return stored ? view(stored) : null;
}

/**
 * The key the vault body carries for `tomb`, if it is one this build trusts.
 * A record of a newer version is `unreadable`: something else owns it, so none
 * is minted beside it. Poison (a forged or malformed record) is no key at all:
 * it is treated as absent, and a mint replaces it in the body.
 */
async function carriedKey(
  tomb: string,
): Promise<DeviceIdentityKeyRecord | null> {
  const carried = await vetCarriedKey(deviceKeyCarrier.carried(tomb));
  if (carried.kind === "future") {
    unreadable("The vault carries an identity key of a newer version.");
  }
  return carried.kind === "trusted" ? carried.record : null;
}

/** Put a key in the body, and carry on if that cannot be done: the key works. */
async function publishQuietly(
  tomb: string,
  record: DeviceIdentityKeyRecord,
): Promise<void> {
  try {
    await deviceKeyCarrier.publish(tomb, deviceKeyField(record));
  } catch {
    // The tomb's copy is sealed and good; the next unlock puts it in the body.
  }
}

/**
 * The tomb has no key. Take the one the vault carries (a restore, a second
 * device) or, with nothing carried, mint one, and only with a lock to mint
 * under. Re-reads first: another tab may have won.
 */
async function adoptOrMint(
  tomb: string,
  mayMint: boolean,
): Promise<DeviceIdentityKey> {
  const existing = await readStoredDeviceIdentityKey(tomb);
  if (existing) return view(existing);
  const carried = await carriedKey(tomb);
  if (carried) {
    await writeStoredDeviceIdentityKey(tomb, carried);
    return view(carried);
  }
  // Two tabs that both miss and both mint leave one key on disk and a loser
  // holding a principal that is not the vault's. With no cross-tab fence
  // nothing is minted, as every comparable fence here refuses.
  if (!mayMint) {
    throw new DeviceIdentityKeyError(
      "no-fence",
      "This browser has no cross-tab lock, so no device identity key is created.",
    );
  }
  const minted = await mint();
  await writeStoredDeviceIdentityKey(tomb, minted);
  await publishQuietly(tomb, minted);
  return view(minted);
}

async function ensure(tomb: string): Promise<DeviceIdentityKey> {
  // An existing key is read-only business and needs no fence, and a read never
  // writes the vault body: a tab answering Connect may be stale, and the body
  // is put right at unlock, after a merge and at a mint, from the disk's copy.
  const existing = await readStoredDeviceIdentityKey(tomb);
  if (existing) return view(existing);
  const mayMint = lockManager() !== undefined;
  return withDeviceIdentityFence(tomb, () => adoptOrMint(tomb, mayMint));
}

const inFlight = new Map<string, Promise<DeviceIdentityKey>>();

/**
 * The vault's identity key: the tomb's, else the one the vault body carries,
 * else a fresh one, sealed on first use. Throws `VfsError("locked")` while the
 * tomb is locked and `DeviceIdentityKeyError` (`unreadable` or `no-fence`) when
 * it cannot be had; it never overwrites a record it cannot read and never
 * mints without a Web Lock. This tab dedupes its own concurrent callers; the
 * lock makes it one key across tabs.
 */
export function ensureDeviceIdentityKey(
  tomb: string,
): Promise<DeviceIdentityKey> {
  const pending = inFlight.get(tomb);
  if (pending) return pending;
  const settled = ensure(tomb).finally(() => {
    if (inFlight.get(tomb) === settled) inFlight.delete(tomb);
  });
  inFlight.set(tomb, settled);
  return settled;
}

/**
 * Test seam: forget this tab's in-flight reads, so a test can stand two
 * callers side by side as two tabs would be (each has its own).
 */
export function forgetDeviceIdentityKeyInFlightForTests(): void {
  inFlight.clear();
}
