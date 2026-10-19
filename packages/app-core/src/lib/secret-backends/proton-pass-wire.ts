import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";

export const PROTON_ITEM_MAX_BYTES = 1024 * 1024;
export const PROTON_ITEM_MAX_FIELDS = 4096;
const MAX_FIELD = 0x1fff_ffff;

export class ProtonWireError extends Error {
  constructor(readonly code: "format" | "limit" | "unsupported") {
    super("The Proton Pass item has an invalid or unsupported wire format.");
    this.name = "ProtonWireError";
  }
}

/** Share this budget while visiting the item's known nested messages. */
export type ProtonWireBudget = { remaining: number };
export type ProtonWireField = Readonly<{
  fieldNo: number;
  wireType: 0 | 1 | 2 | 5;
  /** Views into caller-owned immutable plaintext; unknown bytes stay opaque. */
  raw: Uint8Array;
  message: Uint8Array | null;
}>;

function bounded(bytes: Uint8Array): void {
  if (bytes.byteLength > PROTON_ITEM_MAX_BYTES)
    throw new ProtonWireError("limit");
}

function consume(budget: ProtonWireBudget): void {
  if (
    !Number.isInteger(budget.remaining) ||
    budget.remaining <= 0 ||
    budget.remaining > PROTON_ITEM_MAX_FIELDS
  )
    throw new ProtonWireError("limit");
  budget.remaining -= 1;
}

function lengthValue(reader: BinaryReader, bytes: Uint8Array): Uint8Array {
  const start = reader.pos;
  const length = reader.uint32();
  const width = reader.pos - start;
  if (width > 5 || (width === 5 && (bytes[reader.pos - 1] ?? 0) > 15))
    throw new ProtonWireError("format");
  if (length > reader.len - reader.pos) throw new ProtonWireError("format");
  const value = bytes.subarray(reader.pos, reader.pos + length);
  reader.pos += length;
  return value;
}

function skipValue(
  reader: BinaryReader,
  bytes: Uint8Array,
  wire: 0 | 1 | 5,
): void {
  if (wire === 0) {
    const start = reader.pos;
    reader.uint64();
    const width = reader.pos - start;
    if (width > 10 || (width === 10 && (bytes[reader.pos - 1] ?? 0) > 1))
      throw new ProtonWireError("format");
  } else {
    reader.skip(wire);
  }
}

/** Bounded one-message scan; recurse only through fields the item codec knows. */
export function readProtonFields(
  bytes: Uint8Array,
  budget: ProtonWireBudget = { remaining: PROTON_ITEM_MAX_FIELDS },
): readonly ProtonWireField[] {
  bounded(bytes);
  const reader = new BinaryReader(bytes);
  const fields: ProtonWireField[] = [];
  try {
    while (reader.pos < reader.len) {
      consume(budget);
      const start = reader.pos;
      const [fieldNo, wireType] = reader.tag();
      if (wireType === 3 || wireType === 4)
        throw new ProtonWireError("unsupported");
      const message = wireType === 2 ? lengthValue(reader, bytes) : null;
      if (wireType !== 2) skipValue(reader, bytes, wireType);
      fields.push({
        fieldNo,
        wireType,
        raw: bytes.subarray(start, reader.pos),
        message,
      });
    }
  } catch (error) {
    if (error instanceof ProtonWireError) throw error;
    throw new ProtonWireError("format");
  }
  return fields;
}

/** The genuine Proton decoder selects the last whole embedded message. */
export function lastProtonMessage(
  fields: readonly ProtonWireField[],
  fieldNo: number,
): Uint8Array | null {
  let last: Uint8Array | null = null;
  for (const field of fields) {
    if (field.fieldNo !== fieldNo) continue;
    if (field.wireType !== 2 || field.message === null)
      throw new ProtonWireError("format");
    last = field.message;
  }
  return last;
}

/** Replace the last length-delimited field; its string/bytes/message value stays opaque. */
export function replaceLastProtonBytes(
  bytes: Uint8Array,
  fieldNo: number,
  message: Uint8Array,
): Uint8Array {
  if (!Number.isInteger(fieldNo) || fieldNo <= 0 || fieldNo > MAX_FIELD)
    throw new ProtonWireError("format");
  const budget = { remaining: PROTON_ITEM_MAX_FIELDS };
  const fields = readProtonFields(bytes, budget);
  lastProtonMessage(fields, fieldNo);
  bounded(message);
  const replacement = new BinaryWriter()
    .tag(fieldNo, 2)
    .bytes(message)
    .finish();
  let index = -1;
  for (let position = 0; position < fields.length; position += 1)
    if (fields[position]?.fieldNo === fieldNo) index = position;
  const parts = fields.map((field, position) =>
    position === index ? replacement : field.raw,
  );
  if (index === -1) {
    consume(budget);
    parts.push(replacement);
  }
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  if (size > PROTON_ITEM_MAX_BYTES) throw new ProtonWireError("limit");
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
