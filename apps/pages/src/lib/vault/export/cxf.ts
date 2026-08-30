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

import {
  type SkippedRecord,
  base64ToBase64Url,
  base64UrlToBase64,
} from "../import/types.js";
import type { VaultBody, VaultItem } from "../model.js";

export const CXF_VERSION = 1 as const;
export const CXF_EXPORTER = "OpenSesame" as const;

/** CXF credential discriminators, as this vault writes them. */
export const CXF_TYPES = {
  basicAuth: "basic-auth",
  passkey: "passkey",
  totp: "totp",
  creditCard: "credit-card",
  note: "note",
  sshKey: "ssh-key",
  apiKey: "api-key",
  wifi: "wifi",
  address: "address",
  personName: "person-name",
  file: "file",
  customFields: "custom-fields",
} as const;

/** Vendor extension name used for what CXF has no field of its own for. */
export const CXF_EXTENSION = "com.opensesame.vault" as const;

export type CxfFieldType =
  | "string"
  | "concealed-string"
  | "email"
  | "number"
  | "boolean"
  | "date"
  | "year-month";

export type CxfEditableField = {
  id?: string;
  fieldType: CxfFieldType;
  value: string;
  label?: string;
};

export type CxfExtension = {
  name: typeof CXF_EXTENSION;
  /** Only ever metadata CXF cannot carry — never a value CXF has a field for. */
  [key: string]: string | boolean | undefined;
};

export type CxfCredential =
  | {
      type: typeof CXF_TYPES.basicAuth;
      username?: CxfEditableField;
      password?: CxfEditableField;
    }
  | {
      type: typeof CXF_TYPES.passkey;
      credentialId: string;
      rpId: string;
      username: string;
      userDisplayName: string;
      userHandle: string;
      /**
       * base64url PKCS#8 private key. Always empty in a document this vault
       * writes — it never holds a passkey private key, and a format field is
       * not a reason to start.
       */
      key: string;
      extensions?: CxfExtension[];
    }
  | {
      type: typeof CXF_TYPES.totp;
      secret: string;
      period: number;
      digits: number;
      algorithm: "sha1" | "sha256" | "sha512";
      username: string;
      issuer?: string;
      extensions?: CxfExtension[];
    }
  | {
      type: typeof CXF_TYPES.creditCard;
      number?: CxfEditableField;
      fullName?: CxfEditableField;
      cardType?: CxfEditableField;
      verificationNumber?: CxfEditableField;
      expiryDate?: CxfEditableField;
    }
  | { type: typeof CXF_TYPES.note; content: CxfEditableField }
  | {
      type: typeof CXF_TYPES.sshKey;
      keyType: string;
      privateKey: CxfEditableField;
      keyComment?: string;
    }
  | {
      type: typeof CXF_TYPES.apiKey;
      key: CxfEditableField;
      username?: string;
      keyType?: string;
      extensions?: CxfExtension[];
    }
  | {
      type: typeof CXF_TYPES.customFields;
      id: string;
      label: string;
      fields: CxfEditableField[];
    };

export type CxfItem = {
  id: string;
  creationAt: number;
  modifiedAt: number;
  title: string;
  favorite?: boolean;
  tags?: string[];
  scope?: { urls: string[]; androidApps: string[] };
  credentials: CxfCredential[];
};

export type CxfCollection = {
  id: string;
  creationAt: number;
  modifiedAt: number;
  title: string;
  /** Ids of the items in this collection, per CXF's linked-item model. */
  items: { item: string }[];
  subcollections?: CxfCollection[];
};

export type CxfAccount = {
  id: string;
  username: string;
  email: string;
  collections: CxfCollection[];
  items: CxfItem[];
};

export type CxfDocument = {
  version: typeof CXF_VERSION;
  exporter: string;
  timestamp: number;
  accounts: CxfAccount[];
};

export type CxfExportOptions = {
  /**
   * Proof that a person asked for this in the unlocked vault. There is no
   * default: an export that nobody consented to must be impossible to obtain
   * by forgetting an argument.
   */
  humanConfirmed: true;
  /** Account label written into the document. Never a credential. */
  username?: string;
  email?: string;
  exportedAt?: Date;
  exporter?: string;
};

type CxfExportAttempt = Omit<CxfExportOptions, "humanConfirmed"> & {
  humanConfirmed: boolean;
};

type CxfDocumentCandidate = Omit<CxfDocument, "version"> & {
  version: number;
};

export type CxfExportResult = {
  document: CxfDocument;
  /** Items this format cannot carry, and why, for the UI to show. */
  skipped: SkippedRecord[];
};

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

function field(
  value: string,
  fieldType: CxfFieldType = "string",
  label?: string,
): CxfEditableField {
  return label === undefined
    ? { fieldType, value }
    : { fieldType, value, label };
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

/**
 * TOTP as CXF models it — separate parameters rather than a URI. A vault entry
 * that already holds an `otpauth://` URI keeps it verbatim in an extension, so
 * a document written here and read back here is exact even where CXF's own
 * field set cannot express the original label.
 */
function totpCredential(totp: string, username: string): CxfCredential | null {
  const raw = totp.trim();
  if (raw === "") return null;
  if (!/^otpauth:\/\//iu.test(raw)) {
    return {
      type: CXF_TYPES.totp,
      secret: raw,
      period: 30,
      digits: 6,
      algorithm: "sha1",
      username,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // A malformed URI is still the user's data; carry it as the secret rather
    // than dropping a second factor on the floor.
    return {
      type: CXF_TYPES.totp,
      secret: raw,
      period: 30,
      digits: 6,
      algorithm: "sha1",
      username,
    };
  }
  const params = url.searchParams;
  const algorithm = (params.get("algorithm") ?? "sha1").toLowerCase();
  const issuer = params.get("issuer");
  const credential: CxfCredential = {
    type: CXF_TYPES.totp,
    secret: params.get("secret") ?? "",
    period: Number.parseInt(params.get("period") ?? "30", 10) || 30,
    digits: Number.parseInt(params.get("digits") ?? "6", 10) || 6,
    algorithm:
      algorithm === "sha256" || algorithm === "sha512" ? algorithm : "sha1",
    username,
  };
  if (issuer !== null) credential.issuer = issuer;
  credential.extensions = [{ name: CXF_EXTENSION, otpauth: raw }];
  return credential;
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

  switch (item.kind) {
    case "login": {
      const urls = item.uris.map((uri) => uri.uri).filter((uri) => uri !== "");
      if (urls.length > 0) base.scope = { urls, androidApps: [] };
      base.credentials.push({
        type: CXF_TYPES.basicAuth,
        username: field(item.username, "string"),
        password: field(item.password, "concealed-string"),
      });
      const totp = totpCredential(item.totp, item.username);
      if (totp !== null) base.credentials.push(totp);
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
        skipped: {
          name: item.name,
          reason:
            "CXF has no credential type for an X.509 certificate and its private key, and splitting one across custom fields would produce something no manager could use.",
        },
      };
    case "drop":
      return {
        cxf: null,
        skipped: {
          name: item.name,
          reason:
            "A drop is a one-time share in flight, not a stored secret — the payload never lives in the vault, so there is nothing durable to export.",
        },
      };
  }

  if (note !== null) base.credentials.push(note);
  if (extra !== null) base.credentials.push(extra);
  return { cxf: base, skipped: null };
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
  const byFolder = new Map<string, { item: string }[]>();

  for (const item of body.items) {
    if (item.deletedAt !== null) continue;
    const { cxf, skipped: rejected } = itemFor(item);
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
