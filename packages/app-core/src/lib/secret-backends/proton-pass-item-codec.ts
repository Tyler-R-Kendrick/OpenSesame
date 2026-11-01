import { BinaryWriter } from "@bufbuild/protobuf/wire";
import {
  PROTON_ITEM_MAX_BYTES,
  PROTON_ITEM_MAX_FIELDS,
  type ProtonWireBudget,
  ProtonWireError,
  type ProtonWireField,
  lastProtonMessage,
  readProtonFields,
  replaceLastProtonBytes,
} from "./proton-pass-wire.js";
import { SecretBackendError, type SecretBackendItemInput } from "./types.js";

type Kind = "note" | "login";
export type ProtonItemProjection = {
  name: string;
  notes: string;
  secret: string;
  kind: Kind;
  username: string;
  url: string;
};
type Message = Readonly<{
  bytes: Uint8Array;
  fields: readonly ProtonWireField[];
}>;
type ParsedItem = Readonly<{
  root: Message;
  metadata: Message;
  content: Message;
  model: Message;
  kind: Kind;
}>;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function unsupported(): never {
  throw new SecretBackendError(
    "unsupported",
    "This operation requires a Proton Pass note or login and its supported fields.",
  );
}

function text(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ProtonWireError("format");
  }
}

function value(field: ProtonWireField): Uint8Array {
  if (field.wireType !== 2 || field.message === null)
    throw new ProtonWireError("format");
  return field.message;
}

function string(fields: readonly ProtonWireField[], fieldNo: number): string {
  const bytes = lastProtonMessage(fields, fieldNo);
  return bytes === null ? "" : text(bytes);
}

function scan(bytes: Uint8Array, budget: ProtonWireBudget): Message {
  return { bytes, fields: readProtonFields(bytes, budget) };
}

function metadataMessage(bytes: Uint8Array, budget: ProtonWireBudget): Message {
  const metadata = scan(bytes, budget);
  for (const entry of metadata.fields)
    if (entry.fieldNo >= 1 && entry.fieldNo <= 3) text(value(entry));
  return metadata;
}

function contentMessage(bytes: Uint8Array, budget: ProtonWireBudget) {
  const content = scan(bytes, budget);
  let model: Message | null = null;
  let kind: Kind | null = null;
  for (const entry of content.fields) {
    if (entry.fieldNo < 2 || entry.fieldNo > 9) continue;
    kind = entry.fieldNo === 2 ? "note" : null;
    if (entry.fieldNo === 3) kind = "login";
    model = scan(value(entry), budget);
    if (kind !== "login") continue;
    for (const part of model.fields)
      if ([1, 2, 3, 4, 6].includes(part.fieldNo)) text(value(part));
  }
  return { content, model, kind };
}

function parse(bytes: Uint8Array): ParsedItem {
  const budget = { remaining: PROTON_ITEM_MAX_FIELDS };
  const root = scan(bytes, budget);
  let metadata: Message | null = null;
  let selected: ReturnType<typeof contentMessage> | null = null;
  for (const field of root.fields) {
    if (field.fieldNo === 1) metadata = metadataMessage(value(field), budget);
    if (field.fieldNo === 2) selected = contentMessage(value(field), budget);
  }
  if (metadata === null || selected === null || selected.model === null)
    throw new ProtonWireError("format");
  if (selected.kind === null) unsupported();
  return {
    root,
    metadata,
    content: selected.content,
    model: selected.model,
    kind: selected.kind,
  };
}

/** Untouched platform, passkey, extra-field and unknown spans remain opaque and exact. */
export function decodeProtonItem(bytes: Uint8Array): ProtonItemProjection {
  const item = parse(bytes);
  const login = item.kind === "login" ? item.model.fields : [];
  const firstUrl = login.find((field) => field.fieldNo === 3);
  return {
    name: string(item.metadata.fields, 1),
    notes: string(item.metadata.fields, 2),
    kind: item.kind,
    secret: string(login, 2),
    username: string(login, 6),
    url: firstUrl === undefined ? "" : text(value(firstUrl)),
  };
}

function validate(input: SecretBackendItemInput, kind: Kind): void {
  if ((input.kind !== undefined && input.kind !== kind) || !input.name.trim())
    unsupported();
  if (input.fields !== undefined && Object.keys(input.fields).length > 0)
    unsupported();
  if (kind === "note" && (input.secret || input.username || input.url))
    unsupported();
  for (const entry of [
    input.name,
    input.notes,
    input.secret,
    input.username,
    input.url,
  ])
    if (
      entry !== undefined &&
      encoder.encode(entry).byteLength > PROTON_ITEM_MAX_BYTES
    )
      throw new ProtonWireError("limit");
}

function set(bytes: Uint8Array, fieldNo: number, entry: string): Uint8Array {
  return replaceLastProtonBytes(bytes, fieldNo, encoder.encode(entry));
}

function firstUrl(bytes: Uint8Array, url: string): Uint8Array {
  const fields = readProtonFields(bytes);
  const index = fields.findIndex((field) => field.fieldNo === 3);
  if (index === -1) return set(bytes, 3, url);
  const writer = new BinaryWriter();
  for (const [position, field] of fields.entries()) {
    if (position === index) writer.tag(3, 2).string(url);
    else writer.raw(field.raw);
  }
  return writer.finish();
}

/** Edit the visible final whole message; earlier duplicates never regain authority. */
export function updateProtonItem(
  bytes: Uint8Array,
  input: SecretBackendItemInput,
): Uint8Array {
  const item = parse(bytes);
  validate(input, item.kind);
  let metadata = set(item.metadata.bytes, 1, input.name);
  metadata = set(metadata, 2, input.notes);
  let result = replaceLastProtonBytes(bytes, 1, metadata);
  if (item.kind === "login") {
    let login = set(item.model.bytes, 2, input.secret);
    // Omitting optional fields leaves their original raw bytes unchanged.
    if (input.username !== undefined) login = set(login, 6, input.username);
    if (input.url !== undefined) login = firstUrl(login, input.url);
    const content = replaceLastProtonBytes(item.content.bytes, 3, login);
    result = replaceLastProtonBytes(result, 2, content);
  }
  // Revalidate the combined nested field budget after any appended fields.
  parse(result);
  return result;
}

export function createProtonItem(input: SecretBackendItemInput): Uint8Array {
  const kind = input.kind ?? "note";
  if (kind !== "note" && kind !== "login") unsupported();
  validate(input, kind);
  let metadata = set(new Uint8Array(), 1, input.name);
  metadata = set(metadata, 2, input.notes);
  metadata = set(metadata, 3, crypto.randomUUID());
  let model: Uint8Array = new Uint8Array();
  if (kind === "login") {
    model = set(model, 2, input.secret);
    model = set(model, 6, input.username ?? "");
    model = set(model, 3, input.url ?? "");
  }
  const content = replaceLastProtonBytes(
    new Uint8Array(),
    kind === "note" ? 2 : 3,
    model,
  );
  let result = replaceLastProtonBytes(new Uint8Array(), 1, metadata);
  result = replaceLastProtonBytes(result, 2, content);
  parse(result);
  return result;
}
