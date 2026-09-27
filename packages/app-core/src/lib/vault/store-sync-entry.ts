/**
 * The text half of the sealed-store bridge (ADR 0037 §6): what one store
 * entry is, how its path splits into a folder and a name, and how its
 * trailer carries a `pass-otp` line beside OpenSesame's JSON metadata.
 * Nothing here knows an item kind; `store-sync-codec.ts` does.
 */
import {
  type JsonObject,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import type { UriMatch } from "@opensesame/vault-core";
import type { FieldValues } from "@opensesame/vault-item-types";

export type StorePlainEntry = {
  path: string;
  secret: string;
  trailer: string;
};

/** A custom field as a trailer carries it: no id, which is the vault's own. */
export type StoreCustomField = {
  name: string;
  value: string;
  hidden: boolean;
};

export type OsMeta = {
  kind?: string;
  /**
   * The trailer format. Absent on every entry Pages wrote before kinds
   * round-tripped (format 1: a login, a secret, a note or a typed item whole,
   * and only line one of anything else). `2` says the entry is the whole
   * item: its named values, its custom fields and its notes.
   */
  v?: number;
  username?: string;
  totp?: string;
  uris?: string[];
  uriMatches?: UriMatch[];
  notes?: string;
  connectionRef?: string;
  /**
   * Preserve all plugin values in JSON metadata (ADR 0087). Omitting them
   * reconstructs an empty item, which a whole-vault merge would propagate.
   * Format 2 also uses it for a built-in kind's named properties that have no
   * key of their own above (a card's holder, a certificate's PEMs).
   */
  typeId?: string;
  values?: FieldValues | JsonObject;
  /** The item's custom fields, concealed ones included (format 2). */
  fields?: StoreCustomField[];
  /** Starred; absent when not (format 2). */
  favorite?: boolean;
};

/** The trailer format this build writes. */
export const TRAILER_FORMAT = 2;

/** First otpauth:// line in a pass-otp style trailer, if any. */
export function extractOtpauthFromTrailer(trailer: string): string | null {
  for (const line of trailer.split(/\r?\n/u)) {
    const t = line.trim();
    if (/^otpauth:\/\//iu.test(t)) return t;
  }
  return null;
}

/** Drop otpauth lines from trailer text. */
export function stripOtpauthFromTrailer(trailer: string): string {
  return trailer
    .split(/\r?\n/u)
    .filter((line) => !/^otpauth:\/\//iu.test(line.trim()))
    .join("\n");
}

/** Ensure trailer contains exactly one otpauth line when totp is set. */
export function mergeOtpauthIntoTrailer(
  trailer: string,
  otpauth: string | null | undefined,
): string {
  const without = stripOtpauthFromTrailer(trailer).replace(/\n+$/u, "");
  if (!otpauth?.trim()) {
    return without ? `${without}\n` : "";
  }
  const uri = otpauth.trim();
  if (!without) return `${uri}\n`;
  return `${without}\n${uri}\n`;
}

/** Split `Email/github.com` into folder + name. */
export function splitStorePath(path: string) {
  const trimmed = path.replace(/^\/+|\/+$/gu, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) {
    return { folder: null, name: trimmed || "untitled" };
  }
  return {
    folder: trimmed.slice(0, idx),
    name: trimmed.slice(idx + 1) || "untitled",
  };
}

export function joinStorePath(folder: string | null, name: string): string {
  const n = name.trim() || "untitled";
  const f = folder?.trim();
  if (!f) return n;
  return `${f}/${n}`;
}

/** A store path as a merge compares it: no stray slashes, no case. */
export function normalizedStorePath(path: string): string {
  return path
    .replace(/^\/+|\/+$/gu, "")
    .trim()
    .toLowerCase();
}

/** Parse an OpenSesame JSON trailer after a blank line, if present. */
export function parseTrailerMeta(trailer: string): OsMeta {
  const withoutOtp = stripOtpauthFromTrailer(trailer);
  const text = withoutOtp.trim();
  if (!text.startsWith("{")) return { notes: text || undefined };
  try {
    const parsed: JsonObject[string] = JSON.parse(text);
    if (!isJsonObject(parsed)) return { notes: text };
    return overlapCast(parsed);
  } catch {
    return { notes: text || undefined };
  }
}

/** True when the trailer says it carries the whole item (format 2 or later). */
export function isWholeItemMeta(meta: OsMeta): boolean {
  return (meta.v ?? 1) >= TRAILER_FORMAT;
}

/**
 * Project-scoped store paths — keep entries under `projectFolder/` or bare
 * names when the folder is null (personal / default).
 */
export function filterEntriesForProject(
  entries: StorePlainEntry[],
  projectFolder: string | null,
): StorePlainEntry[] {
  if (!projectFolder?.trim()) return entries;
  const folder = projectFolder.trim().replace(/\/+$/u, "");
  const prefix = `${folder}/`;
  return entries.filter((entry) => {
    const path = entry.path.replace(/^\/+/u, "");
    return path === folder || path.startsWith(prefix);
  });
}
