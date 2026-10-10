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
  type DeviceIdentityKeyRecord,
  deviceKeyField,
} from "@opensesame/vault-core";
import { lockManager } from "../ports.js";
import { deviceKeyCarrier } from "./device-identity-carrier.js";
import {
  DeviceIdentityKeyError,
  readStoredDeviceIdentityKey,
  refuseUnreadableIdentityRecordData as unreadable,
  withDeviceIdentityFence,
  writeStoredDeviceIdentityKey,
} from "./device-identity-record-data.js";
import { p256JwkThumbprint, vetCarriedKey } from "./device-identity-trust.js";
export {
  DeviceIdentityKeyError,
  type DeviceIdentityKeyFault,
  readStoredDeviceIdentityKey,
  restoreStoredDeviceIdentityKey,
  withDeviceIdentityFence,
  writeStoredDeviceIdentityKey,
} from "./device-identity-record-data.js";

export { p256JwkThumbprint };

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
  const carried = await vetCarriedKey(
    deviceKeyCarrier.carried(tomb),
    deviceKeyCarrier.bounds(tomb),
  );
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
