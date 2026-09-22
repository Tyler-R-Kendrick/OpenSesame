/**
 * Physical-field collection and RFC 8941 decoding for the two RFC 9440 fields.
 * Turns header text into decoded byte sequences and nothing more; `parse.ts`
 * looks inside the certificates.
 */
import { type Item, type List, parseItem, parseList } from "structured-headers";
import { type IngressField, ingressError } from "./error.js";
import type { IngressLimits } from "./limits.js";

/** One physical header field as it was received: `[name, value]`. */
export type HeaderPair = readonly [name: string, value: string];

const LEAF: IngressField = "client-cert";
const CHAIN: IngressField = "client-cert-chain";

export interface RawFields {
  readonly leaf: readonly string[];
  readonly chain: readonly string[];
}

/** True when at least one RFC 9440 field is present, whatever its state. */
export function hasClientCertFields(headers: Iterable<HeaderPair>): boolean {
  for (const [name] of headers) {
    const lower = name.toLowerCase();
    if (lower === LEAF || lower === CHAIN) return true;
  }
  return false;
}

/** Collects the physical fields and applies the total-bytes limit before anything is decoded. */
export function collect(
  headers: Iterable<HeaderPair>,
  limits: IngressLimits,
): RawFields {
  const leaf: string[] = [];
  const chain: string[] = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === LEAF) leaf.push(value);
    else if (lower === CHAIN) chain.push(value);
  }
  let total = 0;
  for (const value of leaf) total += value.length;
  for (const value of chain) total += value.length;
  if (total > limits.maxTotalHeaderBytes)
    throw ingressError("header_bytes_exceeded");
  if (leaf.length > 1) throw ingressError("leaf_repeated", LEAF);
  if (leaf.length === 0) throw ingressError("leaf_missing", LEAF);
  return { leaf, chain };
}

/** Decodes the singleton Client-Cert item. */
export function decodeLeaf(value: string): Uint8Array {
  checkVisibleAscii(value, LEAF);
  if (isBlank(value)) throw ingressError("empty_item", LEAF);
  let item: Item;
  try {
    item = parseItem(value);
  } catch {
    throw ingressError("malformed_structured_field", LEAF);
  }
  const bytes = byteSequence(item, LEAF);
  checkCanonical(value, [bytes], LEAF);
  return bytes;
}

/** Decodes one physical Client-Cert-Chain field into its members. */
export function decodeChainField(value: string): Uint8Array[] {
  checkVisibleAscii(value, CHAIN);
  if (isBlank(value)) throw ingressError("empty_item", CHAIN);
  let list: List;
  try {
    list = parseList(value);
  } catch {
    throw ingressError("malformed_structured_field", CHAIN);
  }
  if (list.length === 0) throw ingressError("empty_item", CHAIN);
  const members: Uint8Array[] = [];
  for (const entry of list) {
    // An Inner List is [Item[], Parameters]; an Item is [BareItem, Parameters].
    if (Array.isArray(entry[0])) throw ingressError("not_byte_sequence", CHAIN);
    members.push(byteSequence(entry as Item, CHAIN));
  }
  checkCanonical(value, members, CHAIN);
  return members;
}

function byteSequence(item: Item, field: IngressField): Uint8Array {
  const [bare, params] = item;
  if (!(bare instanceof ArrayBuffer))
    throw ingressError("not_byte_sequence", field);
  if (params.size > 0) throw ingressError("parameters_present", field);
  if (bare.byteLength === 0) throw ingressError("empty_item", field);
  return new Uint8Array(bare);
}

function isBlank(value: string): boolean {
  return /^[ \t]*$/.test(value);
}

/** Text outside visible ASCII (plus SP / HTAB) is never a valid structured field. */
function checkVisibleAscii(value: string, field: IngressField): void {
  if (!/^[\x20-\x7e\t]*$/.test(value))
    throw ingressError("malformed_structured_field", field);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * RFC 8941 lets parsers tolerate missing padding and stray pad bits; both
 * libraries do. After a structurally successful parse the value is known to
 * be only byte sequences separated by commas and OWS, so every `:...:`
 * segment must equal the canonical re-encoding of the member decoded from it.
 */
function checkCanonical(
  value: string,
  members: readonly Uint8Array[],
  field: IngressField,
): void {
  let index = 0;
  for (const member of members) {
    while (
      index < value.length &&
      (value[index] === " " || value[index] === "\t" || value[index] === ",")
    ) {
      index += 1;
    }
    if (value[index] !== ":")
      throw ingressError("malformed_structured_field", field);
    index += 1;
    const end = value.indexOf(":", index);
    if (end === -1) throw ingressError("malformed_structured_field", field);
    if (value.slice(index, end) !== toBase64(member))
      throw ingressError("malformed_structured_field", field);
    index = end + 1;
  }
}
