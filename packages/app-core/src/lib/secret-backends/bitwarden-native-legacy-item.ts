import { sha256 } from "@noble/hashes/sha2.js";
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import { bytesToB64 } from "@opensesame/vault-core/bytes.js";
import { z } from "zod";
import {
  openBitwardenWrappedKey,
  sealBitwardenWrappedKey,
} from "./bitwarden-native-blob.js";
import {
  type BitwardenNativeKey,
  decodeBitwardenKey,
} from "./bitwarden-native-cose.js";
import {
  openBitwardenEncString,
  sealBitwardenEncString,
} from "./bitwarden-native-envelope.js";
import {
  type BitwardenPlainField,
  nativeFieldEdits,
  nativeFieldView,
  nativeItemError,
  nativeItemInput,
  nativeObject,
  nativePersonalCipher,
  nativeProperties,
  nativeText,
} from "./bitwarden-native-item.js";
import {
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
} from "./types.js";

function array(value: BoundaryValue, maximum = 512): BoundaryValue[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw nativeItemError();
  return value;
}
function text(value: BoundaryValue, key: BitwardenNativeKey): string {
  if (value === null || value === undefined) return "";
  const bytes = openBitwardenEncString(nativeText(value), key.material);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}
function seal(value: string, key: BitwardenNativeKey): string {
  const bytes = new TextEncoder().encode(value);
  try {
    return sealBitwardenEncString(bytes, key.material);
  } finally {
    bytes.fill(0);
  }
}
function legacyKey(
  wire: JsonObject,
  user: BitwardenNativeKey,
): BitwardenNativeKey {
  if (wire.key !== null && wire.key !== undefined)
    return openBitwardenWrappedKey(nativeText(wire.key), user, "item");
  return {
    ...user,
    material: user.material.slice(),
    id: user.id.slice(),
    operations: user.operations.slice(),
  };
}
function withKey<T>(
  wire: JsonObject,
  user: BitwardenNativeKey,
  operation: (key: BitwardenNativeKey) => T,
): T {
  let key: BitwardenNativeKey | undefined;
  try {
    if (
      !nativePersonalCipher(wire) ||
      (wire.data !== null && wire.data !== undefined)
    )
      throw nativeItemError();
    key = legacyKey(wire, user);
    if (key.algorithm !== -70011 || key.material.length !== 64)
      throw nativeItemError();
    return operation(key);
  } catch (error) {
    if (error instanceof SecretBackendError) throw error;
    throw nativeItemError();
  } finally {
    key?.material.fill(0);
    key?.id.fill(0);
  }
}
function rawFields(wire: JsonObject): JsonObject[] {
  return array(wire.fields).map((field) =>
    nativeProperties(field, ["name", "value", "type", "linkedId"]),
  );
}
function plainFields(
  fields: readonly JsonObject[],
  key: BitwardenNativeKey,
): BitwardenPlainField[] {
  return fields.map((field) => ({
    name: field.name === null ? null : text(field.name, key),
    value: field.value === null ? null : text(field.value, key),
    type: z.number().int().min(0).max(3).parse(field.type),
  }));
}
function login(wire: JsonObject): JsonObject {
  return nativeProperties(wire.login, [
    "username",
    "password",
    "uris",
    "passwordRevisionDate",
    "totp",
    "autofillOnPageLoad",
    "fido2Credentials",
  ]);
}
function uris(value: BoundaryValue): JsonObject[] {
  return array(value, 128).map((uri) =>
    nativeProperties(uri, ["uri", "match", "uriChecksum"]),
  );
}
function uriIndex(
  rows: readonly JsonObject[],
  key: BitwardenNativeKey,
  keyed: boolean,
): number {
  return rows.findIndex((uri) => {
    if (uri.uri === null || uri.uri === undefined) return false;
    if (!keyed) return true;
    const checksum = bytesToB64(
      sha256(new TextEncoder().encode(text(uri.uri, key))),
    );
    return text(uri.uriChecksum, key) === checksum;
  });
}
function read(wire: JsonObject, key: BitwardenNativeKey): SecretBackendItem {
  const fields = nativeFieldView(
    plainFields(rawFields(wire), key),
    wire.type === 1,
  );
  const data = wire.type === 1 ? login(wire) : {};
  const rows = wire.type === 1 ? uris(data.uris) : [];
  const selected = uriIndex(
    rows,
    key,
    wire.key !== null && wire.key !== undefined,
  );
  return {
    id: nativeText(wire.id),
    name: text(wire.name, key),
    kind: fields.kind,
    notes: text(wire.notes, key),
    secret: wire.type === 1 ? text(data.password, key) : fields.secret,
    username: wire.type === 1 ? text(data.username, key) : "",
    url: wire.type === 1 ? text(rows[selected]?.uri, key) : "",
    fields: fields.fields,
  };
}
export function readBitwardenLegacyItem(
  wire: JsonObject,
  user: BitwardenNativeKey,
): SecretBackendItem {
  return withKey(wire, user, (key) => read(wire, key));
}
function editedFields(
  wire: JsonObject,
  input: SecretBackendItemInput,
  key: BitwardenNativeKey,
): JsonObject[] {
  const fields = rawFields(wire);
  const plain = plainFields(fields, key);
  for (const edit of nativeFieldEdits(plain, input)) {
    const next = {
      ...(fields[edit.index] ?? {}),
      name: seal(edit.name, key),
      value: seal(edit.value, key),
      type: edit.type,
    };
    if (edit.index < 0) fields.push(next);
    else fields[edit.index] = next;
  }
  return fields;
}
function editedUris(
  value: BoundaryValue,
  url: string | undefined,
  key: BitwardenNativeKey,
  keyed: boolean,
): JsonObject[] {
  const result = uris(value);
  if (url === undefined) return result;
  const index = uriIndex(result, key, keyed);
  const first = result[index] ?? { match: null };
  if (text(first.uri, key) === url) return result;
  const checksum = bytesToB64(sha256(new TextEncoder().encode(url)));
  const next = {
    ...first,
    uri: seal(url, key),
    uriChecksum: seal(checksum, key),
  };
  if (index >= 0) result[index] = next;
  else result.push(next);
  return result;
}
function editLogin(
  wire: JsonObject,
  input: SecretBackendItemInput,
  current: SecretBackendItem,
  key: BitwardenNativeKey,
): JsonObject {
  const prior = wire.login ? login(wire) : {};
  const passwordChanged = input.secret !== current.secret;
  const result: JsonObject = {
    ...prior,
    username:
      input.username === undefined
        ? (prior.username ?? null)
        : seal(input.username, key),
    password: seal(input.secret, key),
    uris: editedUris(
      prior.uris,
      input.url,
      key,
      wire.key !== null && wire.key !== undefined,
    ),
  };
  if (passwordChanged) result.passwordRevisionDate = new Date().toISOString();
  return result;
}
function edited(
  wire: JsonObject,
  input: SecretBackendItemInput,
  key: BitwardenNativeKey,
  current: SecretBackendItem,
): JsonObject {
  const body: JsonObject = {
    ...wire,
    name: seal(input.name, key),
    notes: seal(input.notes, key),
    fields: editedFields(wire, input, key),
  };
  if (wire.type === 1) {
    body.login = editLogin(wire, input, current, key);
    if (current.secret && input.secret !== current.secret) {
      const history = array(wire.passwordHistory).map(nativeObject);
      body.passwordHistory = [
        {
          password: login(wire).password ?? null,
          lastUsedDate: new Date().toISOString(),
        },
        ...history,
      ];
    }
  }
  return body;
}
export function updateBitwardenLegacyItem(
  wire: JsonObject,
  input: SecretBackendItemInput,
  user: BitwardenNativeKey,
): JsonObject {
  if (wire.edit === false)
    throw new SecretBackendError("configuration", "This item is read-only.");
  return withKey(wire, user, (key) => {
    const current = read(wire, key);
    const validated = nativeItemInput(input, current);
    return edited(wire, validated, key, current);
  });
}
export function createBitwardenLegacyItem(
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
      organizationId: null,
      folderId: folder || null,
      name: null,
      notes: null,
      fields: [],
      favorite: false,
      reprompt: 0,
      login: validated.kind === "login" ? {} : null,
      secureNote: validated.kind === "login" ? null : { type: 0 },
      key: sealBitwardenWrappedKey(key, user),
    };
    const current: SecretBackendItem = {
      id: "",
      name: "",
      notes: "",
      secret: "",
      kind: validated.kind ?? "note",
    };
    return edited(wire, validated, key, current);
  } catch (error) {
    if (error instanceof SecretBackendError) throw error;
    throw nativeItemError();
  } finally {
    key.material.fill(0);
    key.id.fill(0);
  }
}
