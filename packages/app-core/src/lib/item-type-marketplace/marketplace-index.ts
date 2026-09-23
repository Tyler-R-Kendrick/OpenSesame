/**
 * The marketplace index — `.opensesame/marketplace.json` (ADR 0134).
 *
 * The same envelope as every other manifest in this repository
 * (`apiVersion` / `kind` / `metadata` / `spec`, ADR 0065 §4), and read the
 * same way: strictly, refusing what it does not know. An index names the
 * item-type definitions it offers as paths inside its own repository, each
 * optionally pinned by SHA-256. It cannot name a URL, so a marketplace can
 * never send this page to a host the person did not type.
 *
 * `spec` is the one level that tolerates keys it does not know: a marketplace
 * may list other things (connectors, one day) beside `itemTypes`, and a
 * client that reads only item types should still read those.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { isSafeRelativePath } from "./source.js";

export const MARKETPLACE_API_VERSION = "opensesame.dev/v1alpha1";
export const MARKETPLACE_KIND = "Marketplace";
export const MAX_INDEX_BYTES = 65_536;
export const MAX_INDEXED_TYPES = 64;

export type IndexedType = {
  /** Repository-relative path of a `VaultItemType` definition. */
  readonly path: string;
  /** Lowercase hex SHA-256 the fetched bytes must match, when pinned. */
  readonly sha256: string | null;
};

export type MarketplaceIndex = {
  readonly name: string;
  readonly description: string;
  readonly itemTypes: readonly IndexedType[];
};

export type IndexParse =
  | { readonly ok: true; readonly index: MarketplaceIndex }
  | { readonly ok: false; readonly message: string };

const SHA256 = /^[0-9a-f]{64}$/;

function refuse(message: string): IndexParse {
  return { ok: false, message };
}

function unknownKey(
  value: JsonObject,
  allowed: readonly string[],
): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

function text(value: BoundaryValue | undefined, max: number): string | null {
  if (value === undefined) return "";
  return isString(value) && value.length <= max ? value.trim() : null;
}

function readEntry(value: BoundaryValue, at: number): IndexedType | string {
  if (!isJsonObject(value)) return `itemTypes[${at}] is not an object`;
  const extra = unknownKey(value, ["path", "sha256"]);
  if (extra !== undefined) return `itemTypes[${at}].${extra} is not allowed`;
  const path = value.path;
  if (!isString(path) || !isSafeRelativePath(path) || !path.endsWith(".json"))
    return `itemTypes[${at}].path must be a relative .json path in the repository`;
  const pin = value.sha256;
  if (pin !== undefined && !(isString(pin) && SHA256.test(pin)))
    return `itemTypes[${at}].sha256 must be 64 lowercase hex characters`;
  return { path, sha256: pin ?? null };
}

function readEntries(value: BoundaryValue | undefined): IndexedType[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INDEXED_TYPES)
    return `spec.itemTypes must list at most ${MAX_INDEXED_TYPES} definitions`;
  const entries: IndexedType[] = [];
  for (const [at, raw] of value.entries()) {
    const entry = readEntry(raw, at);
    if (typeof entry === "string") return entry;
    if (entries.some((seen) => seen.path === entry.path))
      return `itemTypes[${at}].path is listed twice`;
    entries.push(entry);
  }
  return entries;
}

function readMetadata(value: BoundaryValue | undefined) {
  if (!isJsonObject(value)) return "metadata is required";
  const extra = unknownKey(value, ["name", "description"]);
  if (extra !== undefined) return `metadata.${extra} is not allowed`;
  const name = text(value.name, 64);
  const description = text(value.description, 200);
  if (!name) return "metadata.name is required, up to 64 characters";
  if (description === null)
    return "metadata.description is up to 200 characters";
  return { name, description };
}

/** Parse index text. Nothing here fetches or trusts what it reads. */
export function parseMarketplaceIndex(source: string): IndexParse {
  if (new TextEncoder().encode(source).byteLength > MAX_INDEX_BYTES)
    return refuse(`the index exceeds ${MAX_INDEX_BYTES} bytes`);
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(source);
  } catch {
    return refuse("the index is not JSON");
  }
  if (!isJsonObject(parsed)) return refuse("the index is not an object");
  const extra = unknownKey(parsed, ["apiVersion", "kind", "metadata", "spec"]);
  if (extra !== undefined) return refuse(`${extra} is not allowed`);
  if (parsed.apiVersion !== MARKETPLACE_API_VERSION)
    return refuse(`apiVersion must be ${MARKETPLACE_API_VERSION}`);
  if (parsed.kind !== MARKETPLACE_KIND)
    return refuse(`kind must be ${MARKETPLACE_KIND}`);
  const metadata = readMetadata(parsed.metadata);
  if (typeof metadata === "string") return refuse(metadata);
  if (!isJsonObject(parsed.spec)) return refuse("spec is required");
  const itemTypes = readEntries(parsed.spec.itemTypes);
  if (typeof itemTypes === "string") return refuse(itemTypes);
  return { ok: true, index: { ...metadata, itemTypes } };
}
