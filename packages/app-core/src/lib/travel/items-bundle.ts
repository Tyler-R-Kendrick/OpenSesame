/**
 * The items bundle: items an open vault leaves home for a trip, sealed under
 * a return code (ADR 0170).
 *
 * The same family as the vault bundle (`bundle-format.ts`: AES-256-GCM, a key
 * from HKDF over the 144-bit return code salted with the bundle id, the format,
 * version and id bound as AAD) with its own format tag, so one kind of bundle
 * can never be opened as the other. Outside the seal: the tag, the version and
 * a random id — no title, count or date.
 *
 * Inside: each item whole (its own id, times, folder, trash state), the
 * folders those items named, and which vault they left, so a bundle can only
 * go back where it came from. A bundle is read as hostile input.
 */

import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type Folder,
  type SealedBlob,
  type VaultItem,
  openJson,
  sealJson,
} from "@opensesame/vault-core";
import {
  MAX_TRAVEL_BUNDLE_BYTES,
  TravelBundleError,
  newBundleId,
} from "./bundle-format.js";
import { type ReturnSecret, deriveBundleKey } from "./return-code.js";

export const TRAVEL_ITEMS_FORMAT = "opensesame.travel-items";
export const TRAVEL_ITEMS_VERSION = 1;

/** Which open vault the items left: its tomb and the moment it was created. */
export type ItemsVaultRef = Readonly<{ tomb: string; createdAt: string }>;

export type ItemsPayload = Readonly<{
  v: 1;
  bundleId: string;
  hiddenAt: string;
  vault: ItemsVaultRef;
  items: readonly VaultItem[];
  folders: readonly Folder[];
}>;

export { newBundleId };

function binding(bundleId: string): string {
  return `${TRAVEL_ITEMS_FORMAT}:v${TRAVEL_ITEMS_VERSION}:${bundleId}`;
}

/** What an items bundle file is called — no vault, date or count in it. */
export function itemsBundleFileName(bundleId: string): string {
  return `opensesame-${bundleId.replace(/^trv_/, "").slice(0, 8)}.travel-items.json`;
}

const NOT_ITEMS = () =>
  new TravelBundleError("bundle_malformed", "Not a travel bundle.");

export async function sealItemsBundle(
  payload: ItemsPayload,
  secret: ReturnSecret,
): Promise<string> {
  const key = await deriveBundleKey(secret, payload.bundleId);
  const value: BoundaryValue = {
    v: payload.v,
    bundleId: payload.bundleId,
    hiddenAt: payload.hiddenAt,
    vault: { tomb: payload.vault.tomb, createdAt: payload.vault.createdAt },
    items: payload.items.map((item) => overlapCast(item)),
    folders: payload.folders.map((folder) => overlapCast(folder)),
  };
  const sealed = await sealJson(key, value, binding(payload.bundleId));
  return JSON.stringify({
    format: TRAVEL_ITEMS_FORMAT,
    v: TRAVEL_ITEMS_VERSION,
    bundleId: payload.bundleId,
    sealed,
  });
}

/** True when `json` is an items bundle: which sheet to open, before any code. */
export function isItemsBundle(json: string): boolean {
  if (json.length > MAX_TRAVEL_BUNDLE_BYTES) return false;
  try {
    const parsed: BoundaryValue = JSON.parse(json);
    return isJsonObject(parsed) && parsed.format === TRAVEL_ITEMS_FORMAT;
  } catch {
    return false;
  }
}

function readEnvelope(json: string) {
  if (
    json.length > MAX_TRAVEL_BUNDLE_BYTES ||
    new TextEncoder().encode(json).byteLength > MAX_TRAVEL_BUNDLE_BYTES
  ) {
    throw new TravelBundleError(
      "bundle_too_large",
      "That file is larger than any travel bundle.",
    );
  }
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw NOT_ITEMS();
  }
  if (!isJsonObject(parsed) || parsed.format !== TRAVEL_ITEMS_FORMAT) {
    throw NOT_ITEMS();
  }
  if (parsed.v !== TRAVEL_ITEMS_VERSION) {
    throw new TravelBundleError(
      "unsupported_version",
      "This travel bundle was written by a newer version.",
    );
  }
  const sealed = parsed.sealed;
  if (
    !isString(parsed.bundleId) ||
    !isJsonObject(sealed) ||
    !isString(sealed.ivB64) ||
    !isString(sealed.ctB64)
  ) {
    throw NOT_ITEMS();
  }
  const blob: SealedBlob = { ivB64: sealed.ivB64, ctB64: sealed.ctB64 };
  return { bundleId: parsed.bundleId, sealed: blob };
}

/** An item the vault could hold: the fields every kind carries, and nothing it would trip on. */
function readItem(raw: BoundaryValue): VaultItem {
  if (
    !isJsonObject(raw) ||
    !isString(raw.id) ||
    raw.id === "" ||
    !isString(raw.kind) ||
    !isString(raw.name) ||
    !isString(raw.notes) ||
    !isString(raw.createdAt) ||
    !isString(raw.updatedAt) ||
    !(raw.folderId === null || isString(raw.folderId)) ||
    !(raw.deletedAt === null || isString(raw.deletedAt)) ||
    !isBoolean(raw.favorite) ||
    !Array.isArray(raw.fields)
  ) {
    throw NOT_ITEMS();
  }
  return overlapCast(raw);
}

function readFolder(raw: BoundaryValue): Folder {
  if (
    !isJsonObject(raw) ||
    !isString(raw.id) ||
    !isString(raw.name) ||
    !isString(raw.createdAt)
  ) {
    throw NOT_ITEMS();
  }
  return overlapCast(raw);
}

function readVault(raw: BoundaryValue | undefined): ItemsVaultRef {
  if (!isJsonObject(raw) || !isString(raw.tomb) || !isString(raw.createdAt)) {
    throw NOT_ITEMS();
  }
  return { tomb: raw.tomb, createdAt: raw.createdAt };
}

function readList(raw: BoundaryValue | undefined): readonly BoundaryValue[] {
  if (!Array.isArray(raw)) throw NOT_ITEMS();
  return raw;
}

/**
 * Open an items bundle with its return code. A wrong code and a tampered
 * bundle are the same failure: AES-GCM cannot tell them apart, nor can we.
 */
export async function openItemsBundle(
  json: string,
  secret: ReturnSecret,
): Promise<ItemsPayload> {
  const envelope = readEnvelope(json);
  const key = await deriveBundleKey(secret, envelope.bundleId);
  let raw: BoundaryValue;
  try {
    raw = await openJson<BoundaryValue>(
      key,
      envelope.sealed,
      binding(envelope.bundleId),
    );
  } catch {
    throw new TravelBundleError(
      "code_mismatch",
      "That return code does not open this bundle.",
    );
  }
  if (
    !isJsonObject(raw) ||
    raw.v !== 1 ||
    raw.bundleId !== envelope.bundleId ||
    !isString(raw.hiddenAt)
  ) {
    throw NOT_ITEMS();
  }
  const items = readList(raw.items).map(readItem);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw NOT_ITEMS();
  }
  return {
    v: 1,
    bundleId: envelope.bundleId,
    hiddenAt: raw.hiddenAt,
    vault: readVault(raw.vault),
    items,
    folders: readList(raw.folders).map(readFolder),
  };
}
