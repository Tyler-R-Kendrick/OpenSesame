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
  const response = await driveClientSeams.fetch(`${slotBase(pairing)}/parts`, {
    method: "GET",
    headers: driveHeaders(pairing),
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw refused(response);
  const json = await readJson(response);
  const parts =
    isJsonObject(json) && Array.isArray(json.parts) ? json.parts : [];
  return new Set(parts.filter(isString));
}

export async function readDrivePart(
  pairing: DrivePairing,
  key: string,
): Promise<Uint8Array | null> {
  const response = await driveClientSeams.fetch(partUrl(pairing, key), {
    method: "GET",
    headers: driveHeaders(pairing, "application/octet-stream"),
    credentials: "omit",
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw refused(response);
  return new Uint8Array(await response.arrayBuffer());
}

export async function writeDrivePart(
  pairing: DrivePairing,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  const response = await driveClientSeams.fetch(partUrl(pairing, key), {
    method: "PUT",
    headers: driveHeaders(pairing, "application/octet-stream"),
    credentials: "omit",
    body: bytes,
  });
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
  return {
    async getObject(key) {
      const bytes = await readDrivePart(pairing, key).catch(() => null);
      if (bytes) await local.putObject(key, bytes).catch(() => undefined);
      return bytes;
    },
    async putObject(key, body) {
      await writeDrivePart(pairing, key, body).catch(() => undefined);
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
  const wanted = referencedParts(items);
  if (wanted.size === 0) return 0;
  const held = await listDriveParts(pairing);
  let put = 0;
  for (const key of wanted) {
    if (held.has(key)) continue;
    const bytes = await local.getObject(key);
    if (!bytes) continue;
    await writeDrivePart(pairing, key, bytes);
    put += 1;
  }
  return put;
}
