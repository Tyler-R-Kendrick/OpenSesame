import { type JsonObject, overlapCast, type BoundaryValue, isTypeofObject, isString, isNumber } from "@opensesame/os-domain";
/**
 * 1Password, both export shapes.
 *
 * The .1pux archive holds `export.data`, whose JSON keeps vaults, categories,
 * sections, and typed field values. The CSV keeps titles, logins, and notes.
 * The archive is unwrapped before it reaches an adapter, so both arrive here
 * as text.
 */

import { hasHeaders, parseCsv, pick } from "../csv.js";
import {
  type DraftItem,
  type ImportAdapter,
  type ParseResult,
  type SkippedRecord,
  addField,
  addUri,
  asString,
  draftCard,
  draftLogin,
  draftNote,
  normaliseTotp,
  toIso,
} from "../types.js";

/** 1Password category uuids. Anything unlisted becomes a note with fields. */
const CATEGORY = {
  login: "001",
  creditCard: "002",
  secureNote: "003",
  identity: "004",
  password: "005",
} as const;

type PuxValue = JsonObject;
type PuxField = {
  title?: unknown;
  designation?: unknown;
  name?: unknown;
  value?: unknown;
};
type PuxSection = { title?: unknown; fields?: unknown };
type PuxItem = {
  uuid?: unknown;
  favIndex?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  trashed?: unknown;
  categoryUuid?: unknown;
  details?: unknown;
  overview?: unknown;
};

type PuxExport = { accounts?: unknown };

function isPuxExport(json: BoundaryValue): json is PuxExport {
  if (!json || !isTypeofObject(json)) return false;
  const accounts = (overlapCast(json)).accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return false;
  const first = overlapCast(accounts[0]);
  return Array.isArray(first?.vaults);
}

/**
 * A 1PUX field value is a single-key object naming its type:
 * `{string}`, `{concealed}`, `{totp}`, `{date}`, `{monthYear}`, `{email}`, …
 */
function readValue(value: BoundaryValue) {
  if (isString(value))
    return { text: value, concealed: false, totp: false };
  if (!value || !isTypeofObject(value)) {
    return { text: "", concealed: false, totp: false };
  }
  const record = overlapCast(value);

  if (isString(record.concealed)) {
    return { text: record.concealed, concealed: true, totp: false };
  }
  if (isString(record.totp)) {
    return { text: record.totp, concealed: true, totp: true };
  }
  if (isNumber(record.monthYear)) {
    // Serialised as YYYYMM.
    return { text: String(record.monthYear), concealed: false, totp: false };
  }
  if (isNumber(record.date)) {
    return { text: toIso(record.date) ?? "", concealed: false, totp: false };
  }
  if (isTypeofObject(record.email) && record.email !== null) {
    const email = (overlapCast(record.email)).email_address;
    return { text: asString(email), concealed: false, totp: false };
  }
  for (const key of [
    "string",
    "url",
    "phone",
    "creditCardNumber",
    "creditCardType",
    "gender",
    "menu",
    "reference",
  ]) {
    const candidate = record[key];
    if (isString(candidate)) {
      return {
        text: candidate,
        concealed: key === "creditCardNumber",
        totp: false,
      };
    }
  }
  if (isTypeofObject(record.address) && record.address !== null) {
    const parts = Object.values(overlapCast(record.address))
      .filter((part): part is string => isString(part) && part !== "")
      .join(", ");
    return { text: parts, concealed: false, totp: false };
  }
  return { text: "", concealed: false, totp: false };
}

export const onepasswordPux: ImportAdapter = {
  id: "1password-1pux",
  label: "1Password (.1pux)",
  shortName: "1Password",
  hint: "1Password → File → Export → the account, as a .1pux archive.",
  accepts: "zip",

  detect: ({ json }) => isPuxExport(json),

  parse: ({ json }): ParseResult => {
    if (!isPuxExport(json)) {
      throw new Error("That archive does not contain a 1Password export.");
    }

    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];
    const warnings: string[] = [];
    let trashed = 0;

    for (const rawAccount of overlapCast(json.accounts)) {
      const account = overlapCast(rawAccount);
      for (const rawVault of Array.isArray(account.vaults)
        ? account.vaults
        : []) {
        const vault = overlapCast(rawVault);
        const vaultName = asString((overlapCast(vault.attrs))?.name);

        for (const rawEntry of Array.isArray(vault.items) ? vault.items : []) {
          const entry = (overlapCast(rawEntry)).item ?? rawEntry;
          const pux = overlapCast(entry);

          if (pux.trashed === true) {
            trashed += 1;
            continue;
          }

          const overview = overlapCast(pux.overview ?? {});
          const details = overlapCast(pux.details ?? {});
          const name = asString(overview.title) || "Untitled";
          const category = asString(pux.categoryUuid);

          let item: DraftItem;
          if (category === CATEGORY.creditCard) {
            item = draftCard(name);
          } else if (
            category === CATEGORY.login ||
            category === CATEGORY.password
          ) {
            item = draftLogin(name);
          } else {
            item = draftNote(name);
          }

          if (item.kind === "login") {
            for (const rawField of Array.isArray(details.loginFields)
              ? details.loginFields
              : []) {
              const field = overlapCast(rawField);
              const designation = asString(field.designation);
              const value = asString(field.value);
              if (designation === "username") item.username = value;
              else if (designation === "password") item.password = value;
            }
            // Category 005 (Password) has no login fields, just a password.
            if (!item.password) item.password = asString(details.password);

            addUri(item, asString(overview.url));
            for (const rawUrl of Array.isArray(overview.urls)
              ? overview.urls
              : []) {
              addUri(item, asString((overlapCast(rawUrl)).url));
            }
          }

          item.folder = vaultName || null;
          item.favorite = isNumber(pux.favIndex) && pux.favIndex > 0;
          item.notes = asString(details.notesPlain);
          item.createdAt = toIso(pux.createdAt);
          item.updatedAt = toIso(pux.updatedAt);

          for (const tag of Array.isArray(overview.tags) ? overview.tags : []) {
            addField(item, "Tag", asString(tag));
          }

          applySections(item, details.sections);
          items.push(item);
        }
      }
    }

    if (trashed > 0) {
      warnings.push(
        `${trashed} ${trashed === 1 ? "item was" : "items were"} in the 1Password trash and were not imported.`,
      );
    }

    return { source: "1password-1pux", items, skipped, warnings };
  },
};

/** Section fields become card details where they fit, custom fields otherwise. */
function applySections(item: DraftItem, sections: BoundaryValue): void {
  for (const rawSection of Array.isArray(sections) ? sections : []) {
    const section = overlapCast(rawSection);
    const sectionTitle = asString(section.title);

    for (const rawField of Array.isArray(section.fields)
      ? section.fields
      : []) {
      const field = overlapCast(rawField);
      const title = asString(field.title) || asString(field.name);
      const { text, concealed, totp } = readValue(field.value);
      if (text === "") continue;

      if (totp && item.kind === "login" && item.totp === "") {
        item.totp = normaliseTotp(text);
        continue;
      }

      if (item.kind === "card") {
        const key = title.toLowerCase();
        if (key.includes("cardholder") || key === "name") {
          item.cardholder = text;
          continue;
        }
        // "verification number" also contains "number", so it must be tested
        // first or the CVV overwrites the card number.
        if (key.includes("verification") || key === "cvv" || key === "cvc") {
          item.code = text;
          continue;
        }
        if (key.includes("number")) {
          item.number = text;
          continue;
        }
        if (key.includes("type") || key.includes("brand")) {
          item.brand = text;
          continue;
        }
        if (key.includes("expir")) {
          // 1Password serialises expiry as YYYYMM.
          const match = /^(\d{4})(\d{2})$/u.exec(text);
          if (match) {
            item.expYear = overlapCast(match[1]);
            item.expMonth = overlapCast(match[2]);
            continue;
          }
        }
      }

      const label = sectionTitle ? `${sectionTitle} · ${title}` : title;
      addField(item, label || "Field", text, concealed);
    }
  }
}

const CSV_HEADERS = ["title", "password"];

export const onepasswordCsv: ImportAdapter = {
  id: "1password-csv",
  label: "1Password (.csv)",
  shortName: "1Password",
  hint: "1Password → File → Export → as CSV. The .1pux archive keeps more.",
  accepts: "text",

  // Safari's CSV also has title/url/username/password/otpauth, so the
  // 1Password-only columns are what separates the two.
  detect: ({ headers }) =>
    headers !== null &&
    hasHeaders(headers, CSV_HEADERS) &&
    (headers.includes("archived") || headers.includes("tags")),

  parse: ({ text }): ParseResult => {
    const { rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];

    for (const row of rows) {
      const name = pick(row, "title") || "Untitled";
      if (pick(row, "archived").toLowerCase() === "true") {
        skipped.push({ name, reason: "Archived in 1Password." });
        continue;
      }

      const password = pick(row, "password");
      const username = pick(row, "username");
      const url = pick(row, "url", "website");

      const item: DraftItem =
        password || username || url ? draftLogin(name) : draftNote(name);

      if (item.kind === "login") {
        item.username = username;
        item.password = password;
        item.totp = normaliseTotp(pick(row, "otpauth", "one-time password"));
        addUri(item, url);
      }

      item.notes = pick(row, "notes");
      item.favorite = pick(row, "favorite").toLowerCase() === "true";
      for (const tag of pick(row, "tags").split(",")) {
        addField(item, "Tag", tag);
      }

      items.push(item);
    }

    return {
      source: "1password-csv",
      items,
      skipped,
      warnings: [
        "A 1Password CSV carries only logins and notes. Export a .1pux archive instead to bring cards, custom sections, and vault names.",
      ],
    };
  },
};
