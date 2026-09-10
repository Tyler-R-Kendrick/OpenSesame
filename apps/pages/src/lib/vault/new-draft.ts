import {
  type FieldDefinition,
  definitionFields,
} from "@opensesame/vault-item-types";
import { itemTypeRegistry, newValues } from "./item-types.js";
import {
  type LegacyItemKind,
  type VaultItem,
  createItem,
  createTypedItem,
  newUri,
} from "./model.js";
import { defaultCharOptions, generateCharacters } from "./password.js";

const LEGACY_KINDS: readonly LegacyItemKind[] = [
  "login",
  "passkey",
  "card",
  "secret",
  "note",
  "certificate",
  "drop",
];

export type DraftLabels = { name: string; username: string };

export function acceptsDraftUsername(typeId: string): boolean {
  const definition = itemTypeRegistry().get(typeId);
  return (
    definition !== undefined &&
    definitionFields(definition).some(
      (field) =>
        field.id === "username" && field.type === "string" && !field.multiple,
    )
  );
}

/** An editable alias, not a claim about an existing account or real person. */
export function generateDraftLabels(typeId: string): DraftLabels {
  const definition = itemTypeRegistry().get(typeId);
  if (!definition) throw new Error("Unknown vault item type");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return {
    name: `${definition.spec.title} ${suffix.slice(0, 8)}`,
    username: `user_${suffix}`,
  };
}

/** Only new user/agent creation calls this. Imports and edits retain their values. */
export function newItemDraft(typeId: string, name?: string): VaultItem {
  const definition = itemTypeRegistry().get(typeId);
  if (!definition) throw new Error("Unknown vault item type");
  const labels = generateDraftLabels(typeId);
  const title = name || labels.name;
  const legacy = LEGACY_KINDS.find((kind) => kind === typeId);
  if (legacy !== undefined)
    return newNativeDraft(legacy, { ...labels, name: title });
  const values = { ...newValues(definition) };
  for (const field of definitionFields(definition)) {
    if (field.multiple || field.default !== undefined) continue;
    if (field.type === "password" || field.type === "pin")
      values[field.id] = generateCharacters(
        field.type === "pin"
          ? {
              ...defaultCharOptions,
              length: 6,
              lower: false,
              upper: false,
              symbols: false,
              avoidAmbiguous: false,
            }
          : defaultCharOptions,
      );
    if (field.type === "string" && field.id === "username")
      values[field.id] = labels.username;
  }
  return createTypedItem(definition, values, title);
}

function newNativeDraft(kind: LegacyItemKind, labels: DraftLabels): VaultItem {
  const item = createItem(kind, labels.name);
  if (item.kind === "login") {
    item.uris = [newUri("*", "wildcard")];
    item.username = labels.username;
    item.password = generateCharacters(defaultCharOptions);
  }
  if (item.kind === "secret")
    item.value = generateCharacters(defaultCharOptions);
  if (item.kind === "passkey") item.username = labels.username;
  if (item.kind === "certificate") {
    // Names and issued material are facts, not random defaults.
    item.commonName = "";
    item.dnsNames = "";
    item.ipAddrs = "";
  }
  return item;
}

export type DraftPrefill = {
  name?: string;
  username?: string;
  uri?: string;
  folder?: string;
  ref?: string;
  fields: Record<string, string>;
};

const PREFILL_KEYS = ["name", "username", "uri", "folder", "ref"] as const;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]{1,120}$/u;

function publicField(typeId: string, id: string, value: string): void {
  const definition = itemTypeRegistry().get(typeId);
  const field =
    definition &&
    definitionFields(definition).find((candidate) => candidate.id === id);
  if (!field || field.multiple || LEGACY_KINDS.some((kind) => kind === typeId))
    throw new Error("invalid_prefill");
  validatePublicFieldValue(field, value);
}

function validatePublicFieldValue(field: FieldDefinition, value: string): void {
  switch (field.type) {
    case "string":
      return;
    case "url":
      draftWebsite(value);
      return;
    case "number":
      if (
        /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) &&
        Number.isFinite(Number(value))
      )
        return;
      break;
    case "boolean":
      if (["true", "false"].includes(value)) return;
      break;
    case "select":
      if (field.options?.includes(value)) return;
      break;
    case "country":
      if (/^[A-Z]{2}$/.test(value)) return;
      break;
  }
  // Concealed values, personal records, free-form notes and key material are never link inputs.
  throw new Error("invalid_prefill");
}

/** Never accept a credential-bearing URL or executable scheme. No network lookup. */
export function draftWebsite(value: string): URL {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("invalid_prefill");
    return url;
  } catch {
    throw new Error("invalid_prefill");
  }
}

/** Link data is an untrusted suggestion, never authority or an automatic save. */
export function readDraftPrefill(
  search: URLSearchParams,
  typeId = "login",
): DraftPrefill {
  const prefill: DraftPrefill = { fields: {} };
  if (search.toString().length > 2048) throw new Error("invalid_prefill");
  for (const key of search.keys()) {
    const known = PREFILL_KEYS.find((candidate) => candidate === key);
    const value = search.get(key)?.trim() ?? "";
    if (search.getAll(key).length !== 1 || !SAFE_TEXT.test(value))
      throw new Error("invalid_prefill");
    if (key.startsWith("field.")) {
      const id = key.slice(6);
      if (id === "username" && search.has("username"))
        throw new Error("invalid_prefill");
      publicField(typeId, id, value);
      prefill.fields[id] = value;
      continue;
    }
    if (!known) throw new Error("invalid_prefill");
    validateNamedPrefill(known, value);
    prefill[known] = value;
  }
  return prefill;
}

function validateNamedPrefill(
  key: (typeof PREFILL_KEYS)[number],
  value: string,
): void {
  if (key === "uri") draftWebsite(value);
  if (key === "folder" && !/^[a-zA-Z0-9:_-]{1,120}$/.test(value))
    throw new Error("invalid_prefill");
  if (key === "ref" && !/^[a-zA-Z0-9_-]+(?:[/:][a-zA-Z0-9_-]+)*$/.test(value))
    throw new Error("invalid_prefill");
}

export function prefillNewDraft(
  typeId: string,
  search: URLSearchParams,
): VaultItem {
  const prefill = readDraftPrefill(search, typeId);
  const draft = newItemDraft(typeId, prefill.name);
  draft.folderId = prefill.folder ?? null;
  if (draft.kind === "typed")
    draft.values = { ...draft.values, ...prefill.fields };
  if (draft.kind === "login" || draft.kind === "passkey") {
    if (prefill.username) draft.username = prefill.username;
    if (prefill.uri) {
      const url = draftWebsite(prefill.uri);
      if (draft.kind === "login") draft.uris = [newUri(prefill.uri)];
      else draft.rpId = url.hostname;
      if (!prefill.name) draft.name = url.hostname;
    }
  }
  if (draft.kind === "typed" && prefill.username) {
    if (acceptsDraftUsername(typeId))
      draft.values = { ...draft.values, username: prefill.username };
  }
  if (draft.kind === "secret" && prefill.ref) draft.connectionRef = prefill.ref;
  return draft;
}
