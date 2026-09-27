/**
 * One vault item ↔ one sealed-store entry (ADR 0037 §6). Line one is the
 * secret, as `pass` reads it; the trailer is one JSON line of OpenSesame
 * metadata, plus a bare `otpauth://` line when the item has one, so `pass
 * otp` works on the sealed entry.
 *
 * Format 2 (`"v":2`) carries the whole item — every named property, custom
 * fields concealed or not, notes and the star — so any kind comes back as
 * itself. A first-format entry (no `v`, written before) still reads: a
 * login, a secret, a note or a typed item whole, and anything else as its own
 * kind with line one in place. Concealed values go nowhere but line one and
 * the trailer.
 */
import { isString, overlapCast } from "@opensesame/os-domain";
import {
  type Folder,
  type LegacyItemKind,
  type TypedItem,
  type VaultItem,
  createItem,
  definitionFor,
  newId,
} from "@opensesame/vault-core";
import {
  type OsMeta,
  type StorePlainEntry,
  TRAILER_FORMAT,
  extractOtpauthFromTrailer,
  isWholeItemMeta,
  joinStorePath,
  mergeOtpauthIntoTrailer,
  parseTrailerMeta,
  splitStorePath,
} from "./store-sync-entry.js";
import {
  LINE_ONE,
  applyNamedValues,
  customFieldsIn,
  customFieldsOut,
  isOneLine,
  legacyKindOf,
  lineOneValue,
  namedValues,
} from "./store-sync-values.js";

function typedFromMeta(meta: OsMeta, typeId: string, name: string): TypedItem {
  // A plugin-defined item comes back whole, whether or not this device has
  // the definition: an unknown type is a presentation gap, never data loss.
  const item: TypedItem = overlapCast(createItem("note", name));
  item.kind = "typed";
  item.typeId = typeId;
  item.values = overlapCast(meta.values ?? {});
  item.notes = meta.notes ?? "";
  return item;
}

function builtInFromMeta(
  entry: StorePlainEntry,
  meta: OsMeta,
  kind: LegacyItemKind,
  name: string,
): VaultItem {
  const item = createItem(kind, name);
  if (item.kind === "note") {
    item.notes = [entry.secret, meta.notes ?? ""].filter(Boolean).join("\n");
    return item;
  }
  const lineOne = LINE_ONE[kind];
  if (lineOne !== null) {
    const props: Record<string, string> = overlapCast(item);
    props[lineOne] = entry.secret;
  }
  item.notes = meta.notes ?? "";
  if (item.kind === "login") {
    item.username = meta.username ?? "";
    item.totp = extractOtpauthFromTrailer(entry.trailer) ?? meta.totp ?? "";
    item.uris = (meta.uris ?? []).map((uri, index) => ({
      id: newId(),
      uri,
      match: meta.uriMatches?.[index] ?? "domain",
    }));
  }
  if (item.kind === "secret") item.connectionRef = meta.connectionRef ?? "";
  applyNamedValues(item, meta.values);
  return item;
}

export function entryToVaultItem(
  entry: StorePlainEntry,
  folderId: string | null = null,
): VaultItem {
  const { name } = splitStorePath(entry.path);
  const meta = parseTrailerMeta(entry.trailer);
  const item =
    meta.kind === "typed" && isString(meta.typeId)
      ? typedFromMeta(meta, meta.typeId, name)
      : builtInFromMeta(entry, meta, legacyKindOf(meta.kind), name);
  item.folderId = folderId;
  if (isWholeItemMeta(meta)) {
    item.fields = customFieldsIn(meta.fields);
    item.favorite = meta.favorite === true;
  }
  return item;
}

/** Line one for a typed item: the field its definition nominated, if any. */
function typedLineOne(item: TypedItem): string {
  const secretField = definitionFor(item)?.spec.native.secret;
  const nominated =
    secretField === undefined || secretField === null
      ? undefined
      : item.values[secretField];
  return isString(nominated) ? nominated : "";
}

/** The keys a built-in kind has had a place for since the first format. */
function describeKind(item: VaultItem, meta: OsMeta): string | null {
  if (item.kind === "typed") {
    // Every value rides in `values`, line one included.
    meta.typeId = item.typeId;
    meta.values = item.values;
    return null;
  }
  if (item.kind === "login") {
    meta.username = item.username || undefined;
    const totp = item.totp.trim();
    const otpauth = /^otpauth:\/\//iu.test(totp) ? totp : null;
    if (item.totp && otpauth === null) meta.totp = item.totp;
    meta.uris = item.uris.map((u) => u.uri).filter(Boolean);
    meta.uriMatches = item.uris.filter((u) => u.uri).map((u) => u.match);
    return otpauth;
  }
  if (item.kind === "secret") {
    meta.connectionRef = item.connectionRef || undefined;
  }
  return null;
}

/** The store entry for one item (`vaultItemToEntry` in `store-sync.ts`). */
export function itemToStoreEntry(
  item: VaultItem,
  folders: Folder[],
): StorePlainEntry {
  const folder = item.folderId
    ? (folders.find((f) => f.id === item.folderId)?.name ?? null)
    : null;
  const path = joinStorePath(folder, item.name);
  const line = item.kind === "typed" ? typedLineOne(item) : lineOneValue(item);
  // A value with a line break cannot be line one without splitting the entry
  // when `pass seal` writes it; it travels in the trailer, and line one stays
  // empty, the way a type with no secret field projects (ADR 0087 §3).
  const secret = isOneLine(line) ? line : "";
  const meta: OsMeta = {
    kind: item.kind,
    v: TRAILER_FORMAT,
    notes: item.notes || undefined,
  };
  // A note's body is its line one; it stays in `notes` only when it cannot be.
  if (item.kind === "note" && secret !== "") meta.notes = undefined;
  const otpauth = describeKind(item, meta);
  meta.values ??= namedValues(item);
  meta.fields = customFieldsOut(item.fields);
  meta.favorite = item.favorite || undefined;

  const jsonTrailer = `${JSON.stringify(meta)}\n`;
  const trailer = mergeOtpauthIntoTrailer(jsonTrailer, otpauth);
  return { path, secret, trailer };
}
