import type { CBORType } from "@levischuck/tiny-cbor";
import type { JsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import {
  openBitwardenBlob,
  openBitwardenWrappedKey,
  sealBitwardenBlob,
  sealBitwardenWrappedKey,
} from "./bitwarden-native-blob.js";
import {
  type BitwardenCborMap,
  type BitwardenNativeKey,
  bitwardenCborMap,
  decodeBitwardenKey,
} from "./bitwarden-native-cose.js";
import {
  type BitwardenPlainField,
  nativeFieldEdits,
  nativeFieldView,
  nativeItemError,
  nativeItemInput,
  nativePersonalCipher,
  nativeText,
} from "./bitwarden-native-item.js";
import {
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
} from "./types.js";

function string(value: CBORType | undefined, nullable = false): string {
  if (nullable && (value === null || value === undefined)) return "";
  return z
    .string()
    .max(1024 * 1024)
    .parse(value);
}
function rows(value: CBORType | undefined, maximum = 512): BitwardenCborMap[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum) throw nativeItemError();
  return value.map(bitwardenCborMap);
}
function plainFields(
  fields: readonly BitwardenCborMap[],
): BitwardenPlainField[] {
  return fields.map((field) => ({
    name: field.get("name") === null ? null : string(field.get("name"), true),
    value:
      field.get("value") === null ? null : string(field.get("value"), true),
    type: z.number().int().min(0).max(3).parse(field.get("type")),
  }));
}
function content(model: BitwardenCborMap, wire: JsonObject): BitwardenCborMap {
  const result = bitwardenCborMap(model.get("content"));
  const kind = bitwardenCborMap(result.get("typeData")).get("type");
  if (kind !== (wire.type === 1 ? "login" : "secureNote"))
    throw nativeItemError();
  return result;
}
function withBlob<T>(
  wire: JsonObject,
  user: BitwardenNativeKey,
  operation: (model: BitwardenCborMap, key: BitwardenNativeKey) => T,
): T {
  let key: BitwardenNativeKey | undefined;
  try {
    if (!nativePersonalCipher(wire)) throw nativeItemError();
    key =
      wire.key === null || wire.key === undefined
        ? {
            ...user,
            material: user.material.slice(),
            id: user.id.slice(),
            operations: user.operations.slice(),
          }
        : openBitwardenWrappedKey(nativeText(wire.key), user, "item");
    const model = openBitwardenBlob(nativeText(wire.data), key);
    content(model, wire);
    return operation(model, key);
  } catch (error) {
    if (error instanceof SecretBackendError) throw error;
    throw nativeItemError();
  } finally {
    key?.material.fill(0);
    key?.id.fill(0);
  }
}
function read(wire: JsonObject, model: BitwardenCborMap): SecretBackendItem {
  const value = content(model, wire);
  const typed = bitwardenCborMap(value.get("typeData"));
  const fields = nativeFieldView(
    plainFields(rows(value.get("fields"))),
    wire.type === 1,
  );
  const uri =
    wire.type === 1
      ? rows(typed.get("uris"), 128).find(
          (row) => row.get("uri") !== null && row.get("uri") !== undefined,
        )
      : undefined;
  return {
    id: nativeText(wire.id),
    name: string(value.get("name")),
    notes: string(value.get("notes"), true),
    kind: fields.kind,
    secret:
      wire.type === 1 ? string(typed.get("password"), true) : fields.secret,
    username: wire.type === 1 ? string(typed.get("username"), true) : "",
    url: uri ? string(uri.get("uri")) : "",
    fields: fields.fields,
  };
}
export function readBitwardenBlobItem(
  wire: JsonObject,
  user: BitwardenNativeKey,
): SecretBackendItem {
  return withBlob(wire, user, (model) => read(wire, model));
}
function editFields(
  value: BitwardenCborMap,
  input: SecretBackendItemInput,
): BitwardenCborMap[] {
  const fields = rows(value.get("fields"));
  for (const edit of nativeFieldEdits(plainFields(fields), input)) {
    const next = new Map(fields[edit.index]);
    next.set("name", edit.name);
    next.set("value", edit.value);
    next.set("type", edit.type);
    if (edit.index < 0) fields.push(next);
    else fields[edit.index] = next;
  }
  return fields;
}
function editUris(
  value: CBORType | undefined,
  url: string | undefined,
): BitwardenCborMap[] {
  const result = rows(value, 128);
  if (url === undefined) return result;
  const index = result.findIndex(
    (row) => row.get("uri") !== null && row.get("uri") !== undefined,
  );
  const prior = result[index];
  if (prior?.get("uri") === url) return result;
  const next = prior
    ? new Map(prior)
    : new Map<string | number, CBORType>([["match", null]]);
  next.set("uri", url);
  if (index >= 0) result[index] = next;
  else result.push(next);
  return result;
}
function editModel(
  wire: JsonObject,
  model: BitwardenCborMap,
  input: SecretBackendItemInput,
  current: SecretBackendItem,
): BitwardenCborMap {
  const value = new Map(content(model, wire));
  value.set("name", input.name);
  value.set("notes", input.notes);
  value.set("fields", editFields(value, input));
  if (wire.type === 1) {
    const typed = new Map(bitwardenCborMap(value.get("typeData")));
    typed.set("password", input.secret);
    if (input.username !== undefined) typed.set("username", input.username);
    typed.set("uris", editUris(typed.get("uris"), input.url));
    if (input.secret !== current.secret) {
      const date = new Date().toISOString();
      typed.set("passwordRevisionDate", date);
      if (current.secret)
        value.set("passwordHistory", [
          new Map<string | number, CBORType>([
            ["password", current.secret],
            ["lastUsedDate", date],
          ]),
          ...rows(value.get("passwordHistory")),
        ]);
    }
    value.set("typeData", typed);
  }
  const next = new Map(model);
  next.set("content", value);
  return next;
}
export function updateBitwardenBlobItem(
  wire: JsonObject,
  input: SecretBackendItemInput,
  user: BitwardenNativeKey,
): JsonObject {
  if (wire.edit === false)
    throw new SecretBackendError("configuration", "This item is read-only.");
  return withBlob(wire, user, (model, key) => {
    const current = read(wire, model);
    const validated = nativeItemInput(input, current);
    return {
      ...wire,
      data: sealBitwardenBlob(editModel(wire, model, validated, current), key),
    };
  });
}
function emptyModel(login: boolean): BitwardenCborMap {
  const typed = login
    ? new Map<string | number, CBORType>([
        ["type", "login"],
        ["username", null],
        ["password", null],
        ["passwordRevisionDate", null],
        ["totp", null],
        ["autofillOnPageLoad", null],
      ])
    : new Map<string | number, CBORType>([
        ["type", "secureNote"],
        ["secureNoteType", 0],
      ]);
  return new Map<string | number, CBORType>([
    ["version", "1"],
    [
      "content",
      new Map<string | number, CBORType>([
        ["name", ""],
        ["notes", null],
        ["typeData", typed],
      ]),
    ],
  ]);
}
export function createBitwardenBlobItem(
  input: SecretBackendItemInput,
  user: BitwardenNativeKey,
  folder = "",
): JsonObject {
  const validated = nativeItemInput(input);
  const raw = crypto.getRandomValues(new Uint8Array(64));
  const key = decodeBitwardenKey(raw);
  raw.fill(0);
  try {
    const wire: JsonObject = {
      type: validated.kind === "login" ? 1 : 2,
      folderId: folder || null,
      organizationId: null,
      name: null,
      notes: null,
      fields: null,
      login: null,
      secureNote: null,
      favorite: false,
      reprompt: 0,
      key: sealBitwardenWrappedKey(key, user),
    };
    const current: SecretBackendItem = {
      id: "",
      name: "",
      notes: "",
      secret: "",
      kind: validated.kind ?? "note",
    };
    return {
      ...wire,
      data: sealBitwardenBlob(
        editModel(wire, emptyModel(wire.type === 1), validated, current),
        key,
      ),
    };
  } catch (error) {
    if (error instanceof SecretBackendError) throw error;
    throw nativeItemError();
  } finally {
    key.material.fill(0);
    key.id.fill(0);
  }
}
