/**
 * A bounded ASN.1 DER reader. It recognises definite-length, single-byte or
 * long-form lengths only; indefinite lengths, constructed primitive values and
 * trailing bytes are refused. No node is trusted until its range fits.
 */

export type DerNode = {
  readonly tag: number;
  readonly content: Uint8Array;
};

export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerError";
  }
}

const MAX_CHILDREN = 256;
const MAX_DEPTH = 24;

/** A DER length, and the offset just past its encoding. */
type DerLength = { length: number; next: number };

function readLength(bytes: Uint8Array, at: number): DerLength {
  const first = bytes[at];
  if (first === undefined) throw new DerError("missing DER length");
  if (first < 0x80) return { length: first, next: at + 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 4 || at + 1 + count > bytes.length)
    throw new DerError("bad DER length");
  let length = 0;
  for (let index = 0; index < count; index += 1)
    length = length * 256 + (bytes[at + 1 + index] ?? 0);
  if (length < 0x80) throw new DerError("non-minimal DER length");
  return { length, next: at + 1 + count };
}

/** One TLV, and the offset just past it. */
export type DerRead = { node: DerNode; next: number };

/** Read exactly one definite-length TLV at `at`; `next` must be its end. */
export function readDer(bytes: Uint8Array, at = 0): DerRead {
  const tag = bytes[at];
  if (tag === undefined) throw new DerError("missing DER tag");
  const length = readLength(bytes, at + 1);
  const end = length.next + length.length;
  if (end > bytes.length) throw new DerError("DER value exceeds its buffer");
  return {
    node: { tag, content: bytes.subarray(length.next, end) },
    next: end,
  };
}

/** All children of a constructed value, with no trailing bytes. */
export function children(node: DerNode, depth = 0): DerNode[] {
  if (depth > MAX_DEPTH) throw new DerError("DER nesting is too deep");
  const out: DerNode[] = [];
  let at = 0;
  while (at < node.content.length) {
    if (out.length >= MAX_CHILDREN) throw new DerError("too many DER children");
    const read = readDer(node.content, at);
    out.push(read.node);
    at = read.next;
  }
  return out;
}

export function expectTag(node: DerNode, tag: number, what: string): void {
  if (node.tag !== tag) throw new DerError(`${what} has the wrong tag`);
}

export function sequence(node: DerNode, what: string): DerNode[] {
  expectTag(node, 0x30, what);
  return children(node);
}

/** Decode a dotted OBJECT IDENTIFIER, including multi-byte arcs. */
export function objectIdentifier(node: DerNode): string {
  expectTag(node, 0x06, "OID");
  const arcs: number[] = [];
  let value = 0;
  for (const byte of node.content) {
    value = value * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(value))
      throw new DerError("OID arc is too large");
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  if ((node.content[node.content.length - 1] ?? 0) & 0x80)
    throw new DerError("OID has a truncated arc");
  const first = arcs.shift();
  if (first === undefined) throw new DerError("OID has no arcs");
  const top = first < 40 ? 0 : first < 80 ? 1 : 2;
  return [top, first - top * 40, ...arcs].join(".");
}

export function stringValue(node: DerNode): string | null {
  try {
    if (node.tag === 0x0c)
      return new TextDecoder("utf-8", { fatal: true }).decode(node.content);
    if (node.tag === 0x13 || node.tag === 0x16)
      return String.fromCharCode(...node.content);
    if (node.tag === 0x1e) {
      let out = "";
      for (let at = 0; at + 1 < node.content.length; at += 2)
        out += String.fromCharCode(
          ((node.content[at] ?? 0) << 8) | (node.content[at + 1] ?? 0),
        );
      return out;
    }
  } catch {
    return null;
  }
  return null;
}

/** Integer magnitude without its sign padding. */
export function integerBytes(node: DerNode): Uint8Array {
  expectTag(node, 0x02, "INTEGER");
  let at = 0;
  while (at < node.content.length - 1 && node.content[at] === 0) at += 1;
  return node.content.subarray(at);
}

export function bitStringBytes(node: DerNode): Uint8Array {
  expectTag(node, 0x03, "BIT STRING");
  if (node.content.length === 0 || (node.content[0] ?? 0) > 7)
    throw new DerError("bad BIT STRING");
  return node.content.subarray(1);
}

/** UTCTime/GeneralizedTime to an ISO instant; only the RFC 5280 Z form. */
export function timeValue(node: DerNode): string | null {
  const text = String.fromCharCode(...node.content);
  let year: number;
  let rest: string;
  if (node.tag === 0x17 && /^\d{12}Z$/u.test(text)) {
    const two = Number(text.slice(0, 2));
    year = two >= 50 ? 1900 + two : 2000 + two;
    rest = text.slice(2, 12);
  } else if (node.tag === 0x18 && /^\d{14}Z$/u.test(text)) {
    year = Number(text.slice(0, 4));
    rest = text.slice(4, 14);
  } else return null;
  const month = Number(rest.slice(0, 2));
  const day = Number(rest.slice(2, 4));
  const hour = Number(rest.slice(4, 6));
  const minute = Number(rest.slice(6, 8));
  const second = Number(rest.slice(8, 10));
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  return date.toISOString();
}
