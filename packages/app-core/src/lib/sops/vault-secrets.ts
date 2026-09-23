/**
 * Selected vault items as a SOPS JSON document, and back (B12, PERSIST-03).
 * The vault's unlock policy is untouched either way: an export is a new
 * document under a fresh data key and an explicit recipient plan; an import
 * is a separately consented copy under the vault's own any-of protection.
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
import { SopsError } from "./errors.js";
import { emitJsonTree, parseJsonTree } from "./json-codec.js";
import { type SopsNode, entry } from "./model.js";
import type { EncryptionPlan, ExecutionPermit } from "./plan.js";
import type { SopsRunner } from "./runner.js";

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
  return KINDS.some((kind) => kind === value);
}

/** Encrypt the selected items; every recipient in the plan must succeed. */
export async function exportVaultSecrets(input: {
  runner: SopsRunner;
  items: readonly VaultItem[];
  plan: EncryptionPlan;
  permit: ExecutionPermit;
}): Promise<string> {
  if (input.items.length === 0) {
    throw new SopsError(
      "invalid_document",
      "Select at least one item to export.",
    );
  }
  if (input.plan.format !== "json") {
    throw new SopsError(
      "unauthorized_policy",
      "Vault exports are JSON documents.",
    );
  }
  const plaintext = JSON.stringify({ items: input.items });
  return input.runner.encryptNew(plaintext, input.plan, input.permit);
}

function readItem(node: SopsNode): VaultItem {
  if (node.kind !== "map")
    throw new SopsError("invalid_document", "A vault item is not a mapping.");
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
  switch (kind) {
    case "login":
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
    case "passkey":
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
    case "card":
      return ["cardholder", "brand", "number", "expMonth", "expYear", "code"];
    case "secret":
      return ["value", "ceiling", "grantees", "connectionRef"];
    case "certificate":
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
    case "drop":
      return ["state", "claimId", "bearerToken", "expiresAt", "keptCopy"];
    case "typed":
      return ["typeId", "values"];
    default:
      return [];
  }
}

function unsafeItemId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return true;
  for (const char of id) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || char === "/" || char === "\\") return true;
  }
  return false;
}

function fail(message: string): SopsError {
  return new SopsError("invalid_document", message);
}

function assertString(item: JsonObject, key: string): void {
  if (!isString(item[key])) throw fail(`A vault item's ${key} is not text.`);
}

function assertKnownItem(value: JsonObject, kind: ItemKind): void {
  const id = value.id;
  if (!isString(id) || unsafeItemId(id))
    throw fail("A vault item id is not a vault record.");
  const allowed = new Set<string>([...BASE_FIELDS, ...extraFields(kind)]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw fail(`A vault item field is not part of ${kind}.`);
  }
}

function assertBase(value: JsonObject): void {
  assertString(value, "name");
  assertString(value, "notes");
  assertString(value, "createdAt");
  assertString(value, "updatedAt");
  if (!(value.folderId === null || isString(value.folderId)))
    throw fail("A vault item folder is not a vault record.");
  if (!isBoolean(value.favorite))
    throw fail("A vault item favorite is not a vault record.");
  if (!(value.deletedAt === null || isString(value.deletedAt)))
    throw fail("A vault item deletedAt is not a vault record.");
  if (value.sample !== undefined && !isBoolean(value.sample))
    throw fail("A vault item sample is not a vault record.");
  assertFields(value.fields);
}

function assertKindPayload(value: JsonObject, kind: ItemKind): void {
  if (kind === "secret") assertString(value, "value");
  if (kind === "login") assertString(value, "password");
  if (kind === "drop") assertString(value, "bearerToken");
  if (kind === "certificate") assertString(value, "privateKeyPem");
  if (kind === "passkey" && value.privateKeyPkcs8B64 !== undefined)
    assertString(value, "privateKeyPkcs8B64");
  if (kind === "typed") {
    assertString(value, "typeId");
    if (!isJsonObject(value.values))
      throw fail("A vault item's values are not a mapping.");
  }
}

function assertVaultItem(value: BoundaryValue): void {
  if (!isJsonObject(value)) throw fail("A vault item is not a mapping.");
  const kind = value.kind;
  if (!isString(kind) || !isKind(kind))
    throw fail("A vault item is not a vault record.");
  assertKnownItem(value, kind);
  assertBase(value);
  assertKindPayload(value, kind);
}

function assertFields(value: BoundaryValue | undefined): void {
  if (!Array.isArray(value))
    throw fail("A vault item's fields are not a list.");
  for (const field of value) {
    if (!isJsonObject(field))
      throw fail("A vault item field is not a mapping.");
    for (const key of Object.keys(field)) {
      if (
        key !== "id" &&
        key !== "name" &&
        key !== "value" &&
        key !== "hidden"
      ) {
        throw fail("A vault item field has an unknown property.");
      }
    }
    if (
      !isString(field.id) ||
      !isString(field.name) ||
      !isString(field.value) ||
      !isBoolean(field.hidden)
    ) {
      throw fail("A vault item field is malformed.");
    }
  }
}

export type ImportedSecrets = {
  items: VaultItem[];
  /** True when the source needed several key groups and this copy will not. */
  thresholdRelaxed: boolean;
};

/**
 * Open a vault-secrets document and validate every item. A source that
 * required several key groups becomes an ordinary any-of vault copy, which
 * the caller must have disclosed and the person consented to.
 */
export async function importVaultSecrets(input: {
  runner: SopsRunner;
  ciphertext: string;
  identities: readonly string[];
  consentToVaultCopy: boolean;
  permit: ExecutionPermit;
}): Promise<ImportedSecrets> {
  const inspection = await input.runner.inspect(input.ciphertext, "json");
  const thresholdRelaxed = inspection.keyGroups.length > 1;
  if (thresholdRelaxed && !input.consentToVaultCopy) {
    throw new SopsError(
      "unauthorized_policy",
      "Importing a key-group document into this vault needs consent.",
    );
  }
  const opened = await input.runner.open(
    input.ciphertext,
    "json",
    input.identities,
    input.permit,
  );
  try {
    const root = parseJsonTree(opened.plaintext);
    const items = entry(root, "items");
    if (!items || items.kind !== "seq")
      throw fail("The document has no items list.");
    const parsed = items.items.map((item) => {
      if (item.kind === "comment")
        throw fail("The items list holds a comment.");
      return readItem(item);
    });
    return { items: parsed, thresholdRelaxed };
  } finally {
    input.runner.dispose(opened.handle);
  }
}
