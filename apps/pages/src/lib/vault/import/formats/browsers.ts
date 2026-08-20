import { overlapCast } from "@opensesame/os-domain";
/**
 * Browser password exports.
 *
 * Every Chromium browser — Chrome, Edge, Brave, Opera, Vivaldi — writes the
 * same five columns, so they are one adapter rather than four identical ones.
 * Safari and Firefox each write their own.
 */

import { hostOf } from "../../model.js";
import { hasHeaders, parseCsv, pick } from "../csv.js";
import {
  type DraftItem,
  type ImportAdapter,
  type ParseResult,
  type SkippedRecord,
  addField,
  addUri,
  draftLogin,
  draftNote,
  normaliseTotp,
  toIso,
} from "../types.js";

export const chromiumCsv: ImportAdapter = {
  id: "chromium-csv",
  label: "Chrome, Edge, Brave, or Opera (.csv)",
  shortName: "your browser",
  hint: "Chrome: Settings → Autofill → Password Manager → Settings → Download file. Edge: Settings → Passwords → Save/export passwords.",
  accepts: "text",

  // Distinguished from Safari's by the lowercase `name` column; Safari uses
  // `title`. Firefox has no name column at all.
  detect: ({ headers }) =>
    headers !== null &&
    hasHeaders(headers, ["name", "url", "username", "password"]) &&
    !headers.includes("folder") &&
    !headers.includes("grouping") &&
    !headers.includes("login_uri") &&
    !headers.includes("cardnumber"),

  parse: ({ text }): ParseResult => {
    const { rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];

    for (const row of rows) {
      const url = pick(row, "url");
      const name = pick(row, "name") || hostOf(url) || "Untitled";
      const item = draftLogin(name);
      item.username = pick(row, "username");
      item.password = pick(row, "password");
      item.notes = pick(row, "note", "notes");
      addUri(item, url);
      items.push(item);
    }

    return {
      source: "chromium-csv",
      items,
      skipped,
      warnings: [
        "Browser exports carry only site logins — no cards, notes, or 2FA seeds.",
      ],
    };
  },
};

export const appleCsv: ImportAdapter = {
  id: "apple-csv",
  label: "Safari or Apple Passwords (.csv)",
  shortName: "Apple Passwords",
  hint: "Passwords app → File → Export All Passwords. Or Safari → Settings → Passwords → Export.",
  accepts: "text",

  detect: ({ headers }) =>
    headers !== null &&
    hasHeaders(headers, ["title", "url", "username", "password"]) &&
    !headers.includes("archived") &&
    !headers.includes("tags") &&
    !headers.includes("group"),

  parse: ({ text }): ParseResult => {
    const { rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];

    for (const row of rows) {
      const url = pick(row, "url");
      const name = pick(row, "title") || hostOf(url) || "Untitled";
      const item = draftLogin(name);
      item.username = pick(row, "username");
      item.password = pick(row, "password");
      item.totp = normaliseTotp(pick(row, "otpauth"));
      item.notes = pick(row, "notes");
      addUri(item, url);
      items.push(item);
    }

    return { source: "apple-csv", items, skipped, warnings: [] };
  },
};

export const firefoxCsv: ImportAdapter = {
  id: "firefox-csv",
  label: "Firefox (.csv)",
  shortName: "Firefox",
  hint: "Firefox → Passwords → the ⋯ menu → Export Logins.",
  accepts: "text",

  detect: ({ headers }) =>
    headers !== null &&
    hasHeaders(headers, ["url", "username", "password"]) &&
    (headers.includes("guid") || headers.includes("httprealm")),

  parse: ({ text }): ParseResult => {
    const { rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];

    for (const row of rows) {
      const url = pick(row, "url");
      // Firefox stores no title, so the host is the only name available.
      const item = draftLogin(hostOf(url) || url || "Untitled");
      item.username = pick(row, "username");
      item.password = pick(row, "password");
      item.createdAt = toIso(Number(pick(row, "timecreated")) || null);
      item.passwordChangedAt = toIso(
        Number(pick(row, "timepasswordchanged")) || null,
      );
      addUri(item, url);
      // An HTTP auth realm changes what the credential is for, so it is worth
      // keeping rather than discarding as browser bookkeeping.
      addField(item, "HTTP realm", pick(row, "httprealm"));
      items.push(item);
    }

    return {
      source: "firefox-csv",
      items,
      skipped,
      warnings: [
        "Firefox exports no titles, so each item is named after its site. Rename them here if you like.",
      ],
    };
  },
};

export const genericCsv: ImportAdapter = {
  id: "generic-csv",
  label: "Any other CSV",
  shortName: "a CSV file",
  hint: "Any CSV with recognisable columns — a name or title, a url, a username, and a password.",
  accepts: "text",

  // Deliberately last in the chain: it accepts anything with a password-ish
  // column, so it must only ever run once every named format has declined.
  // The test is the resolver itself, so detection and parsing cannot drift
  // into disagreeing about what counts as a readable column.
  detect: ({ headers }) => {
    if (headers === null) return false;
    const { keys } = resolveColumns(headers);
    return (
      keys.password !== null &&
      (keys.name !== null || keys.user !== null || keys.url !== null)
    );
  },

  parse: ({ text }): ParseResult => {
    const { headers, rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];

    const { keys, claimed } = resolveColumns(headers);
    const { name: nameKey, user: userKey, password: passKey } = keys;
    const {
      url: urlKey,
      note: noteKey,
      folder: folderKey,
      totp: totpKey,
    } = keys;

    for (const row of rows) {
      const url = urlKey ? pick(row, urlKey) : "";
      const name =
        (nameKey ? pick(row, nameKey) : "") || hostOf(url) || "Untitled";
      const password = passKey ? pick(row, passKey) : "";
      const username = userKey ? pick(row, userKey) : "";

      const item: DraftItem =
        password || username || url ? draftLogin(name) : draftNote(name);

      if (item.kind === "login") {
        item.username = username;
        item.password = password;
        if (totpKey) item.totp = normaliseTotp(pick(row, totpKey));
        addUri(item, url);
      }
      if (noteKey) item.notes = pick(row, noteKey);
      if (folderKey) item.folder = pick(row, folderKey) || null;

      for (const header of headers) {
        if (header === "" || claimed.has(header)) continue;
        addField(item, header, pick(row, header));
      }

      items.push(item);
    }

    return {
      source: "generic-csv",
      items,
      skipped,
      warnings: [
        "This file did not match a known export, so columns were matched by name. Check the preview before importing.",
      ],
    };
  },
};

type ColumnRole =
  | "name"
  | "user"
  | "password"
  | "url"
  | "note"
  | "folder"
  | "totp";

/** Exact spellings first, then looser ones, per role. */
const COLUMN_PATTERNS = {
  name: [/^(name|title|account|item|entry)$/u, /name|title/u],
  password: [/^(password|passwd|pass)$/u, /pass(word)?|secret/u],
  user: [
    /^(username|user|login|email|e-mail|user name|user id|userid|login name|login id|sign-?in|sign in)$/u,
    /user|login|email|sign.?in/u,
  ],
  url: [
    /^(url|uri|website|site|web address|link)$/u,
    /url|uri|website|web ?address/u,
  ],
  totp: [/^(totp|otp|otpauth|otpsecret|otp secret|2fa)$/u, /totp|otpauth/u],
  note: [
    /^(note|notes|comment|comments|extra|remark|remarks|description)$/u,
    /note|comment|remark/u,
  ],
  folder: [/^(folder|group|grouping|category|collection|vault)$/u, null],
};

/**
 * Assign each role a column, at most once.
 *
 * Claiming matters: a header like "Site Name" satisfies both the name and the
 * url pattern, and without claiming it would end up as both the item's title
 * and its web address.
 */
function resolveColumns(headers: string[]) {
  const roles = overlapCast(Object.keys(COLUMN_PATTERNS));
  const keys = overlapCast(Object.fromEntries(roles.map((role) => [role, null])));
  const claimed = new Set<string>();

  for (const pass of [0, 1] as const) {
    for (const role of roles) {
      if (keys[role] !== null) continue;
      const pattern = COLUMN_PATTERNS[role][pass];
      if (!pattern) continue;
      const found = headers.find(
        (header) =>
          header !== "" && !claimed.has(header) && pattern.test(header),
      );
      if (found) {
        keys[role] = found;
        claimed.add(found);
      }
    }
  }

  return { keys, claimed };
}
