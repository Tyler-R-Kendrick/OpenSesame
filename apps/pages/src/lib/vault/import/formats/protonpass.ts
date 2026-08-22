import {
  type JsonObject,
  type JsonValue,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Proton Pass JSON export.
 *
 * Vaults are an object keyed by id rather than an array, and an item's state
 * field is what marks it as trashed.
 */

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

type ProtonExport = JsonObject & {
  vaults: JsonObject;
  encrypted?: JsonValue;
  version?: JsonValue;
};

function isProtonExport(json: unknown): json is ProtonExport {
  if (
    typeof json !== "object" ||
    json === null ||
    Array.isArray(json) ||
    !("vaults" in json)
  )
    return false;
  const vaults = json.vaults;
  if (typeof vaults !== "object" || vaults === null || Array.isArray(vaults)) {
    return false;
  }
  return Object.values(vaults).some(
    (vault) => typeof vault === "object" && vault !== null && "items" in vault,
  );
}

export const protonpassJson: ImportAdapter = {
  id: "protonpass-json",
  label: "Proton Pass (.json)",
  shortName: "Proton Pass",
  hint: "Proton Pass → Settings → Export → JSON, unencrypted.",
  accepts: "text",

  detect: ({ json }) => isProtonExport(json),

  parse: ({ json }): ParseResult => {
    if (!isProtonExport(json)) {
      throw new Error("That file is not a Proton Pass export.");
    }
    if (json.encrypted === true) {
      throw new Error(
        "That export is encrypted. Re-export from Proton Pass as unencrypted JSON.",
      );
    }

    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];
    const warnings: string[] = [];
    let trashed = 0;
    let aliases = 0;

    for (const rawVault of Object.values(json.vaults)) {
      const vault: JsonObject = overlapCast(rawVault);
      const vaultName = asString(vault.name);

      for (const rawItem of Array.isArray(vault.items) ? vault.items : []) {
        const entry: JsonObject = overlapCast(rawItem);
        // State 2 is trashed.
        if (entry.state === 2) {
          trashed += 1;
          continue;
        }

        const data: JsonObject = overlapCast(entry.data ?? {});
        const metadata: JsonObject = overlapCast(data.metadata ?? {});
        const content: JsonObject = overlapCast(data.content ?? {});
        const name = asString(metadata.name) || "Untitled";
        const type = asString(data.type);

        let item: DraftItem;
        if (type === "creditCard") {
          const card = draftCard(name);
          card.cardholder = asString(content.cardholderName);
          card.number = asString(content.number);
          card.code = asString(content.verificationNumber);
          // Proton writes expiry as MMYYYY.
          const expiry = asString(content.expirationDate);
          const match = /^(\d{2})(\d{4})$/u.exec(expiry);
          if (match) {
            card.expMonth = match[1] ?? "";
            card.expYear = match[2] ?? "";
          }
          addField(card, "PIN", asString(content.pin), true);
          item = card;
        } else if (type === "login") {
          const login = draftLogin(name);
          login.username =
            asString(content.itemUsername) ||
            asString(content.itemEmail) ||
            asString(content.username);
          login.password = asString(content.password);
          login.totp = normaliseTotp(asString(content.totpUri));
          for (const url of Array.isArray(content.urls) ? content.urls : []) {
            addUri(login, asString(url));
          }
          const passkeys = Array.isArray(content.passkeys)
            ? content.passkeys
            : [];
          if (passkeys.length > 0) {
            addField(
              login,
              "Passkeys",
              `${passkeys.length} passkey${passkeys.length === 1 ? "" : "s"} could not be moved; a passkey's private key never leaves the device that made it.`,
            );
          }
          item = login;
        } else if (type === "alias") {
          aliases += 1;
          const alias = draftNote(name);
          addField(alias, "Alias address", asString(entry.aliasEmail));
          item = alias;
        } else {
          item = draftNote(name);
        }

        item.folder = vaultName || null;
        item.notes = asString(metadata.note);
        item.favorite = entry.pinned === true;
        item.createdAt = toIso(entry.createTime);
        item.updatedAt = toIso(entry.modifyTime);

        for (const rawField of Array.isArray(data.extraFields)
          ? data.extraFields
          : []) {
          const field: JsonObject = overlapCast(rawField);
          const fieldData: JsonObject = overlapCast(field.data ?? {});
          const fieldType = asString(field.type);
          const value =
            asString(fieldData.content) || asString(fieldData.totpUri);
          if (
            fieldType === "totp" &&
            item.kind === "login" &&
            item.totp === ""
          ) {
            item.totp = normaliseTotp(value);
            continue;
          }
          addField(
            item,
            asString(field.fieldName),
            value,
            fieldType === "hidden",
          );
        }

        items.push(item);
      }
    }

    if (trashed > 0) {
      warnings.push(
        `${trashed} ${trashed === 1 ? "item was" : "items were"} in the Proton Pass trash and were not imported.`,
      );
    }
    if (aliases > 0) {
      warnings.push(
        `${aliases} email ${aliases === 1 ? "alias" : "aliases"} became notes. Aliases keep forwarding from Proton; this vault only records the address.`,
      );
    }

    return { source: "protonpass-json", items, skipped, warnings };
  },
};
