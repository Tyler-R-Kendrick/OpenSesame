import { type CBORType, decodeCBOR, encodeCBOR } from "@levischuck/tiny-cbor";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";

export type BitwardenCborMap = Map<string | number, CBORType>;
export interface BitwardenNativeKey {
  algorithm: 0 | 3 | -70010 | -70011;
  material: Uint8Array;
  id: Uint8Array;
  operations: number[];
}
export const BITWARDEN_CBOR_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 16384;
const MAX_CONTAINER = 4096;
const MAX_DEPTH = 16;
const bad = () => new Error("Invalid Bitwarden encoded data.");
const algorithmSchema = z.union([z.literal(3), z.literal(-70010)]);
const operationsSchema = z
  .array(z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(6)]))
  .min(1)
  .max(4);

function readSize(
  view: DataView,
  offset: number,
  additional: number,
  negative: boolean,
) {
  if (additional < 24) return [additional, offset] as const;
  if (additional === 24) return [view.getUint8(offset), offset + 1] as const;
  if (additional === 25) return [view.getUint16(offset), offset + 2] as const;
  if (additional === 26) return [view.getUint32(offset), offset + 4] as const;
  if (additional !== 27) throw bad(); // No indefinite-length values.
  const large = view.getBigUint64(offset);
  if (large > BigInt(Number.MAX_SAFE_INTEGER) - (negative ? 1n : 0n))
    throw bad();
  return [Number(large), offset + 8] as const;
}

function simpleEnd(view: DataView, offset: number, additional: number): number {
  if ([20, 21, 22].includes(additional)) return offset;
  if (additional === 26 && Number.isFinite(view.getFloat32(offset)))
    return offset + 4;
  if (additional === 27 && Number.isFinite(view.getFloat64(offset)))
    return offset + 8;
  throw bad(); // Reject undefined, tags, nonfinite and unsupported simple values.
}

function stringEnd(
  bytes: Uint8Array,
  offset: number,
  size: number,
  text: boolean,
): number {
  if (size > bytes.length - offset) throw bad();
  if (text)
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset, offset + size),
    );
  return offset + size;
}

/** Resource preflight only; actual CBOR/duplicate-key decoding stays in the library. */
function preflight(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const remaining = [1];
  let offset = 0;
  let nodes = 0;
  while (remaining.length) {
    const depth = remaining.length - 1;
    if (!remaining[depth]) {
      remaining.pop();
      continue;
    }
    remaining[depth]--;
    if (++nodes > MAX_NODES) throw bad();
    const first = view.getUint8(offset++);
    const major = first >>> 5;
    const additional = first & 31;
    if (major === 7) {
      offset = simpleEnd(view, offset, additional);
      continue;
    }
    if (major === 6) throw bad();
    const [size, end] = readSize(view, offset, additional, major === 1);
    offset = end;
    if (major === 2 || major === 3) {
      offset = stringEnd(bytes, offset, size, major === 3);
    } else if (major === 4 || major === 5) {
      if (size > MAX_CONTAINER || remaining.length > MAX_DEPTH) throw bad();
      remaining.push(size * (major === 5 ? 2 : 1));
    }
  }
  if (offset !== bytes.length) throw bad();
}

function checkMaximum(maximum: number): void {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > BITWARDEN_CBOR_BYTES
  )
    throw bad();
}

/** Caller owns decoded values; the decoder never receives a pooled/sliced backing buffer. */
export function decodeBitwardenCbor(
  input: Uint8Array,
  maximum: number,
): CBORType {
  try {
    checkMaximum(maximum);
    if (!(input instanceof Uint8Array) || input.length > maximum) throw bad();
    const own = new Uint8Array(input);
    preflight(own);
    return decodeCBOR(new DataView(own.buffer));
  } catch {
    throw bad();
  }
}

function textSize(text: string): number {
  let size = 0;
  for (const scalar of text) {
    const point = scalar.codePointAt(0) ?? 0;
    if (point >= 0xd800 && point <= 0xdfff) throw bad();
    size += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  return size;
}

function headerSize(size: number): number {
  return size < 24 ? 1 : size < 256 ? 2 : size < 65536 ? 3 : 5;
}

function scalarSize(item: CBORType, maximum: number): number {
  if (item instanceof Uint8Array) return item.length + headerSize(item.length);
  if (z.string().safeParse(item).success) {
    const text = z.string().parse(item);
    if (text.length > maximum) throw bad();
    const size = textSize(text);
    return size + headerSize(size);
  }
  if (item === null || item === true || item === false) return 1;
  if (!z.number().finite().safeParse(item).success) throw bad();
  if (Number.isInteger(item) && !Number.isSafeInteger(item)) throw bad();
  return encodeCBOR(item).length;
}

/** Bound/cycle-check owned structured data before the mature encoder allocates. */
export function encodeBitwardenCbor(
  value: CBORType,
  maximum: number,
): Uint8Array {
  checkMaximum(maximum);
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let estimate = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current || ++nodes > MAX_NODES || current.depth > MAX_DEPTH)
      throw bad();
    const item = current.value;
    if (item instanceof Map || Array.isArray(item)) {
      const count = item instanceof Map ? item.size : item.length;
      if (seen.has(item) || count > MAX_CONTAINER) throw bad();
      seen.add(item);
      const children = item instanceof Map ? [...item].flat() : item;
      for (const child of children)
        pending.push({ value: child, depth: current.depth + 1 });
      estimate += headerSize(count);
    } else estimate += scalarSize(item, maximum);
    if (estimate > maximum) throw bad();
  }
  const encoded = encodeCBOR(value);
  if (encoded.length > maximum) throw bad();
  return encoded;
}

export function bitwardenCborMap(value: CBORType): BitwardenCborMap {
  if (!(value instanceof Map)) throw bad();
  return value;
}

export function bitwardenCborBytes(value: CBORType): Uint8Array {
  if (!(value instanceof Uint8Array)) throw bad();
  return value;
}

export function padBitwardenBytes(
  value: Uint8Array,
  minimum: number,
): Uint8Array {
  const padding = Math.max(1, minimum - value.length);
  if (padding > 255 || value.length >= BITWARDEN_CBOR_BYTES) throw bad();
  const result = new Uint8Array(value.length + padding).fill(padding);
  result.set(value);
  return result;
}

export function unpadBitwardenBytes(
  value: Uint8Array,
  minimum: number,
): Uint8Array {
  const padding = value[value.length - 1];
  if (
    !padding ||
    padding > value.length ||
    value.length < minimum ||
    padding !== Math.max(1, minimum - (value.length - padding)) ||
    !value.subarray(value.length - padding).every((byte) => byte === padding)
  )
    throw bad();
  return value.slice(0, -padding);
}

function decodeKeyBytes(encoded: Uint8Array): BitwardenNativeKey {
  if (!(encoded instanceof Uint8Array) || encoded.length > 4096) throw bad();
  if (encoded.length === 32 || encoded.length === 64) {
    // RFC9679 symmetric thumbprint: deterministic map of required kty/k only.
    const thumbprint = sha256(
      encodeCBOR(
        new Map<number, CBORType>([
          [1, 4],
          [-1, encoded],
        ]),
      ),
    );
    return {
      algorithm: encoded.length === 64 ? -70011 : 0,
      material: encoded.slice(),
      id: thumbprint.slice(0, 16),
      operations: encoded.length === 64 ? [3, 4, 5, 6] : [4],
    };
  }
  const unpadded = unpadBitwardenBytes(encoded, 65);
  let decodedMaterial: Uint8Array | undefined;
  try {
    const fields = bitwardenCborMap(decodeBitwardenCbor(unpadded, 4096));
    if (fields.size !== 5 || fields.get(1) !== 4) throw bad();
    const algorithm = algorithmSchema.parse(fields.get(3));
    const id = bitwardenCborBytes(fields.get(2));
    const material = bitwardenCborBytes(fields.get(-1));
    decodedMaterial = material;
    const operations = operationsSchema.parse(fields.get(4));
    if (
      id.length !== 16 ||
      material.length !== 32 ||
      new Set(operations).size !== operations.length
    )
      throw bad();
    return {
      algorithm,
      id: id.slice(),
      material: material.slice(),
      operations,
    };
  } finally {
    unpadded.fill(0);
    decodedMaterial?.fill(0);
  }
}

export function decodeBitwardenKey(encoded: Uint8Array): BitwardenNativeKey {
  try {
    return decodeKeyBytes(encoded);
  } catch {
    throw bad();
  }
}

export function encodeBitwardenKey(key: BitwardenNativeKey): Uint8Array {
  if (key.algorithm === 0 || key.algorithm === -70011) {
    if (key.material.length !== (key.algorithm === 0 ? 32 : 64)) throw bad();
    return key.material.slice();
  }
  const encoded = encodeBitwardenCbor(
    new Map<number, CBORType>([
      [1, 4],
      [2, key.id],
      [3, key.algorithm],
      [4, key.operations],
      [-1, key.material],
    ]),
    4096,
  );
  const result = padBitwardenBytes(encoded, 65);
  encoded.fill(0);
  const checked = decodeBitwardenKey(result);
  checked.material.fill(0);
  return result;
}
