import {
  type LegacyItemKind,
  type VaultItem,
  createCredential,
  createItem,
  createTypedItem,
  itemTypeRegistry,
  loginMethodTypeOf,
  mintRootSecret,
  newLoginMethod,
  newUri,
  newValues,
  passwordMethod,
} from "@opensesame/vault-core";
import {
  type FieldDefinition,
  definitionFields,
  resolveTypeId,
} from "@opensesame/vault-item-types";
import { generateStored } from "./generators/index.js";
import { defaultCharOptions, generateCharacters } from "./password.js";

const LEGACY_KINDS: readonly LegacyItemKind[] = [
  "account",
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

function acceptsConnectionRef(typeId: string): boolean {
  const definition = itemTypeRegistry().get(typeId);
  return (
    definition !== undefined &&
    definitionFields(definition).some(
      (field) => field.id === "connectionRef" && field.type === "string",
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

/**
 * Whether a name is still the one its type generated, and so should be replaced
 * when the type changes.
 *
 * Choosing a different type rebuilt the draft but carried the old name over, so
 * a person who opened "New item", picked Secret, and never touched the name got
 * an item called "Login 1d2f0063" — the name named the type they had left. A
 * name a person typed is theirs and is kept whatever happens next; only the
 * generated shape moves.
 *
 * The shape is the whole of the test: nothing records whether the person
 * retyped what they were given, so a name that is exactly this type's generated
 * form is treated as generated. Losing eight characters somebody chose to write
 * is the smaller failure next to an item named after the type it is not.
 */
export function isGeneratedDraftName(name: string, typeId: string): boolean {
  const definition = itemTypeRegistry().get(resolveTypeId(typeId));
  if (definition === undefined) return false;
  const prefix = `${definition.spec.title} `;
  return (
    name.startsWith(prefix) && /^[0-9a-f]{8}$/.test(name.slice(prefix.length))
  );
}

/** Only new user/agent creation calls this. Imports and edits retain their values. */
export function newItemDraft(rawTypeId: string, name?: string): VaultItem {
  // `login` is the retired name of `account`; a link that still carries it
  // opens an account draft (ADR 0172 §1).
  const typeId = resolveTypeId(rawTypeId);
  const definition = itemTypeRegistry().get(typeId);
  if (!definition) throw new Error("Unknown vault item type");
  const labels = generateDraftLabels(typeId);
  const title = name || labels.name;
  const legacy = LEGACY_KINDS.find((kind) => kind === typeId);
  if (legacy !== undefined)
    return newNativeDraft(legacy, { ...labels, name: title });
  // A credential of its own, bound to no account until a person says (ADR 0179).
  const loginType = loginMethodTypeOf(typeId);
  if (loginType !== undefined) {
    const method = newLoginMethod(loginType, "credential");
    return createCredential({ ...method, id: crypto.randomUUID() }, title);
  }
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
  if (item.kind === "account") {
    // An empty address matches nothing. `*` would offer the account on every site.
    item.uris = [newUri()];
    item.username = labels.username;
    // The first password method keeps what its generator makes, in the clear:
    // a draft has no pepper yet. A derived method keeps a fresh root.
    const method = passwordMethod(item);
    if (method?.generator.id === "derived") method.secret = mintRootSecret();
    else if (method?.generator.id === "rules") {
      method.secret = generateStored(method.generator);
    }
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
  rawTypeId = "account",
): DraftPrefill {
  const typeId = resolveTypeId(rawTypeId);
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
  rawTypeId: string,
  search: URLSearchParams,
): VaultItem {
  const typeId = resolveTypeId(rawTypeId);
  const prefill = readDraftPrefill(search, typeId);
  const draft = newItemDraft(typeId, prefill.name);
  draft.folderId = prefill.folder ?? null;
  if (draft.kind === "typed")
    draft.values = { ...draft.values, ...prefill.fields };
  if (draft.kind === "account" || draft.kind === "passkey") {
    if (prefill.username) draft.username = prefill.username;
    if (prefill.uri) {
      const url = draftWebsite(prefill.uri);
      if (draft.kind === "account") draft.uris = [newUri(prefill.uri)];
      else draft.rpId = url.hostname;
      if (!prefill.name) draft.name = url.hostname;
    }
  }
  if (draft.kind === "typed" && prefill.username) {
    if (acceptsDraftUsername(typeId))
      draft.values = { ...draft.values, username: prefill.username };
  }
  if (draft.kind === "typed" && prefill.ref && acceptsConnectionRef(typeId)) {
    draft.values = { ...draft.values, connectionRef: prefill.ref };
  }
  return draft;
}
