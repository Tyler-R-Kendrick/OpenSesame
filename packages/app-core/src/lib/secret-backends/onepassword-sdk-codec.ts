import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { z } from "zod";
import {
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemSummary,
} from "./types.js";

const MAX_BYTES = 4 * 1024 * 1024;
const Id = z.string().min(1).max(1024);
const Text = z.string().max(MAX_BYTES);
const DateText = z.iso.datetime();
const Website = z.object({
  url: Text,
  label: Text,
  autofillBehavior: z.enum(["AnywhereOnWebsite", "ExactDomain", "Never"]),
});
const Overview = z.object({
  id: Id,
  title: Text,
  category: Id,
  vaultId: Id,
  websites: z.array(Website).max(1024),
  tags: z.array(Text).max(1024),
  createdAt: DateText,
  updatedAt: DateText,
  state: z.enum(["active", "archived"]),
});
const Field = z.object({
  id: Id,
  title: Text,
  sectionId: z.string().max(1024).nullish(),
  fieldType: Id,
  value: Text,
});
const FileAttributes = z.object({
  id: Id,
  name: Text,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const Item = Overview.omit({ state: true }).extend({
  fields: z.array(Field).max(1024),
  sections: z.array(z.object({ id: Id, title: Text })).max(1024),
  notes: Text,
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  files: z
    .array(
      z.object({ attributes: FileAttributes, sectionId: Text, fieldId: Id }),
    )
    .max(1024),
  document: FileAttributes.nullish(),
});
type NativeItem = z.infer<typeof Item>;
type NativeField = z.infer<typeof Field>;
type NativeOverview = z.infer<typeof Overview>;
type EditableFields = {
  username?: NativeField;
  secret?: NativeField;
  custom: NativeField[];
};

/** Raw JSON remains the lossless base for a later full-item native update. */
export type OnePasswordSdkReadItem = {
  raw: JsonObject;
  data: NativeItem;
  fields: EditableFields;
  normalized: SecretBackendItem;
};

function unreadable(): never {
  throw new SecretBackendError(
    "response",
    "1Password returned an unreadable native item or list.",
  );
}
function ambiguous(): never {
  throw new SecretBackendError(
    "ambiguous",
    "The native item has ambiguous field or section mappings.",
  );
}
function unsupported(): never {
  throw new SecretBackendError(
    "unsupported",
    "This native item category or built-in field type is not supported.",
  );
}

function dataProperty(value: BoundaryValue, key: string): BoundaryValue {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
    return unreadable();
  return descriptor.value;
}

type JsonBudget = { characters: number };
function charge(budget: JsonBudget, length: number): void {
  budget.characters += length;
  if (budget.characters > MAX_BYTES) unreadable();
}
function jsonContainer(value: BoundaryValue): JsonObject | BoundaryValue[] {
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 20_000
    )
      return unreadable();
    return value;
  }
  if (
    !isJsonObject(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return unreadable();
  return value;
}
function children(value: BoundaryValue, budget: JsonBudget): BoundaryValue[] {
  const container = jsonContainer(value);
  const array = Array.isArray(container);
  const keys = Reflect.ownKeys(container);
  if (keys.length > 20_000) return unreadable();
  if (array && keys.length !== container.length + 1) return unreadable();
  const result: BoundaryValue[] = [];
  for (const key of keys) {
    if (!isString(key) || key.length > 1024) return unreadable();
    if (array && key === "length") continue;
    if (!array) charge(budget, key.length);
    if (
      array &&
      (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= container.length)
    )
      return unreadable();
    result.push(dataProperty(container, key));
  }
  return result;
}

/** Check plain, bounded JSON before any schema can read an accessor or toJSON. */
function nativeJson(value: BoundaryValue): JsonValue {
  try {
    const pending = [{ value, depth: 0 }];
    const budget = { characters: 0 };
    let nodes = 0;
    while (pending.length) {
      const entry = pending.pop();
      if (!entry || ++nodes > 20_000 || entry.depth > 20) return unreadable();
      const part = entry.value;
      if (part === null || isBoolean(part)) continue;
      if (isString(part)) {
        charge(budget, part.length);
        continue;
      }
      if (isNumber(part)) {
        if (!Number.isFinite(part)) return unreadable();
        continue;
      }
      for (const child of children(part, budget)) {
        if (pending.length + nodes >= 20_000) return unreadable();
        pending.push({ value: child, depth: entry.depth + 1 });
      }
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES)
      return unreadable();
    return overlapCast(value);
  } catch {
    return unreadable();
  }
}

function kind(category: string): SecretBackendItemSummary["kind"] | null {
  if (category === "Login") return "login";
  if (category === "SecureNote") return "note";
  if (category === "ApiCredentials") return "secret";
  return null;
}
function summary(row: NativeOverview): SecretBackendItemSummary {
  const itemKind = kind(row.category);
  if (!itemKind) return unsupported();
  return { id: row.id, name: row.title, kind: itemKind };
}
function scope(actual: string, expected: string): void {
  if (!Id.safeParse(expected).success || actual !== expected)
    throw new SecretBackendError(
      "response",
      "1Password returned an item outside the configured vault or selection.",
    );
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) ambiguous();
}
function overviews(value: BoundaryValue, vaultId: string): NativeOverview[] {
  scope(vaultId, vaultId);
  const parsed = z.array(Overview).max(4096).safeParse(nativeJson(value));
  if (!parsed.success) return unreadable();
  for (const row of parsed.data) scope(row.vaultId, vaultId);
  unique(parsed.data.map((row) => row.id));
  return parsed.data;
}

/** Archive state belongs to the SDK overview, not to a full native Item. */
export function onePasswordSdkSummaries(
  value: BoundaryValue,
  vaultId: string,
): SecretBackendItemSummary[] {
  return overviews(value, vaultId)
    .filter((row) => row.state === "active" && kind(row.category) !== null)
    .map(summary);
}

export function onePasswordSdkSelect(
  value: BoundaryValue,
  vaultId: string,
  selector: string,
): string {
  if (!Id.safeParse(selector).success) return unreadable();
  const rows = overviews(value, vaultId);
  const exact = rows.find((row) => row.id === selector);
  const matches = exact
    ? [exact].filter((row) => row.state === "active")
    : rows.filter(
        (row) =>
          row.state === "active" &&
          kind(row.category) !== null &&
          row.title === selector,
      );
  if (matches.length > 1)
    throw new SecretBackendError(
      "ambiguous",
      "Choose a native item by ID because this name matches more than one item.",
    );
  const selected = matches[0];
  if (!selected)
    throw new SecretBackendError("not-found", "The native item was not found.");
  summary(selected);
  return selected.id;
}

function builtin(item: NativeItem, id: string, type: string) {
  const field = item.fields.find((entry) => entry.id === id);
  if (field?.sectionId) return ambiguous();
  if (field && field.fieldType !== type) return unsupported();
  return field;
}
function secretField(item: NativeItem): NativeField | undefined {
  const owned = item.fields.find((field) => field.id === "opensesame_secret");
  if (owned) {
    if (owned.fieldType !== "Concealed") return unsupported();
    if (owned.sectionId !== "opensesame") return ambiguous();
    return owned;
  }
  const candidates = item.fields.filter(
    (field) => field.fieldType === "Concealed",
  );
  if (candidates.length > 1) return ambiguous();
  return candidates[0];
}
function fieldMappings(item: NativeItem): EditableFields {
  unique(item.fields.map((field) => field.id));
  unique(item.sections.map((section) => section.id));
  const sections = new Set(item.sections.map((section) => section.id));
  for (const field of item.fields)
    if (field.sectionId && !sections.has(field.sectionId)) return unreadable();
  const login = item.category === "Login";
  const username = login ? builtin(item, "username", "Text") : undefined;
  const secret = login
    ? builtin(item, "password", "Concealed")
    : item.category === "ApiCredentials"
      ? secretField(item)
      : undefined;
  const custom = item.fields.filter(
    (field) =>
      field !== username &&
      field !== secret &&
      ["Text", "Concealed"].includes(field.fieldType),
  );
  unique(custom.map((field) => field.title));
  return { username, secret, custom };
}

/** Decode only full ItemsGet/ItemsPut results, retaining all native wire metadata. */
export function readOnePasswordSdkItem(
  value: BoundaryValue,
  vaultId: string,
  itemId: string,
): OnePasswordSdkReadItem {
  const raw = nativeJson(value);
  const parsed = Item.safeParse(raw);
  if (!parsed.success || !isJsonObject(raw)) return unreadable();
  const data = parsed.data;
  scope(data.vaultId, vaultId);
  scope(data.id, itemId);
  const itemKind = kind(data.category);
  if (!itemKind) return unsupported();
  const fields = fieldMappings(data);
  return {
    raw,
    data,
    fields,
    normalized: {
      id: data.id,
      name: data.title,
      kind: itemKind,
      notes: data.notes,
      secret: fields.secret?.value ?? "",
      username: fields.username?.value ?? "",
      url: itemKind === "login" ? (data.websites[0]?.url ?? "") : "",
      fields: Object.fromEntries(
        fields.custom.map((field) => [field.title, field.value]),
      ),
    },
  };
}
