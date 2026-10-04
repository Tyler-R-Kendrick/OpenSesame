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

export class DeviceIdentityKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceIdentityKeyError";
  }
}

function unavailable(
  message = "The device identity key is unavailable.",
): never {
  throw new DeviceIdentityKeyError(message);
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

async function read(tomb: string): Promise<Stored | null> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES) unavailable();
    const stored = parseStored(JSON.parse(new TextDecoder().decode(bytes)));
    // A record whose key id is not its public key's thumbprint is corrupt,
    // and a principal must never be derived from a record that lies.
    if (
      !stored ||
      stored.keyId !== (await p256JwkThumbprint(stored.publicJwk))
    ) {
      unavailable(
        "The device identity key is corrupt. Restore a vault backup.",
      );
    }
    return stored;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
}

async function mint(): Promise<Stored> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!isString(pub.x) || !isString(pub.y) || !isString(priv.d)) unavailable();
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

const inFlight = new Map<string, Promise<DeviceIdentityKey>>();

async function ensureUnderFence(tomb: string): Promise<DeviceIdentityKey> {
  const existing = await read(tomb);
  if (existing) return view(existing);
  const minted = await mint();
  const bytes = new TextEncoder().encode(JSON.stringify(minted));
  await writeFile(tomb, PATH, bytes);
  return view(minted);
}

/**
 * The vault's identity key, created and sealed on first use. Throws
 * `VfsError("locked")` while the tomb is locked, and
 * `DeviceIdentityKeyError` when the stored record cannot be trusted.
 *
 * Two tabs asking at once take one Web Lock so exactly one mints; without Web
 * Locks the tab still dedupes its own concurrent callers.
 */
export function ensureDeviceIdentityKey(
  tomb: string,
): Promise<DeviceIdentityKey> {
  const pending = inFlight.get(tomb);
  if (pending) return pending;
  const locks = lockManager();
  const run = locks
    ? locks.request(`opensesame-device-identity-${tomb}`, () =>
        ensureUnderFence(tomb),
      )
    : ensureUnderFence(tomb);
  const settled = Promise.resolve(run).finally(() => {
    if (inFlight.get(tomb) === settled) inFlight.delete(tomb);
  });
  inFlight.set(tomb, settled);
  return settled;
}
