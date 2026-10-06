/**
 * Credential Exchange Format (CXF) export.
 *
 * CXF is the FIDO Alliance's Proposed Standard (August 2025) for moving
 * credentials between password managers. It is the only interchange format
 * that models a passkey as a passkey rather than flattening it into a note,
 * which is why it is the one this vault writes.
 *
 * # Threat model — read before touching this file
 *
 * Unlike `offline-backup.ts`, which emits ciphertext, **a CXF document is
 * plaintext**. Every password, TOTP seed, card number, and secret value in the
 * vault is in it, in the clear, in a file the user then has sitting in their
 * downloads folder.
 *
 * That makes this a human-plane surface and nothing else:
 *
 * - It is reachable only from an explicit human action in the unlocked vault,
 *   which is what `humanConfirmed` below exists to make structurally true —
 *   there is no way to call this with a default and get a document out.
 * - It is never reachable from the agent plane. No ConnectionRef, no MCP tool,
 *   and no WIT import may lead here. It is the `opensesame pass show --reveal`
 *   ceremony wearing a file format, and it inherits that ceremony's rules.
 * - Nothing here uploads. The caller writes the bytes to the user's own disk.
 *
 * The CXF specification's own guidance is that the document is transported
 * inside an encrypted, authenticated channel between the two managers. This
 * export writes the bare JSON, so the copy on disk carries all of the risk;
 * the UI has to say so, and the user has to delete the file afterwards.
 */

import { isString } from "@opensesame/os-domain";
import type { TypedItem, VaultBody, VaultItem } from "@opensesame/vault-core";
import { definitionFor, outsideAccounts } from "@opensesame/vault-core";
import {
  FIELD_TYPES,
  type FieldValue,
  definitionFields,
  displayText,
} from "@opensesame/vault-item-types";
import {
  type SkippedRecord,
  base64ToBase64Url,
  base64UrlToBase64,
} from "../import/types.js";
import { accountCredentials, methodCredentials } from "./cxf-account.js";
import {
  CXF_EXPORTER,
  CXF_EXTENSION,
  CXF_TYPES,
  CXF_VERSION,
  type CxfCollection,
  type CxfCredential,
  type CxfDocument,
  type CxfDocumentCandidate,
  type CxfEditableField,
  type CxfExportAttempt,
  type CxfExportOptions,
  type CxfExportResult,
  type CxfItem,
  field,
} from "./cxf-model.js";

export * from "./cxf-model.js";

export class CxfExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CxfExportError";
  }
}

/** CXF is base64url throughout; the vault stores standard base64. */
export const b64ToUrl = base64ToBase64Url;
export const urlToB64 = base64UrlToBase64;

function epoch(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/**
 * A plugin-defined item as CXF custom fields.
 *
 * Concealment comes from the field type, so a value the vault hides is written
 * `concealed-string` here — which is what an importer needs to hide it too.
 * This document is plaintext by design (see the file header); the field type
 * carries the intent, not the secrecy.
 */
function typedCredential(item: TypedItem): CxfCredential | null {
  const definition = definitionFor(item);
  const rows: CxfEditableField[] = [];
  if (definition === undefined) {
    // No definition on this device. The values are still the user's, and an
    // export that dropped them would lose them for good.
    for (const [id, value] of Object.entries(item.values)) {
      const text = flattenUnknownValue(value);
      if (text !== "") rows.push(field(text, "concealed-string", id));
    }
  } else {
    for (const declaredField of definitionFields(definition)) {
      const text = displayText(declaredField, item.values[declaredField.id]);
      if (text === "") continue;
      rows.push(
        field(
          text,
          FIELD_TYPES[declaredField.type].concealed
            ? "concealed-string"
            : "string",
          declaredField.label,
        ),
      );
    }
  }
  if (rows.length === 0) return null;
  return {
    type: CXF_TYPES.customFields,
    id: item.id,
    label: definition?.spec.title ?? item.typeId,
    fields: rows,
  };
}

/** A value whose field type is unknown here, flattened without losing parts. */
function flattenUnknownValue(value: FieldValue | undefined): string {
  if (value === undefined) return "";
  if (isString(value)) return value;
  if (Array.isArray(value)) return value.filter(isString).join(", ");
  return Object.values(value)
    .filter((part) => part !== "")
    .join(", ");
}

function customFieldsCredential(
  id: string,
  fields: readonly { name: string; value: string; hidden: boolean }[],
): CxfCredential | null {
  if (fields.length === 0) return null;
  return {
    type: CXF_TYPES.customFields,
    id,
    label: "Custom fields",
    fields: fields.map((entry) => ({
      fieldType: entry.hidden ? "concealed-string" : "string",
      value: entry.value,
      label: entry.name,
    })),
  };
}

function itemFor(item: VaultItem) {
  const base: CxfItem = {
    id: item.id,
    creationAt: epoch(item.createdAt),
    modifiedAt: epoch(item.updatedAt),
    title: item.name,
    credentials: [],
  };
  if (item.favorite) base.favorite = true;

  const extra = customFieldsCredential(item.id, item.fields);
  const note =
    item.notes.trim() === ""
      ? null
      : ({
          type: CXF_TYPES.note,
          content: field(item.notes),
        } satisfies CxfCredential);

  let withheldHere = 0;
  switch (item.kind) {
    case "account": {
      const urls = item.uris.map((uri) => uri.uri).filter((uri) => uri !== "");
      if (urls.length > 0) base.scope = { urls, androidApps: [] };
      const { credentials, withheld } = accountCredentials(item);
      base.credentials.push(...credentials);
      withheldHere = withheld;
      break;
    }
    case "credential": {
      // Kept on its own: what it is, with no account around it (ADR 0178).
      const { credentials, withheld } = methodCredentials(
        [item.method],
        "",
        false,
      );
      base.credentials.push(...credentials);
      withheldHere = withheld;
      break;
    }
    case "passkey":
      base.credentials.push({
        type: CXF_TYPES.passkey,
        credentialId: b64ToUrl(item.credentialIdB64),
        rpId: item.rpId,
        username: item.username,
        userDisplayName: item.username,
        userHandle: "",
        // Deliberately empty. See the type's doc comment.
        key: "",
        extensions: [
          {
            name: CXF_EXTENSION,
            publicKey: b64ToUrl(item.publicKeyB64),
            authenticator: item.authenticator,
          },
        ],
      });
      break;
    case "card":
      base.credentials.push({
        type: CXF_TYPES.creditCard,
        number: field(item.number, "concealed-string"),
        fullName: field(item.cardholder),
        cardType: field(item.brand),
        verificationNumber: field(item.code, "concealed-string"),
        expiryDate: field(
          item.expYear === "" && item.expMonth === ""
            ? ""
            : `${item.expYear}-${item.expMonth.padStart(2, "0")}`,
          "year-month",
        ),
      });
      break;
    case "secret":
      base.credentials.push({
        type: CXF_TYPES.apiKey,
        key: field(item.value, "concealed-string"),
        keyType: "opensesame-secret",
        extensions: [
          {
            name: CXF_EXTENSION,
            connectionRef: item.connectionRef,
          },
        ],
      });
      break;
    case "note":
      // A note with neither body nor fields would produce an item with no
      // credentials at all, which no importer can do anything with.
      if (note === null && extra === null) {
        base.credentials.push({ type: CXF_TYPES.note, content: field("") });
      }
      break;
    case "certificate":
      return {
        cxf: null,
        withheld: 0,
        skipped: {
          name: item.name,
          reason:
            "CXF has no credential type for an X.509 certificate and its private key, and splitting one across custom fields would produce something no manager could use.",
        },
      };
    case "drop":
      return {
        cxf: null,
        withheld: 0,
        skipped: {
          name: item.name,
          reason:
            "A drop is a one-time share in flight, not a stored secret — the payload never lives in the vault, so there is nothing durable to export.",
        },
      };
    case "typed": {
      // `custom-fields` is the floor CXF defines for what the standard did not
      // anticipate, which is exactly what makes every community type
      // exportable (ADR 0087 §4). Without this arm a plugin-defined item would
      // leave here with no credentials at all — silently empty in the file the
      // user is told holds their whole vault.
      const declared = typedCredential(item);
      if (declared !== null) base.credentials.push(declared);
      break;
    }
  }

  if (note !== null) base.credentials.push(note);
  if (extra !== null) base.credentials.push(extra);
  return { cxf: base, skipped: null, withheld: withheldHere };
}

function buildCxfExportDefault(
  body: VaultBody,
  options: CxfExportAttempt,
): CxfExportResult {
  if (options.humanConfirmed !== true) {
    throw new CxfExportError(
      "A CXF export writes every secret in the vault to a plaintext file, so it only runs on an explicit human confirmation.",
    );
  }
  const exportedAt = options.exportedAt ?? new Date();
  const items: CxfItem[] = [];
  const skipped: SkippedRecord[] = [];
  let withheld = 0;
  const byFolder = new Map<string, { item: string }[]>();

  // A credential bound to an account is in that account's credentials (ADR 0178).
  for (const item of outsideAccounts(body.items)) {
    if (item.deletedAt !== null) continue;
    const { cxf, skipped: rejected, withheld: held } = itemFor(item);
    withheld += held;
    if (cxf === null) {
      if (rejected !== null) skipped.push(rejected);
      continue;
    }
    items.push(cxf);
    if (item.folderId !== null) {
      const bucket = byFolder.get(item.folderId) ?? [];
      bucket.push({ item: cxf.id });
      byFolder.set(item.folderId, bucket);
    }
  }

  const collections: CxfCollection[] = body.folders
    .filter((folder) => byFolder.has(folder.id))
    .map((folder) => ({
      id: folder.id,
      creationAt: epoch(folder.createdAt),
      modifiedAt: epoch(folder.createdAt),
      title: folder.name,
      items: byFolder.get(folder.id) ?? [],
    }));

  return {
    document: {
      version: CXF_VERSION,
      exporter: options.exporter ?? CXF_EXPORTER,
      timestamp: Math.floor(exportedAt.getTime() / 1000),
      accounts: [
        {
          id: "opensesame-vault",
          username: options.username ?? "",
          email: options.email ?? "",
          collections,
          items,
        },
      ],
    },
    skipped,
    withheld,
  };
}

function serializeCxfExportDefault(document: CxfDocumentCandidate): string {
  if (document.version !== CXF_VERSION) {
    throw new CxfExportError("Refusing to write an unknown CXF version.");
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Suggested file name. Dated, because people accumulate these. */
export function cxfFileName(exportedAt = new Date()): string {
  return `opensesame-cxf-${exportedAt.toISOString().slice(0, 10)}.json`;
}

export const cxfExportSeams = {
  buildCxfExport: buildCxfExportDefault,
  serializeCxfExport: serializeCxfExportDefault,
};

export function buildCxfExport(
  body: VaultBody,
  options: CxfExportOptions,
): CxfExportResult {
  return cxfExportSeams.buildCxfExport(body, options);
}

export function serializeCxfExport(document: CxfDocument): string {
  return cxfExportSeams.serializeCxfExport(document);
}
