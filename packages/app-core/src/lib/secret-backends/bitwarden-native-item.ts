import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
} from "@opensesame/os-domain";
import { z } from "zod";
import {
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
} from "./types.js";

export type BitwardenPlainField = {
  name: string | null;
  value: string | null;
  type: number;
};
export type BitwardenFieldEdit = {
  index: number;
  name: string;
  value: string;
  type: number;
};
const SECRET = "opensesame_secret";
const KIND = "opensesame_kind";
const inputSchema = z.object({
  name: z.string().min(1).max(4096),
  notes: z.string().max(524288),
  secret: z.string().max(524288),
  kind: z.enum(["note", "login", "secret"]).optional(),
  username: z.string().max(4096).optional(),
  url: z.string().max(8192).optional(),
  fields: z
    .record(z.string().min(1).max(256), z.string().max(65536))
    .optional(),
});
export function nativeItemError(): SecretBackendError {
  return new SecretBackendError(
    "response",
    "The encrypted Bitwarden item is invalid.",
  );
}
export function nativeObject(value: BoundaryValue): JsonObject {
  if (!value || !isJsonObject(value)) throw nativeItemError();
  return value;
}
export function nativeText(value: BoundaryValue, nullable = false): string {
  if (nullable && (value === null || value === undefined)) return "";
  const parsed = z
    .string()
    .max(4 * 1024 * 1024)
    .safeParse(value);
  if (!parsed.success) throw nativeItemError();
  return parsed.data;
}
/** Known API properties are canonicalized once; unknown metadata remains verbatim. */
export function nativeProperties(
  value: BoundaryValue,
  names: readonly string[],
): JsonObject {
  const source = nativeObject(value);
  const result = { ...source };
  for (const name of names) {
    const upper = name.charAt(0).toUpperCase() + name.slice(1);
    const lower = Object.hasOwn(source, name) ? source[name] : undefined;
    const alternate = Object.hasOwn(source, upper) ? source[upper] : undefined;
    if (
      lower !== undefined &&
      alternate !== undefined &&
      JSON.stringify(lower) !== JSON.stringify(alternate)
    )
      throw nativeItemError();
    if (alternate !== undefined) {
      result[name] = lower === undefined ? alternate : lower;
      delete result[upper];
    }
  }
  return result;
}
export function nativeCipherWire(value: BoundaryValue): JsonObject {
  const result = nativeProperties(value, [
    "id",
    "type",
    "organizationId",
    "folderId",
    "deletedDate",
    "edit",
    "viewPassword",
    "partialData",
    "revisionDate",
    "key",
    "data",
    "name",
    "notes",
    "fields",
    "login",
    "secureNote",
    "passwordHistory",
    "attachments",
    "favorite",
    "reprompt",
    "creationDate",
    "archivedDate",
    "collectionIds",
    "permissions",
  ]);
  const id = z.string().uuid().safeParse(result.id);
  if (!id.success) throw nativeItemError();
  if (!Number.isSafeInteger(result.type)) throw nativeItemError();
  return result;
}
export function nativePersonalCipher(wire: JsonObject, folder = ""): boolean {
  return (
    wire.organizationId === null &&
    !wire.deletedDate &&
    !wire.partialData &&
    wire.viewPassword !== false &&
    (wire.type === 1 || wire.type === 2) &&
    (!folder || wire.folderId === folder)
  );
}
export function nativeItemInput(
  input: SecretBackendItemInput,
  existing?: SecretBackendItem,
): SecretBackendItemInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new SecretBackendError(
      "configuration",
      "Enter a valid bounded note or login item.",
    );
  const value = parsed.data;
  if (
    Object.keys(value.fields ?? {}).length > 128 ||
    Object.hasOwn(value.fields ?? {}, SECRET) ||
    Object.hasOwn(value.fields ?? {}, KIND)
  )
    throw new SecretBackendError(
      "configuration",
      "Use the item kind and secret controls for managed fields.",
    );
  boundedInputText(value);
  if (
    existing &&
    (value.kind === "login") !== (existing.kind === "login") &&
    value.kind !== undefined
  )
    throw new SecretBackendError(
      "configuration",
      "Keep the existing login or note type when updating this item.",
    );
  return { ...value, kind: value.kind ?? existing?.kind ?? "note" };
}
function boundedInputText(value: SecretBackendItemInput): void {
  let size = 0;
  for (const part of [
    value.name,
    value.notes,
    value.secret,
    value.username ?? "",
    value.url ?? "",
    ...Object.entries(value.fields ?? {}).flat(),
  ]) {
    const bytes = new TextEncoder().encode(part);
    size += bytes.length;
    if (new TextDecoder().decode(bytes) !== part || size > 524288)
      throw new SecretBackendError(
        "configuration",
        "The item exceeds the supported text size.",
      );
  }
}
function managed(
  fields: readonly BitwardenPlainField[],
  name: string,
): BitwardenPlainField | undefined {
  const matches = fields.filter((field) => field.name === name);
  if (matches.length > 1) throw nativeItemError();
  const field = matches[0];
  if (field && field.type !== (name === SECRET ? 1 : 0))
    throw nativeItemError();
  return field;
}
export function nativeFieldView(
  fields: readonly BitwardenPlainField[],
  login: boolean,
) {
  if (fields.length > 512) throw nativeItemError();
  const secret = managed(fields, SECRET)?.value ?? "";
  const kind = managed(fields, KIND)?.value;
  if (
    kind !== undefined &&
    kind !== null &&
    kind !== "note" &&
    kind !== "secret"
  )
    throw nativeItemError();
  const custom = customFields(fields);
  const resultKind: SecretBackendItem["kind"] = login
    ? "login"
    : kind === "secret"
      ? "secret"
      : "note";
  return { secret, kind: resultKind, fields: custom };
}
function customFields(
  fields: readonly BitwardenPlainField[],
): NonNullable<SecretBackendItem["fields"]> {
  const custom: NonNullable<SecretBackendItem["fields"]> = {};
  for (const field of fields) {
    if (
      field.name &&
      field.value !== null &&
      field.name !== SECRET &&
      field.name !== KIND &&
      !Object.hasOwn(custom, field.name)
    )
      Object.defineProperty(custom, field.name, {
        value: field.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return custom;
}
/** Edits preserve unmentioned duplicate/custom/linked fields and their unknown metadata. */
export function nativeFieldEdits(
  fields: readonly BitwardenPlainField[],
  input: SecretBackendItemInput,
): BitwardenFieldEdit[] {
  nativeFieldView(fields, input.kind === "login");
  const values = Object.entries(input.fields ?? {});
  if (
    input.kind !== "login" &&
    (input.secret || fields.some((field) => field.name === SECRET))
  )
    values.push([SECRET, input.secret]);
  if (input.kind === "secret" || fields.some((field) => field.name === KIND))
    values.push([KIND, input.kind === "secret" ? "secret" : "note"]);
  return values.flatMap(([name, value]) => {
    const indices = fields.flatMap((field, index) =>
      field.name === name ? [index] : [],
    );
    if (indices.length > 1)
      throw new SecretBackendError(
        "ambiguous",
        "A custom field name matches multiple fields.",
      );
    const index = indices[0] ?? -1;
    const prior = fields[index];
    if (prior?.value === value) return [];
    if (prior?.type === 3)
      throw new SecretBackendError(
        "configuration",
        "Linked custom fields keep their linked value.",
      );
    return [
      { index, name, value, type: prior?.type ?? (name === SECRET ? 1 : 0) },
    ];
  });
}
