/**
 * Vault secret export and import as a SOPS document.
 * The vault unlock policy stays where it is. This file is a separate copy.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { ItemKind, VaultItem } from "../vault/model.js";
import {
  decryptSopsDocument,
  encryptSopsDocument,
  inspectSopsDocument,
} from "./engine.js";
import { emitJsonTree, parseJsonTree } from "./json-codec.js";
import type { SopsNode } from "./tree.js";

const KINDS: readonly ItemKind[] = [
  "login",
  "passkey",
  "card",
  "secret",
  "note",
  "certificate",
  "drop",
  "typed",
];

function isKind(value: string): value is ItemKind {
  for (const kind of KINDS) {
    if (kind === value) return true;
  }
  return false;
}

export async function exportVaultSecrets(input: {
  items: readonly VaultItem[];
  recipients: readonly string[];
  groups?: readonly (readonly string[])[];
  threshold?: number;
}): Promise<string> {
  const plaintext = JSON.stringify({ items: input.items });
  if (
    input.groups &&
    input.groups.length > 0 &&
    input.threshold !== undefined
  ) {
    return encryptSopsDocument({
      format: "json",
      plaintext,
      recipients: input.recipients,
      groups: input.groups,
      threshold: input.threshold,
    });
  }
  if (input.groups && input.groups.length > 0) {
    return encryptSopsDocument({
      format: "json",
      plaintext,
      recipients: input.recipients,
      groups: input.groups,
    });
  }
  return encryptSopsDocument({
    format: "json",
    plaintext,
    recipients: input.recipients,
  });
}

function readItem(node: SopsNode): VaultItem {
  if (node.kind !== "map") throw new Error("vault item is not a mapping");
  const parsed: BoundaryValue = JSON.parse(emitJsonTree(node));
  assertVaultItem(parsed);
  // SAFETY: assertVaultItem checked the vault item contract before this cast.
  return overlapCast(parsed);
}

const BASE_FIELDS = [
  "id",
  "kind",
  "name",
  "folderId",
  "favorite",
  "notes",
  "fields",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "sample",
] as const;

function extraFields(kind: ItemKind): readonly string[] {
  if (kind === "login") {
    return [
      "username",
      "password",
      "totp",
      "uris",
      "passwordChangedAt",
      "supersededById",
      "retiredAt",
      "reenrollState",
    ];
  }
  if (kind === "passkey") {
    return [
      "rpId",
      "username",
      "credentialIdB64",
      "publicKeyB64",
      "authenticator",
      "unlocksVault",
      "privateKeyPkcs8B64",
      "cosePublicKeyB64",
      "signCount",
      "userHandleB64",
      "discoverable",
      "alg",
      "transports",
      "custody",
      "provenance",
      "importedFrom",
      "duplicateOfExternal",
      "supersededById",
      "retiredAt",
      "reenrollState",
    ];
  }
  if (kind === "card") {
    return ["cardholder", "brand", "number", "expMonth", "expYear", "code"];
  }
  if (kind === "secret") {
    return ["value", "ceiling", "grantees", "connectionRef"];
  }
  if (kind === "certificate") {
    return [
      "commonName",
      "dnsNames",
      "ipAddrs",
      "ttlHours",
      "certificatePem",
      "privateKeyPem",
      "caPem",
      "serial",
      "notAfter",
    ];
  }
  if (kind === "drop") {
    return ["state", "claimId", "bearerToken", "expiresAt", "keptCopy"];
  }
  if (kind === "typed") return ["typeId", "values"];
  return [];
}

function unsafeItemId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return true;
  for (const char of id) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || char === "/" || char === "\\") return true;
  }
  return false;
}

function assertString(item: JsonObject, key: string): void {
  if (!isString(item[key])) throw new Error(`vault item ${key} is not text`);
}

function assertKnownItem(value: JsonObject, kind: ItemKind): void {
  const id = value.id;
  if (!isString(id) || unsafeItemId(id)) {
    throw new Error("vault item id is not a vault record");
  }
  const allowed = new Set<string>([...BASE_FIELDS, ...extraFields(kind)]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`vault item field ${key} is not part of ${kind}`);
    }
  }
}

function assertBase(value: JsonObject): void {
  assertString(value, "name");
  assertString(value, "notes");
  assertString(value, "createdAt");
  assertString(value, "updatedAt");
  const folderId = value.folderId;
  if (!(folderId === null || isString(folderId))) {
    throw new Error("vault item folder is not a vault record");
  }
  if (!isBoolean(value.favorite)) {
    throw new Error("vault item favorite is not a vault record");
  }
  const deletedAt = value.deletedAt;
  if (!(deletedAt === null || isString(deletedAt))) {
    throw new Error("vault item deletedAt is not a vault record");
  }
  if (value.sample !== undefined && !isBoolean(value.sample)) {
    throw new Error("vault item sample is not a vault record");
  }
  assertFields(value.fields);
}

function assertTyped(value: JsonObject): void {
  assertString(value, "typeId");
  if (!isJsonObject(value.values)) {
    throw new Error("vault item values are not a mapping");
  }
}

function assertKindPayload(value: JsonObject, kind: ItemKind): void {
  if (kind === "secret") assertString(value, "value");
  if (kind === "login") assertString(value, "password");
  if (kind === "drop") assertString(value, "bearerToken");
  if (kind === "certificate") assertString(value, "privateKeyPem");
  if (kind === "passkey" && value.privateKeyPkcs8B64 !== undefined) {
    assertString(value, "privateKeyPkcs8B64");
  }
  if (kind === "typed") assertTyped(value);
}

function assertVaultItem(value: BoundaryValue): void {
  if (!isJsonObject(value)) throw new Error("vault item is not a mapping");
  const kind = value.kind;
  if (!isString(kind) || !isKind(kind)) {
    throw new Error("vault item is not a vault record");
  }
  assertKnownItem(value, kind);
  assertBase(value);
  assertKindPayload(value, kind);
}

function assertFields(value: BoundaryValue | undefined): void {
  if (!Array.isArray(value))
    throw new Error("vault item fields are not a list");
  for (const field of value) {
    if (!isJsonObject(field))
      throw new Error("vault item field is not a mapping");
    for (const key of Object.keys(field)) {
      if (
        key !== "id" &&
        key !== "name" &&
        key !== "value" &&
        key !== "hidden"
      ) {
        throw new Error("vault item field has an unknown property");
      }
    }
    if (
      !isString(field.id) ||
      !isString(field.name) ||
      !isString(field.value)
    ) {
      throw new Error("vault item field is malformed");
    }
    if (!isBoolean(field.hidden))
      throw new Error("vault item field is malformed");
  }
}

export async function importVaultSecrets(input: {
  ciphertext: string;
  identity: string;
  consentToVaultCopy: boolean;
}): Promise<VaultItem[]> {
  const inspection = inspectSopsDocument(input.ciphertext, "json");
  if (inspection.groups > 1 && !input.consentToVaultCopy) {
    throw new Error("threshold import needs consent");
  }
  const plain = await decryptSopsDocument({
    format: "json",
    ciphertext: input.ciphertext,
    identity: input.identity,
  });
  const root = parseJsonTree(plain);
  if (root.kind !== "map")
    throw new Error("vault SOPS document is not a mapping");
  const items = root.entries.find((entry) => entry.key === "items")?.value;
  if (!items || items.kind !== "seq") {
    throw new Error("vault SOPS document has no items");
  }
  return items.items.map(readItem);
}
