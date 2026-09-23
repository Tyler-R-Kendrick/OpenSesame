import { overlapCast } from "@opensesame/os-domain";
/**
 * The remaining CSV-exporting managers: LastPass, KeePass and KeePassXC,
 * Dashlane, and NordPass.
 *
 * Each has a quirk worth naming. LastPass marks a secure note by giving it the
 * sentinel url `http://sn`. KeePass 2.x and KeePassXC share a product but not a
 * schema. Dashlane exports several files, one per item type. NordPass puts
 * logins, cards, and notes in one file with mostly empty columns.
 */

import { hostOf } from "../../model.js";
import { hasHeaders, parseCsv, pick } from "../csv.js";
import {
  type DraftItem,
  type ParseResult,
  type SkippedRecord,
  type TextImportAdapter,
  addField,
  addUri,
  draftCard,
  draftLogin,
  draftNote,
  normaliseTotp,
} from "../types.js";

/** LastPass writes nested folders with a backslash; ours are flat. */
function flattenGroup(group: string): string | null {
  const trimmed = group.trim();
  if (trimmed === "") return null;
  return trimmed.replace(/\\/gu, " / ");
}

export const lastpassCsv: TextImportAdapter = {
  id: "lastpass-csv",
  label: "LastPass (.csv)",
  shortName: "LastPass",
  hint: "LastPass → Advanced Options → Export → LastPass CSV File.",
  accepts: "text",

  detect: ({ headers }) =>
    headers !== null &&
    hasHeaders(headers, ["url", "username", "password", "name"]) &&
    (headers.includes("grouping") || headers.includes("extra")),

  parse: ({ text }): ParseResult => {
    const { rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];

    for (const row of rows) {
      const url = pick(row, "url");
      const name = pick(row, "name") || hostOf(url) || "Untitled";
      const notes = pick(row, "extra");
      const isNote = url === "http://sn" || url === "https://sn";

      const item: DraftItem = isNote ? draftNote(name) : draftLogin(name);
      if (item.kind === "login") {
        item.username = pick(row, "username");
        item.password = pick(row, "password");
        item.totp = normaliseTotp(pick(row, "totp"));
        addUri(item, url);
      }

      // A LastPass secure note packs typed content into `extra` as
      // "NoteType:...\nkey:value" lines. Keep the fields, not the wrapper.
      if (isNote && notes.includes("\n") && /^\w+:/u.test(notes)) {
        for (const line of notes.split("\n")) {
          const at = line.indexOf(":");
          if (at <= 0) continue;
          const key = line.slice(0, at);
          const value = line.slice(at + 1);
          if (key === "Notes") item.notes = value;
          else addField(item, key, value, /password|pin|code/iu.test(key));
        }
      } else {
        item.notes = notes;
      }

      item.folder = flattenGroup(pick(row, "grouping"));
      item.favorite = pick(row, "fav") === "1";
      items.push(item);
    }

    return { source: "lastpass-csv", items, skipped, warnings: [] };
  },
};

export const keepassxcCsv: TextImportAdapter = {
  id: "keepassxc-csv",
  label: "KeePassXC (.csv)",
  shortName: "KeePassXC",
  hint: "KeePassXC → Database → Export → CSV file.",
  accepts: "text",

  detect: ({ headers }) =>
    headers !== null &&
    hasHeaders(headers, ["group", "title", "username", "password"]),

  parse: ({ text }): ParseResult => {
    const { rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];

    for (const row of rows) {
      const url = pick(row, "url");
      const item = draftLogin(pick(row, "title") || hostOf(url) || "Untitled");
      item.username = pick(row, "username");
      item.password = pick(row, "password");
      item.totp = normaliseTotp(pick(row, "totp"));
      item.notes = pick(row, "notes");
      addUri(item, url);
      // KeePassXC prefixes every group with the database's root node.
      item.folder = flattenGroup(pick(row, "group").replace(/^Root\//u, ""));
      items.push(item);
    }

    return { source: "keepassxc-csv", items, skipped, warnings: [] };
  },
};

export const keepassCsv: TextImportAdapter = {
  id: "keepass-csv",
  label: "KeePass 2.x (.csv)",
  shortName: "KeePass",
  hint: "KeePass → File → Export → CSV (KeePass 2.x).",
  accepts: "text",

  detect: ({ headers }) =>
    headers !== null &&
    hasHeaders(headers, ["account", "login name", "password"]),

  parse: ({ text }): ParseResult => {
    const { rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];

    for (const row of rows) {
      const url = pick(row, "web site");
      const item = draftLogin(
        pick(row, "account") || hostOf(url) || "Untitled",
      );
      item.username = pick(row, "login name");
      item.password = pick(row, "password");
      item.notes = pick(row, "comments");
      addUri(item, url);
      items.push(item);
    }

    return { source: "keepass-csv", items, skipped, warnings: [] };
  },
};

export const dashlaneCsv: TextImportAdapter = {
  id: "dashlane-csv",
  label: "Dashlane (.csv)",
  shortName: "Dashlane",
  hint: "Dashlane → My Account → Settings → Export data → CSV. It produces one file per type; import each in turn.",
  accepts: "text",

  detect: ({ headers }) => {
    if (headers === null) return false;
    const credentials =
      hasHeaders(headers, ["title", "password"]) &&
      (headers.includes("otpsecret") || headers.includes("username2"));
    const payments = hasHeaders(headers, ["account_name", "cc_number"]);
    const notes = hasHeaders(headers, ["title", "note"]) && headers.length <= 2;
    return credentials || payments || notes;
  },

  parse: ({ text }): ParseResult => {
    const { headers, rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];
    const isPayments = hasHeaders(headers, ["account_name", "cc_number"]);
    const isNotes =
      hasHeaders(headers, ["title", "note"]) && headers.length <= 2;

    for (const row of rows) {
      if (isPayments) {
        const item = draftCard(pick(row, "account_name") || "Card");
        item.cardholder = pick(row, "account_holder");
        item.number = pick(row, "cc_number");
        item.code = pick(row, "code");
        item.expMonth = pick(row, "expiration_month");
        item.expYear = pick(row, "expiration_year");
        item.brand = pick(row, "type");
        addField(item, "Issuing bank", pick(row, "issuing_bank"));
        items.push(item);
        continue;
      }

      if (isNotes) {
        const item = draftNote(pick(row, "title") || "Note");
        item.notes = pick(row, "note");
        items.push(item);
        continue;
      }

      const url = pick(row, "url");
      const item = draftLogin(pick(row, "title") || hostOf(url) || "Untitled");
      item.username = pick(row, "username", "email");
      item.password = pick(row, "password");
      item.totp = normaliseTotp(pick(row, "otpsecret"));
      item.notes = pick(row, "note");
      item.folder = pick(row, "category") || null;
      addUri(item, url);
      // Dashlane allows several sign-in identifiers per credential.
      addField(item, "Alternate username", pick(row, "username2"));
      addField(item, "Alternate username", pick(row, "username3"));
      items.push(item);
    }

    return {
      source: "dashlane-csv",
      items,
      skipped,
      warnings:
        isPayments || isNotes
          ? []
          : [
              "Dashlane exports one CSV per item type. This file held credentials — import the payments and secure notes files separately to bring those too.",
            ],
    };
  },
};

export const nordpassCsv: TextImportAdapter = {
  id: "nordpass-csv",
  label: "NordPass (.csv)",
  shortName: "NordPass",
  hint: "NordPass → Settings → Export items.",
  accepts: "text",

  detect: ({ headers }) =>
    headers !== null &&
    hasHeaders(headers, ["name", "url", "username", "password"]) &&
    (headers.includes("cardnumber") || headers.includes("folder")),

  parse: ({ text }): ParseResult => {
    const { rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];

    for (const row of rows) {
      const name = pick(row, "name") || "Untitled";
      const cardNumber = pick(row, "cardnumber");
      const url = pick(row, "url");
      const password = pick(row, "password");

      let item: DraftItem;
      if (cardNumber) {
        const card = draftCard(name);
        card.number = cardNumber;
        card.cardholder = pick(row, "cardholdername");
        card.code = pick(row, "cvc");
        // NordPass writes the expiry as a single MM/YYYY cell.
        const expiry = pick(row, "expirydate");
        const match = /^(\d{1,2})\s*\/\s*(\d{2,4})$/u.exec(expiry);
        if (match) {
          card.expMonth = overlapCast(match[1]);
          card.expYear = overlapCast(match[2]);
        }
        addField(card, "Postcode", pick(row, "zipcode"));
        item = card;
      } else if (password || url || pick(row, "username")) {
        const login = draftLogin(name);
        login.username = pick(row, "username");
        login.password = password;
        addUri(login, url);
        item = login;
      } else {
        item = draftNote(name);
        for (const key of [
          "full_name",
          "phone_number",
          "email",
          "address1",
          "address2",
          "city",
          "state",
          "country",
        ]) {
          addField(item, key.replace(/_/gu, " "), pick(row, key));
        }
      }

      item.notes = pick(row, "note");
      item.folder = pick(row, "folder") || null;
      items.push(item);
    }

    return { source: "nordpass-csv", items, skipped, warnings: [] };
  },
};
