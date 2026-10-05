/**
 * Enpass JSON export (Enpass 6: File → Export → .json).
 *
 * Every item is a title, a category and a flat list of typed fields — the
 * login's username, password, URL and one-time code are fields like any
 * other, told apart by `type`. A card's are `cc*` fields. Section headers
 * are fields too, with no value. Folders are listed once, by uuid, and an
 * item names the ones it sits in. Trashed items are skipped; attachments,
 * which the JSON carries inline, are left behind with a warning.
 */
import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type DraftCard,
  type DraftItem,
  type DraftLogin,
  type ParseResult,
  type SkippedRecord,
  type TextImportAdapter,
  addField,
  addUri,
  asString,
  draftCard,
  draftLogin,
  draftNote,
  normaliseTotp,
  toIso,
} from "../types.js";

type EnpassField = {
  type: string;
  label: string;
  value: string;
  sensitive: boolean;
};

function fieldsOf(item: JsonObject): EnpassField[] {
  const raw = Array.isArray(item.fields) ? item.fields : [];
  const fields: EnpassField[] = [];
  for (const entry of raw) {
    if (!isJsonObject(entry) || entry.deleted === 1) continue;
    fields.push({
      type: asString(entry.type),
      label: asString(entry.label),
      value: asString(entry.value),
      sensitive: entry.sensitive === 1 || entry.sensitive === true,
    });
  }
  return fields;
}

/** An Enpass item: a title, and fields that each say what they are. */
function looksLikeItem(value: JsonValue | undefined): boolean {
  return (
    isJsonObject(value) &&
    "title" in value &&
    Array.isArray(value.fields) &&
    ("template_type" in value || "category" in value)
  );
}

function isEnpassExport(json: BoundaryValue): json is JsonObject {
  if (!isJsonObject(json) || !Array.isArray(json.items)) return false;
  const [first] = json.items;
  return json.items.length === 0
    ? Array.isArray(json.folders)
    : looksLikeItem(first);
}

/** The first value of a field of `type`, and the rest left for custom fields. */
function take(fields: EnpassField[], ...types: string[]): string {
  const index = fields.findIndex(
    (field) => types.includes(field.type) && field.value.trim() !== "",
  );
  if (index === -1) return "";
  const [field] = fields.splice(index, 1);
  return field?.value ?? "";
}

function loginFrom(name: string, fields: EnpassField[]): DraftLogin {
  const login = draftLogin(name);
  login.username = take(fields, "username") || take(fields, "email");
  login.password = take(fields, "password");
  login.totp = normaliseTotp(take(fields, "totp"));
  for (let url = take(fields, "url"); url !== ""; url = take(fields, "url")) {
    addUri(login, url);
  }
  return login;
}

/** `MM/YY`, `MM/YYYY` or `MMYY`, as Enpass's expiry field holds it. */
function setExpiry(card: DraftCard, expiry: string): void {
  const match = /^(\d{1,2})\s*\/?\s*(\d{2}|\d{4})$/u.exec(expiry.trim());
  if (!match) return;
  card.expMonth = (match[1] ?? "").padStart(2, "0");
  const year = match[2] ?? "";
  card.expYear = year.length === 2 ? `20${year}` : year;
}

function cardFrom(name: string, fields: EnpassField[]): DraftCard {
  const card = draftCard(name);
  card.cardholder = take(fields, "ccName");
  card.number = take(fields, "ccNumber");
  card.code = take(fields, "ccCvc");
  card.brand = take(fields, "ccType");
  setExpiry(card, take(fields, "ccExpiry"));
  return card;
}

function draftFrom(category: string, name: string, fields: EnpassField[]) {
  if (category === "login" || category === "password")
    return loginFrom(name, fields);
  if (category === "creditcard") return cardFrom(name, fields);
  return draftNote(name);
}

function folderNames(json: JsonObject): Map<string, string> {
  const names = new Map<string, string>();
  for (const folder of Array.isArray(json.folders) ? json.folders : []) {
    if (!isJsonObject(folder)) continue;
    const id = asString(folder.uuid);
    if (id) names.set(id, asString(folder.title));
  }
  return names;
}

function itemFrom(entry: JsonObject, folders: Map<string, string>): DraftItem {
  const name = asString(entry.title) || "Untitled";
  const fields = fieldsOf(entry);
  const item = draftFrom(asString(entry.category), name, fields);
  for (const field of fields) {
    if (field.type === "section") continue;
    addField(item, field.label || field.type, field.value, field.sensitive);
  }
  const folderId = Array.isArray(entry.folders)
    ? asString(entry.folders[0])
    : "";
  item.folder = folders.get(folderId) || null;
  item.notes = asString(entry.note);
  item.favorite = entry.favorite === 1 || entry.favorite === true;
  item.createdAt = toIso(entry.createdAt);
  item.updatedAt = toIso(entry.updated_at);
  return item;
}

export const enpassJson: TextImportAdapter = {
  id: "enpass-json",
  label: "Enpass (.json)",
  shortName: "Enpass",
  hint: "Enpass → File → Export → .json format.",
  accepts: "text",

  detect: ({ json }) => isEnpassExport(json),

  parse: ({ json }): ParseResult => {
    if (!isEnpassExport(json)) {
      throw new Error("That file is not an Enpass export.");
    }
    const folders = folderNames(json);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];
    const warnings: string[] = [];
    let trashed = 0;
    let attachments = 0;
    for (const raw of Array.isArray(json.items) ? json.items : []) {
      if (!looksLikeItem(raw)) continue;
      const entry: JsonObject = overlapCast(raw);
      if (entry.trashed === 1 || entry.trashed === true) {
        trashed += 1;
        continue;
      }
      attachments += Array.isArray(entry.attachments)
        ? entry.attachments.length
        : 0;
      items.push(itemFrom(entry, folders));
    }
    if (trashed > 0) {
      warnings.push(
        `${trashed} ${trashed === 1 ? "item was" : "items were"} in the Enpass trash, and not imported.`,
      );
    }
    if (attachments > 0) {
      warnings.push(
        `${attachments} ${attachments === 1 ? "attachment was" : "attachments were"} left behind. Add each again as a File item.`,
      );
    }
    return { source: "enpass-json", items, skipped, warnings };
  },
};
