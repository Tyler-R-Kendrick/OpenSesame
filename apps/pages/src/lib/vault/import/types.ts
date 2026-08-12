/**
 * The shape every importer produces, and the report the user reviews before
 * anything is written.
 *
 * Adapters never build `VaultItem` directly. They emit `DraftItem`, which
 * carries no ids and no timestamps, so the merge step owns identity and the
 * preview can be shown, discarded, or re-parsed without leaving debris.
 */

import type { UriMatch } from "../model.js";

export type SourceId =
  | "opensesame"
  | "bitwarden-json"
  | "bitwarden-csv"
  | "1password-1pux"
  | "1password-csv"
  | "chromium-csv"
  | "apple-csv"
  | "firefox-csv"
  | "lastpass-csv"
  | "keepassxc-csv"
  | "keepass-csv"
  | "dashlane-csv"
  | "nordpass-csv"
  | "protonpass-json"
  | "generic-csv";

export type DraftUri = { uri: string; match: UriMatch };

export type DraftField = { name: string; value: string; hidden: boolean };

type DraftBase = {
  name: string;
  /** Folder name, not an id. The merge step resolves or creates the folder. */
  folder: string | null;
  favorite: boolean;
  notes: string;
  fields: DraftField[];
  /** Source timestamps when the export carried them, else null. */
  createdAt: string | null;
  updatedAt: string | null;
  passwordChangedAt: string | null;
};

export type DraftLogin = DraftBase & {
  kind: "login";
  username: string;
  password: string;
  totp: string;
  uris: DraftUri[];
};

export type DraftCard = DraftBase & {
  kind: "card";
  cardholder: string;
  brand: string;
  number: string;
  expMonth: string;
  expYear: string;
  code: string;
};

export type DraftNote = DraftBase & { kind: "note" };

export type DraftItem = DraftLogin | DraftCard | DraftNote;

/** A record the adapter understood but declined to import, and why. */
export type SkippedRecord = { name: string; reason: string };

export type ParseResult = {
  source: SourceId;
  items: DraftItem[];
  skipped: SkippedRecord[];
  /** Conditions worth stating once for the whole file rather than per row. */
  warnings: string[];
};

export type ImportAdapter = {
  id: SourceId;
  label: string;
  /** Product name alone, for folder names and prose. `label` is too long. */
  shortName: string;
  /** What the user should export from that product to produce this file. */
  hint: string;
  accepts: "text" | "zip";
  /** Cheap structural check. Must not throw on unrelated input. */
  detect(input: DetectInput): boolean;
  parse(input: ParseInput): ParseResult;
};

export type DetectInput = {
  fileName: string;
  text: string;
  /** Present only for CSV-shaped text, so JSON adapters can ignore it. */
  headers: string[] | null;
  json: unknown;
};

export type ParseInput = DetectInput;

export function emptyDraft<K extends DraftItem["kind"]>(
  kind: K,
  name: string,
): DraftBase & { kind: K } {
  return {
    kind,
    name,
    folder: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: null,
    updatedAt: null,
    passwordChangedAt: null,
  };
}

export function draftLogin(name: string): DraftLogin {
  return {
    ...emptyDraft("login", name),
    username: "",
    password: "",
    totp: "",
    uris: [],
  };
}

export function draftCard(name: string): DraftCard {
  return {
    ...emptyDraft("card", name),
    cardholder: "",
    brand: "",
    number: "",
    expMonth: "",
    expYear: "",
    code: "",
  };
}

export function draftNote(name: string): DraftNote {
  return emptyDraft("note", name);
}

/** Drop empty values so a draft never carries a field of nothing. */
export function addField(
  item: DraftItem,
  name: string,
  value: string,
  hidden = false,
): void {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return;
  item.fields.push({ name: name.trim() || "Field", value: trimmed, hidden });
}

export function addUri(
  item: DraftLogin,
  uri: string,
  match: UriMatch = "domain",
): void {
  const trimmed = uri?.trim() ?? "";
  if (trimmed === "") return;
  if (item.uris.some((existing) => existing.uri === trimmed)) return;
  item.uris.push({ uri: trimmed, match });
}

/**
 * Normalise a TOTP value to what the vault stores: either a bare base32 seed
 * or an otpauth:// URI. Exporters variously wrap the seed in a URI, add spaces,
 * or lowercase it, and some emit a placeholder for "no 2FA".
 */
export function normaliseTotp(raw: string): string {
  const value = raw?.trim() ?? "";
  if (value === "") return "";
  if (/^otpauth:\/\//iu.test(value)) return value;
  const compact = value.replace(/[\s-]/gu, "").toUpperCase();
  return /^[A-Z2-7]+=*$/u.test(compact) && compact.length >= 16 ? compact : "";
}

/** Seconds or milliseconds since the epoch, or an ISO string, to ISO. */
export function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e11 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
