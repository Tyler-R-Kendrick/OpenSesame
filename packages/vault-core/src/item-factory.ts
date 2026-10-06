/**
 * Building a new item (split from `model.ts`, which re-exports these so every
 * importer keeps one path).
 */
import type {
  FieldValues,
  ItemTypeDefinition,
} from "@opensesame/vault-item-types";
import { newPasswordMethod } from "./account.js";
import type {
  AccountItem,
  BaseItem,
  CardItem,
  CertificateItem,
  DropItem,
  ItemKind,
  LegacyItemKind,
  NoteItem,
  PasskeyItem,
  SecretItem,
  TypedItem,
  VaultItem,
} from "./model.js";

/** Build an item of a plugin-defined type from its definition. */
export function createTypedItem(
  definition: ItemTypeDefinition,
  values: FieldValues,
  name = "",
): TypedItem {
  return {
    ...base("typed", name),
    kind: "typed",
    typeId: definition.metadata.id,
    values: { ...values },
  };
}

export function base(kind: ItemKind, name: string): BaseItem {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind,
    name,
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function createItem(kind: "account", name?: string): AccountItem;
export function createItem(kind: "passkey", name?: string): PasskeyItem;
export function createItem(kind: "card", name?: string): CardItem;
export function createItem(kind: "secret", name?: string): SecretItem;
export function createItem(kind: "note", name?: string): NoteItem;
export function createItem(kind: "certificate", name?: string): CertificateItem;
export function createItem(kind: "drop", name?: string): DropItem;
export function createItem(kind: LegacyItemKind, name?: string): VaultItem;
export function createItem(kind: LegacyItemKind, name = ""): VaultItem {
  const b = base(kind, name);
  switch (kind) {
    case "account":
      return {
        ...b,
        kind: "account",
        username: "",
        uris: [],
        methods: [newPasswordMethod(b.id, b.createdAt)],
      };
    case "passkey":
      return {
        ...b,
        kind: "passkey",
        rpId: "",
        username: "",
        credentialIdB64: "",
        publicKeyB64: "",
        authenticator: "platform",
        unlocksVault: false,
      };
    case "card":
      return {
        ...b,
        kind: "card",
        cardholder: "",
        brand: "",
        number: "",
        expMonth: "",
        expYear: "",
        code: "",
      };
    case "secret":
      return {
        ...b,
        kind: "secret",
        value: "",
        ceiling: [],
        grantees: [],
        connectionRef: "",
      };
    case "note":
      return { ...b, kind: "note" };
    case "certificate":
      return {
        ...b,
        kind: "certificate",
        commonName: name || "localhost",
        dnsNames: "localhost",
        ipAddrs: "127.0.0.1",
        ttlHours: "24",
        certificatePem: "",
        privateKeyPem: "",
        caPem: "",
        serial: "",
        notAfter: "",
      };
    case "drop":
      // A stub for switch exhaustiveness: the +new Drop ceremony builds the
      // real record from the claim session it created — claimId, bearerToken,
      // and expiresAt are never blank in a saved drop.
      return {
        ...b,
        kind: "drop",
        state: "pending",
        claimId: "",
        bearerToken: "",
        expiresAt: b.createdAt,
      };
  }
}
