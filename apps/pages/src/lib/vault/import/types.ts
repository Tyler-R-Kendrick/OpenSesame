import { type BoundaryValue, isNumber, isString } from "@opensesame/os-domain";
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
  | "env-file"
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
  | "keepass-kdbx"
  | "fido-cxf"
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

/**
 * A discovered passkey. The vault never holds the private key — only the
 * public half and the identifiers needed to recognise the credential — so a
 * draft carries exactly what `PasskeyItem` can store and nothing more.
 *
 * Only CXF carries these faithfully; every other export format either drops
 * passkeys outright or flattens them into an unusable note.
 */
export type DraftPasskey = DraftBase & {
  kind: "passkey";
  rpId: string;
  username: string;
  credentialIdB64: string;
  publicKeyB64: string;
  authenticator: "platform" | "cross-platform";
};

export type DraftSecret = DraftBase & {
  kind: "secret";
  value: string;
};

export type DraftItem =
  | DraftLogin
  | DraftPasskey
  | DraftCard
  | DraftNote
  | DraftSecret;

/** A record the adapter understood but declined to import, and why. */
export type SkippedRecord = { name: string; reason: string };

export type ParseResult = {
  source: SourceId;
  items: DraftItem[];
  skipped: SkippedRecord[];
  /** Conditions worth stating once for the whole file rather than per row. */
  warnings: string[];
  /**
   * The file is an encrypted blob and no password was supplied, so there is
   * nothing to preview yet. The adapter returns this instead of items; the
   * caller collects a password and re-parses with `ParseInput.password` set.
   *
   * It is `true | undefined` rather than a boolean so that the common case —
   * a format that never needs one — stays absent from the object entirely and
   * out of every existing snapshot.
   */
  needsPassword?: true;
};

type ImportAdapterBase = {
  id: SourceId;
  label: string;
  /** Product name alone, for folder names and prose. `label` is too long. */
  shortName: string;
  /** What the user should export from that product to produce this file. */
  hint: string;
  /** Cheap structural check. Must not throw on unrelated input. */
  detect(input: DetectInput): boolean;
};

/**
 * A format that is text by the time it reaches the pipeline: a `.env`, a CSV,
 * a JSON export, or the one entry this pipeline pulls out of a `.1pux`
 * archive. Parsing is synchronous, as it has always been.
 */
export type TextImportAdapter = ImportAdapterBase & {
  accepts: "text" | "zip";
  parse(input: ParseInput): ParseResult;
};

/**
 * A format that is a single opaque blob — an encrypted database. Reading one
 * means decrypting it with a codec fetched on demand, so parsing is
 * asynchronous, and the adapter sees `bytes` rather than `text`.
 *
 * Splitting the two apart rather than widening `parse` to a union keeps every
 * text adapter's call sites exactly as synchronous as they were.
 */
export type BinaryImportAdapter = ImportAdapterBase & {
  accepts: "binary";
  parse(input: ParseInput): Promise<ParseResult>;
};

export type ImportAdapter = TextImportAdapter | BinaryImportAdapter;

export type DetectInput = {
  fileName: string;
  text: string;
  /** Present only for CSV-shaped text, so JSON adapters can ignore it. */
  headers: string[] | null;
  json: BoundaryValue;
  /**
   * The raw file, for formats that are not text at all. Non-null exactly when
   * the pipeline routed the file down the binary path, which is also what
   * selects `accepts: "binary"` adapters — so a text adapter never has to
   * consider it, and a binary adapter can rely on it.
   */
  bytes: Uint8Array | null;
};

export type ParseInput = DetectInput & {
  /**
   * Supplied on a re-parse after an adapter answered `needsPassword`. Held in
   * memory for the length of the parse and never stored.
   */
  password?: string;
};

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

export function draftPasskey(name: string): DraftPasskey {
  return {
    ...emptyDraft("passkey", name),
    rpId: "",
    username: "",
    credentialIdB64: "",
    publicKeyB64: "",
    authenticator: "platform",
  };
}

export function draftNote(name: string): DraftNote {
  return emptyDraft("note", name);
}

export function draftSecret(name: string): DraftSecret {
  return {
    ...emptyDraft("secret", name),
    value: "",
  };
}

/**
 * The "this blob is locked" answer, spelled the same way by every adapter so
 * the dispatcher and the import screen have one shape to recognise.
 */
export function passwordRequired(
  source: SourceId,
  warning: string,
): ParseResult {
  return {
    source,
    items: [],
    skipped: [],
    warnings: [warning],
    needsPassword: true,
  };
}

/**
 * Credential ids and public keys reach us base64url-encoded — that is what
 * WebAuthn, CXF, and KeePassXC all write — while the vault's `…B64` fields are
 * standard base64. These two convert between them by rewriting the alphabet
 * and the padding, so a value survives a round trip byte for byte.
 */
export function base64UrlToBase64(value: string): string {
  const swapped = value.replace(/-/gu, "+").replace(/_/gu, "/");
  return swapped + "=".repeat((4 - (swapped.length % 4)) % 4);
}

export function base64ToBase64Url(value: string): string {
  return value.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
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
export function toIso(value: BoundaryValue): string | null {
  if (isNumber(value) && Number.isFinite(value) && value > 0) {
    const ms = value > 1e11 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (isString(value) && value.trim() !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export function asString(value: BoundaryValue): string {
  return isString(value) ? value : "";
}
