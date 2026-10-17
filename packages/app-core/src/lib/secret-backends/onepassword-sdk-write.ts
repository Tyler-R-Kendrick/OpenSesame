import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { z } from "zod";
import {
  type OnePasswordSdkReadItem,
  readOnePasswordSdkItem,
} from "./onepassword-sdk-codec.js";
import { OnePasswordCommandSchema } from "./onepassword-worker-protocol.js";
import { SecretBackendError, type SecretBackendItemInput } from "./types.js";

const MAX_BYTES = 1024 * 1024;
const Text = z.string().max(MAX_BYTES);
const Input = z.object({
  name: Text.refine((value) => Boolean(value.trim())),
  notes: Text,
  secret: Text,
  kind: z.enum(["note", "login", "secret"]).optional(),
  username: Text.optional(),
  url: Text.optional(),
  fields: z.record(z.string().max(1024), Text).optional(),
  id: z.string().optional(),
});
type Editor = z.infer<typeof Input>;
const InputKey = Input.keyof();
const categories = {
  note: "SecureNote",
  login: "Login",
  secret: "ApiCredentials",
};

function invalid(): never {
  throw new SecretBackendError(
    "configuration",
    "Check the native 1Password item fields and the 1 MiB write limit.",
  );
}
function unsupported(): never {
  throw new SecretBackendError(
    "unsupported",
    "This item type cannot expose the supplied fields or change category.",
  );
}
function ambiguous(): never {
  throw new SecretBackendError(
    "ambiguous",
    "A native field or section conflicts with the requested edit.",
  );
}

function entries(value: BoundaryValue): [string, BoundaryValue][] {
  if (
    !isJsonObject(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1024) return invalid();
  return keys.map((key) => {
    if (!isString(key) || key.length > 1024) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      return invalid();
    return [key, descriptor.value];
  });
}
function customValues(
  value: BoundaryValue,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    entries(value).map(([title, text]) => {
      if (!isString(text)) return invalid();
      return [title, text];
    }),
  );
}
function editor(input: SecretBackendItemInput): Editor {
  try {
    let characters = 0;
    for (const [key, value] of entries(input)) {
      if (!InputKey.safeParse(key).success) return invalid();
      const values =
        key === "fields" && value !== undefined
          ? entries(value).flat()
          : [value];
      for (const text of values) {
        if (text === undefined) continue;
        if (!isString(text)) return invalid();
        characters += text.length;
        if (characters > MAX_BYTES) return invalid();
      }
    }
    const parsed = Input.safeParse(input);
    if (!parsed.success) return invalid();
    return { ...parsed.data, fields: customValues(input.fields) };
  } catch {
    return invalid();
  }
}
function permitted(input: Editor, kind: "note" | "login" | "secret"): void {
  if (input.kind && input.kind !== kind) unsupported();
  if (kind !== "login" && (input.username || input.url)) unsupported();
  if (kind === "note" && input.secret) unsupported();
}
function checked(
  name: "ItemsCreate" | "ItemsPut",
  value: JsonObject,
): JsonObject {
  try {
    const command =
      name === "ItemsCreate" ? { name, params: value } : { name, item: value };
    if (!OnePasswordCommandSchema.safeParse(command).success) return invalid();
    return value;
  } catch {
    return invalid();
  }
}
function objects(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return invalid();
  return value.map((entry) => {
    if (!isJsonObject(entry)) return invalid();
    return entry;
  });
}
function nextId(prefix: string, used: Set<string>): string {
  let suffix = 1;
  while (used.has(`${prefix}_${suffix}`)) suffix += 1;
  const id = `${prefix}_${suffix}`;
  used.add(id);
  return id;
}
function field(
  id: string,
  fieldType: string,
  value: string,
  title = id,
): JsonObject {
  return { id, title, fieldType, value };
}
function website(url: string): JsonObject {
  return { url, label: "website", autofillBehavior: "AnywhereOnWebsite" };
}
function addCustom(
  input: Editor,
  fields: JsonObject[],
  sections: JsonObject[],
  current?: OnePasswordSdkReadItem,
): void {
  const usedFields = new Set(fields.map((entry) => String(entry.id)));
  const usedSections = new Set(sections.map((entry) => String(entry.id)));
  let sectionId: string | undefined;
  for (const [title, value] of Object.entries(input.fields ?? {})) {
    const existing = current?.fields.custom.find(
      (entry) => entry.title === title,
    );
    if (existing) {
      const index = fields.findIndex((entry) => entry.id === existing.id);
      if (index < 0) invalid();
      fields[index] = { ...fields[index], value };
      continue;
    }
    if (
      current?.data.fields.some(
        (entry) =>
          entry.title === title &&
          !["Text", "Concealed"].includes(entry.fieldType),
      )
    )
      ambiguous();
    if (!sectionId) {
      sectionId = nextId("opensesame_custom", usedSections);
      sections.push({ id: sectionId, title: "OpenSesame" });
    }
    fields.push({
      ...field(nextId("opensesame_field", usedFields), "Text", value, title),
      sectionId,
    });
  }
}

/** Construct native SDK ItemCreateParams; no provider call or account admission. */
export function createOnePasswordSdkItem(
  value: SecretBackendItemInput,
  vaultId: string,
): JsonObject {
  const input = editor(value);
  const kind = input.kind ?? "note";
  permitted(input, kind);
  if (!z.string().min(1).max(1024).safeParse(vaultId).success) invalid();
  const fields: JsonObject[] = [];
  const sections: JsonObject[] = [];
  if (kind === "login") {
    fields.push(field("username", "Text", input.username ?? ""));
    fields.push(field("password", "Concealed", input.secret));
  } else if (kind === "secret") {
    sections.push({ id: "opensesame", title: "OpenSesame" });
    fields.push({
      ...field("opensesame_secret", "Concealed", input.secret, "Secret"),
      sectionId: "opensesame",
    });
  }
  addCustom(input, fields, sections);
  if (fields.length > 1024 || sections.length > 1024) invalid();
  return checked("ItemsCreate", {
    category: categories[kind],
    vaultId,
    title: input.name,
    notes: input.notes,
    fields,
    sections,
    tags: [],
    websites: kind === "login" && input.url ? [website(input.url)] : [],
  });
}

function replaceValue(
  fields: JsonObject[],
  id: string | undefined,
  value: string | undefined,
): void {
  if (id === undefined || value === undefined) return;
  const index = fields.findIndex((entry) => entry.id === id);
  if (index < 0) invalid();
  fields[index] = { ...fields[index], value };
}
function primaryFields(
  input: Editor,
  current: OnePasswordSdkReadItem,
  fields: JsonObject[],
  sections: JsonObject[],
): void {
  const kind = current.normalized.kind;
  const username = current.fields.username;
  const secret = current.fields.secret;
  replaceValue(fields, username?.id, input.username);
  replaceValue(fields, secret?.id, input.secret);
  if (kind === "login") {
    if (!username && input.username)
      fields.push(field("username", "Text", input.username));
    if (!secret && input.secret)
      fields.push(field("password", "Concealed", input.secret));
  } else if (kind === "secret" && !secret && input.secret) {
    if (sections.some((section) => section.id === "opensesame")) ambiguous();
    sections.push({ id: "opensesame", title: "OpenSesame" });
    fields.push({
      ...field("opensesame_secret", "Concealed", input.secret, "Secret"),
      sectionId: "opensesame",
    });
  }
}
function websites(
  input: Editor,
  current: OnePasswordSdkReadItem,
): JsonObject[] {
  const rows = objects(current.raw.websites);
  if (current.normalized.kind !== "login" || input.url === undefined)
    return rows;
  if (!input.url) return rows.slice(1);
  return rows.length
    ? [{ ...rows[0], url: input.url }, ...rows.slice(1)]
    : [website(input.url)];
}

/** Patch the complete current ItemsGet JSON, retaining version and unknown metadata. */
export function patchOnePasswordSdkItem(
  raw: BoundaryValue,
  value: SecretBackendItemInput,
  vaultId: string,
  itemId: string,
): JsonObject {
  const current = readOnePasswordSdkItem(raw, vaultId, itemId);
  const input = editor(value);
  permitted(input, current.normalized.kind);
  const fields = objects(current.raw.fields).slice();
  const sections = objects(current.raw.sections).slice();
  primaryFields(input, current, fields, sections);
  addCustom(input, fields, sections, current);
  if (fields.length > 1024 || sections.length > 1024) invalid();
  const item = {
    ...current.raw,
    title: input.name,
    notes: input.notes,
    fields,
    sections,
    websites: websites(input, current),
  };
  const result = checked("ItemsPut", item);
  readOnePasswordSdkItem(result, vaultId, itemId);
  return result;
}
