import {
  type JsonValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type ObjectStore,
  type VaultItem,
  readFileManifest,
} from "@opensesame/vault-core";
/**
 * Attachments over a tailnet drive (ADR 0144).
 *
 * A file in a vault is a manifest inside an item — which the snapshot
 * carries — and encrypted parts kept outside the body, which it does not.
 * The drive keeps those parts beside the slot's snapshot, under the keys the
 * manifests name, and never holds the key that opens them:
 *
 *   GET {slot}/parts           → { parts: [key, …] }
 *   GET {slot}/parts/{key}     → the part's bytes | 404
 *   PUT {slot}/parts/{key}     ← the part's bytes (a key is never replaced)
 *
 * A device puts a new part as the file is sealed, and each sync pass puts any
 * part a manifest names that the drive still lacks (one sealed offline, or
 * before pairing). A device that lacks a part reads it from the drive and
 * keeps it, so a file opened once opens offline after.
 */
import { assertNotDecoySession } from "../decoy-session.js";
import {
  driveClientSeams,
  driveHeaders,
  readJson,
  refused,
  slotBase,
} from "./client.js";
import type { DrivePairing } from "./pairing.js";

function partUrl(pairing: DrivePairing, key: string): string {
  return `${slotBase(pairing)}/parts/${encodeURIComponent(key)}`;
}

export async function listDriveParts(
  pairing: DrivePairing,
): Promise<Set<string>> {
  const generation = assertNotDecoySession();
  const response = await driveClientSeams.fetch(`${slotBase(pairing)}/parts`, {
    method: "GET",
    headers: driveHeaders(pairing),
    credentials: "omit",
    cache: "no-store",
  });
  assertNotDecoySession(generation);
  if (!response.ok) throw refused(response);
  const json = await readJson(response);
  assertNotDecoySession(generation);
  const parts =
    isJsonObject(json) && Array.isArray(json.parts) ? json.parts : [];
  return new Set(parts.filter(isString));
}

export async function readDrivePart(
  pairing: DrivePairing,
  key: string,
): Promise<Uint8Array | null> {
  const generation = assertNotDecoySession();
  const response = await driveClientSeams.fetch(partUrl(pairing, key), {
    method: "GET",
    headers: driveHeaders(pairing, "application/octet-stream"),
    credentials: "omit",
    cache: "no-store",
  });
  assertNotDecoySession(generation);
  if (response.status === 404) return null;
  assertNotDecoySession(generation);
  if (!response.ok) throw refused(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertNotDecoySession(generation);
  return bytes;
}

export async function writeDrivePart(
  pairing: DrivePairing,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  const generation = assertNotDecoySession();
  const response = await driveClientSeams.fetch(partUrl(pairing, key), {
    method: "PUT",
    headers: driveHeaders(pairing, "application/octet-stream"),
    credentials: "omit",
    body: bytes,
  });
  assertNotDecoySession(generation);
  if (!response.ok) throw refused(response);
}

/**
 * The drive as a second store for files. A part read from it is kept in
 * `local`; a part sealed while the drive cannot be reached is left for the
 * next sync pass to put, so sealing a file never waits on the network.
 */
export function driveFileStore(
  pairing: DrivePairing,
  local: ObjectStore,
): ObjectStore {
  const generation = assertNotDecoySession();
  return {
    async getObject(key) {
      assertNotDecoySession(generation);
      const bytes = await readDrivePart(pairing, key).catch(() => null);
      assertNotDecoySession(generation);
      if (bytes) await local.putObject(key, bytes).catch(() => undefined);
      assertNotDecoySession(generation);
      return bytes;
    },
    async putObject(key, body) {
      assertNotDecoySession(generation);
      await writeDrivePart(pairing, key, body).catch(() => undefined);
      assertNotDecoySession(generation);
    },
  };
}

/** Every part key a manifest in these items names, in any field. */
export function referencedParts(items: readonly VaultItem[]): Set<string> {
  const keys = new Set<string>();
  const visit = (value: JsonValue | undefined): void => {
    if (isString(value)) {
      if (!value.startsWith("{")) return;
      for (const part of readFileManifest(value)?.parts ?? [])
        keys.add(part.key);
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else if (isJsonObject(value)) {
      for (const entry of Object.values(value)) visit(entry);
    }
  };
  for (const item of items) visit(overlapCast(item));
  return keys;
}

/**
 * Put every part these items' manifests name that the drive lacks and this
 * device holds. Returns how many went up; a part this device never had (a
 * file sealed elsewhere, not opened here) is the device that sealed it's to
 * put.
 */
export async function putMissingParts(
  pairing: DrivePairing,
  items: readonly VaultItem[],
  local: ObjectStore,
): Promise<number> {
  const generation = assertNotDecoySession();
  const wanted = referencedParts(items);
  if (wanted.size === 0) return 0;
  const held = await listDriveParts(pairing);
  assertNotDecoySession(generation);
  let put = 0;
  for (const key of wanted) {
    if (held.has(key)) continue;
    const bytes = await local.getObject(key);
    assertNotDecoySession(generation);
    if (!bytes) continue;
    await writeDrivePart(pairing, key, bytes);
    assertNotDecoySession(generation);
    put += 1;
  }
  return put;
}
