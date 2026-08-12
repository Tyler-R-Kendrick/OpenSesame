/**
 * Bitwarden, both export shapes.
 *
 * The JSON export is the complete one: folders, item types, custom fields with
 * their hidden flag, per-URI match rules, and TOTP. The CSV drops types other
 * than login and note, so it is offered as a fallback rather than a peer.
 */

import type { UriMatch } from "../../model.js";
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

/** Bitwarden's numeric match rules. Ours has no startsWith or regex. */
const URI_MATCH: Record<number, UriMatch> = {
  0: "domain",
  1: "host",
  2: "exact", // startsWith — closest honest neighbour
  3: "exact",
  4: "exact", // regex — we cannot evaluate one, so pin it
  5: "never",
};

type BwUri = { uri?: unknown; match?: unknown };
type BwField = { name?: unknown; value?: unknown; type?: unknown };
type BwItem = {
  type?: unknown;
  name?: unknown;
  notes?: unknown;
  favorite?: unknown;
  folderId?: unknown;
  fields?: unknown;
  login?: unknown;
  card?: unknown;
  identity?: unknown;
  creationDate?: unknown;
  revisionDate?: unknown;
};
type BwExport = {
  encrypted?: unknown;
  folders?: unknown;
  items?: unknown;
};

function isBitwardenJson(json: unknown): json is BwExport {
  if (!json || typeof json !== "object") return false;
  const candidate = json as BwExport;
  return Array.isArray(candidate.items) && "encrypted" in candidate;
}

export const bitwardenJson: ImportAdapter = {
  id: "bitwarden-json",
  label: "Bitwarden (.json)",
  shortName: "Bitwarden",
  hint: "Bitwarden → Tools → Export vault → file format .json, unencrypted.",
  accepts: "text",

  detect: ({ json }) => isBitwardenJson(json),

  parse: ({ json }): ParseResult => {
    if (!isBitwardenJson(json)) {
      throw new Error("That file is not a Bitwarden JSON export.");
    }
    if (json.encrypted === true) {
      throw new Error(
        "That export is password-protected. Re-export from Bitwarden with encryption turned off, or decrypt it first.",
      );
    }

    const folderNames = new Map<string, string>();
    for (const raw of Array.isArray(json.folders) ? json.folders : []) {
      const folder = raw as { id?: unknown; name?: unknown };
      if (typeof folder.id === "string" && typeof folder.name === "string") {
        folderNames.set(folder.id, folder.name);
      }
    }

    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];
    const warnings: string[] = [];
    let identityCount = 0;

    for (const raw of json.items as unknown[]) {
      const bw = raw as BwItem;
      const name = asString(bw.name) || "Untitled";
      const folder =
        typeof bw.folderId === "string"
          ? (folderNames.get(bw.folderId) ?? null)
          : null;

      let item: DraftItem | null = null;

      switch (bw.type) {
        case 1: {
          const login = (bw.login ?? {}) as {
            username?: unknown;
            password?: unknown;
            totp?: unknown;
            uris?: unknown;
          };
          const draft = draftLogin(name);
          draft.username = asString(login.username);
          draft.password = asString(login.password);
          draft.totp = normaliseTotp(asString(login.totp));
          for (const rawUri of Array.isArray(login.uris) ? login.uris : []) {
            const entry = rawUri as BwUri;
            const match =
              typeof entry.match === "number"
                ? (URI_MATCH[entry.match] ?? "domain")
                : "domain";
            addUri(draft, asString(entry.uri), match);
          }
          item = draft;
          break;
        }
        case 2:
          item = draftNote(name);
          break;
        case 3: {
          const card = (bw.card ?? {}) as Record<string, unknown>;
          const draft = draftCard(name);
          draft.cardholder = asString(card.cardholderName);
          draft.brand = asString(card.brand);
          draft.number = asString(card.number);
          draft.expMonth = asString(card.expMonth);
          draft.expYear = asString(card.expYear);
          draft.code = asString(card.code);
          item = draft;
          break;
        }
        case 4: {
          // We have no identity type. Rather than drop the record, keep it as a
          // note whose fields hold every populated value.
          identityCount += 1;
          const identity = (bw.identity ?? {}) as Record<string, unknown>;
          const draft = draftNote(name);
          for (const [key, value] of Object.entries(identity)) {
            addField(draft, humanise(key), asString(value), isSensitive(key));
          }
          item = draft;
          break;
        }
        default:
          skipped.push({
            name,
            reason: `Unsupported Bitwarden item type ${String(bw.type)}.`,
          });
          continue;
      }

      item.folder = folder;
      item.favorite = bw.favorite === true;
      item.notes = asString(bw.notes);
      item.createdAt = toIso(bw.creationDate);
      item.updatedAt = toIso(bw.revisionDate);

      for (const rawField of Array.isArray(bw.fields) ? bw.fields : []) {
        const field = rawField as BwField;
        addField(
          item,
          asString(field.name),
          asString(field.value),
          field.type === 1,
        );
      }

      items.push(item);
    }

    if (identityCount > 0) {
      warnings.push(
        `${identityCount} ${identityCount === 1 ? "identity was" : "identities were"} imported as secure notes, because this vault has no identity type. Every value is kept as a field.`,
      );
    }

    return { source: "bitwarden-json", items, skipped, warnings };
  },
};

const CSV_HEADERS = ["name", "login_username", "login_password"];

export const bitwardenCsv: ImportAdapter = {
  id: "bitwarden-csv",
  label: "Bitwarden (.csv)",
  shortName: "Bitwarden",
  hint: "Bitwarden → Tools → Export vault → file format .csv.",
  accepts: "text",

  detect: ({ headers }) => headers !== null && hasHeaders(headers, CSV_HEADERS),

  parse: ({ text }): ParseResult => {
    const { rows } = parseCsv(text);
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];

    for (const row of rows) {
      const name = pick(row, "name") || "Untitled";
      const type = pick(row, "type").toLowerCase();
      const isNote = type === "note" || type === "securenote";

      const item: DraftItem = isNote ? draftNote(name) : draftLogin(name);
      if (item.kind === "login") {
        item.username = pick(row, "login_username");
        item.password = pick(row, "login_password");
        item.totp = normaliseTotp(pick(row, "login_totp"));
        for (const uri of pick(row, "login_uri").split(",")) addUri(item, uri);
      }

      item.folder = pick(row, "folder") || null;
      item.favorite = pick(row, "favorite") === "1";
      item.notes = pick(row, "notes");
      // Bitwarden packs custom fields as newline-separated "name: value".
      for (const line of pick(row, "fields").split("\n")) {
        const at = line.indexOf(":");
        if (at > 0) addField(item, line.slice(0, at), line.slice(at + 1));
      }

      items.push(item);
    }

    return {
      source: "bitwarden-csv",
      items,
      skipped,
      warnings: [
        "A Bitwarden CSV carries only logins and notes. Export as .json instead to bring cards, identities, and the hidden flag on custom fields.",
      ],
    };
  },
};

function humanise(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/^./u, (c) => c.toUpperCase());
}

function isSensitive(key: string): boolean {
  return /ssn|passport|licence|license|number/iu.test(key);
}
