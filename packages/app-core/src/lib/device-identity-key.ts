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
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { sha256Base64Url } from "@opensesame/sdk-browser";
import { lockManager } from "../ports.js";
import { kvRefresh } from "./kv.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/device-identity-key";
const MAX_BYTES = 8192;
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;

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

type Stored = {
  version: 1;
  keyId: string;
  publicJwk: DeviceIdentityKey["publicJwk"];
  /** Serialized private JWK; confidentiality is the vault VFS layer. */
  privateJwkJson: string;
  createdAt: number;
};

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

/** RFC 7638: SHA-256 over the required members, in lexicographic order. */
export function p256JwkThumbprint(
  jwk: Pick<DevicePublicJwk, "x" | "y">,
): Promise<string> {
  return sha256Base64Url(
    JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }),
  );
}

function parseStored(value: BoundaryValue): Stored | null {
  if (!isJsonObject(value) || value.version !== 1) return null;
  const pub = value.publicJwk;
  if (
    !isString(value.keyId) ||
    !THUMBPRINT.test(value.keyId) ||
    !isString(value.privateJwkJson) ||
    !isNumber(value.createdAt) ||
    !Number.isSafeInteger(value.createdAt) ||
    !isJsonObject(pub) ||
    pub.kty !== "EC" ||
    pub.crv !== "P-256" ||
    !isString(pub.x) ||
    !isString(pub.y)
  ) {
    return null;
  }
  return {
    version: 1,
    keyId: value.keyId,
    publicJwk: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y },
    privateJwkJson: value.privateJwkJson,
    createdAt: value.createdAt,
  };
}

function parseBytes(bytes: Uint8Array): Stored | null {
  try {
    return parseStored(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

async function read(tomb: string): Promise<Stored | null> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(tomb, PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
  const stored = bytes.length > MAX_BYTES ? null : parseBytes(bytes);
  // A record whose key id is not its public key's thumbprint is corrupt, and
  // a principal must never be derived from a record that lies.
  if (!stored || stored.keyId !== (await p256JwkThumbprint(stored.publicJwk))) {
    unreadable("The device identity key record is not one this build trusts.");
  }
  return stored;
}

async function mint(): Promise<Stored> {
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

function view(stored: Stored): DeviceIdentityKey {
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
  const stored = await read(tomb);
  return stored ? view(stored) : null;
}

/** Mint only inside the fence, re-reading first: another tab may have won. */
async function mintUnderFence(tomb: string): Promise<DeviceIdentityKey> {
  const existing = await read(tomb);
  if (existing) return view(existing);
  const minted = await mint();
  await writeFile(tomb, PATH, new TextEncoder().encode(JSON.stringify(minted)));
  return view(minted);
}

async function ensure(tomb: string): Promise<DeviceIdentityKey> {
  // An existing key is read-only business and needs no fence.
  const existing = await readDeviceIdentityKey(tomb);
  if (existing) return existing;
  const locks = lockManager();
  // Two tabs that both miss and both mint leave one key on disk and a loser
  // holding a principal that is not the vault's. With no cross-tab fence
  // nothing is minted, as every comparable fence here refuses.
  if (!locks) {
    throw new DeviceIdentityKeyError(
      "no-fence",
      "This browser has no cross-tab lock, so no device identity key is created.",
    );
  }
  return locks.request(`opensesame-device-identity-${tomb}`, () =>
    mintUnderFence(tomb),
  );
}

const inFlight = new Map<string, Promise<DeviceIdentityKey>>();

/**
 * The vault's identity key, created and sealed on first use. Throws
 * `VfsError("locked")` while the tomb is locked and `DeviceIdentityKeyError`
 * (`unreadable` or `no-fence`) when it cannot be had; it never overwrites a
 * record it cannot read and never mints without a Web Lock. This tab dedupes
 * its own concurrent callers; the lock makes it one key across tabs.
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
