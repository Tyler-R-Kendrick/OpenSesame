import type { SkippedRecord } from "../import/types.js";

/** The CXF document model, and the one constructor every credential uses. */

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

export type CxfExportAttempt = Omit<CxfExportOptions, "humanConfirmed"> & {
  humanConfirmed: boolean;
};

export type CxfDocumentCandidate = Omit<CxfDocument, "version"> & {
  version: number;
};

export type CxfExportResult = {
  document: CxfDocument;
  /** Items this format cannot carry, and why, for the UI to show. */
  skipped: SkippedRecord[];
  /**
   * Passwords left out because using one means asking for a pepper (Include
   * pepper, or a Sphinx generator), which an export cannot do. Counted so the
   * UI can say how many accounts left without one. Never a value.
   */
  withheld: number;
};

export function field(
  value: string,
  fieldType: CxfFieldType = "string",
  label?: string,
): CxfEditableField {
  return label === undefined
    ? { fieldType, value }
    : { fieldType, value, label };
}
