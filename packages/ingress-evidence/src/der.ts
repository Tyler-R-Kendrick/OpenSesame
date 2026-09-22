/**
 * A bounded DER walker that answers one question about a byte string: is it
 * exactly one X.509 certificate, and if so is it a CA? It reads TLV shape and
 * the basicConstraints extension, nothing more. Chain building, signatures,
 * names and validity are the verifier's job (`node.ts`), which uses the
 * platform's X.509 implementation.
 */

interface Tlv {
  readonly tag: number;
  /** First byte of the content. */
  readonly start: number;
  /** One past the last byte of the content. */
  readonly end: number;
}

const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
const TAG_CTX_0 = 0xa0;
const TAG_CTX_1 = 0xa1;
const TAG_CTX_2 = 0xa2;
const TAG_CTX_3 = 0xa3;
/** id-ce-basicConstraints, 2.5.29.19. */
const OID_BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13];

function readTlv(b: Uint8Array, pos: number, limit: number): Tlv | null {
  if (pos + 2 > limit) return null;
  const tag = b[pos] as number;
  if ((tag & 0x1f) === 0x1f) return null; // multi-byte tags never occur in a certificate
  const first = b[pos + 1] as number;
  let length: number;
  let headerLength: number;
  if (first < 0x80) {
    length = first;
    headerLength = 2;
  } else {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || pos + 2 + count > limit) return null;
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = length * 256 + (b[pos + 2 + i] as number);
    }
    // DER: minimal length encoding only.
    if (length < 0x80 || length < 256 ** (count - 1)) return null;
    headerLength = 2 + count;
  }
  const start = pos + headerLength;
  const end = start + length;
  if (end > limit) return null;
  return { tag, start, end };
}

/** The children of a constructed value; they must tile its content exactly. */
function children(b: Uint8Array, outer: Tlv, max: number): Tlv[] | null {
  const out: Tlv[] = [];
  let pos = outer.start;
  while (pos < outer.end) {
    if (out.length >= max) return null;
    const child = readTlv(b, pos, outer.end);
    if (child === null) return null;
    out.push(child);
    pos = child.end;
  }
  return out;
}

function oidEquals(b: Uint8Array, tlv: Tlv, oid: readonly number[]): boolean {
  if (tlv.end - tlv.start !== oid.length) return false;
  return oid.every((byte, i) => b[tlv.start + i] === byte);
}

/** cA from a basicConstraints value: SEQUENCE { cA BOOLEAN DEFAULT FALSE, pathLen INTEGER OPTIONAL }. */
function basicConstraintsCa(b: Uint8Array, value: Tlv): boolean | null {
  const seq = readTlv(b, value.start, value.end);
  if (seq === null || seq.tag !== TAG_SEQUENCE || seq.end !== value.end)
    return null;
  const parts = children(b, seq, 2);
  if (parts === null) return null;
  const first = parts[0];
  if (first === undefined) return false;
  if (first.tag === TAG_BOOLEAN) {
    if (first.end - first.start !== 1) return null;
    const v = b[first.start];
    if (v === 0xff) return true;
    if (v === 0x00) return null; // DER never encodes a DEFAULT value explicitly
    return null;
  }
  return first.tag === TAG_INTEGER ? false : null;
}

function extensionsCa(b: Uint8Array, ctx3: Tlv): boolean | null {
  const seq = readTlv(b, ctx3.start, ctx3.end);
  if (seq === null || seq.tag !== TAG_SEQUENCE || seq.end !== ctx3.end)
    return null;
  const exts = children(b, seq, 64);
  if (exts === null) return null;
  let ca = false;
  for (const ext of exts) {
    if (ext.tag !== TAG_SEQUENCE) return null;
    const parts = children(b, ext, 3);
    if (parts === null || parts.length < 2) return null;
    const id = parts[0] as Tlv;
    const value = parts[parts.length - 1] as Tlv;
    if (id.tag !== TAG_OID || value.tag !== TAG_OCTET_STRING) return null;
    if (parts.length === 3 && (parts[1] as Tlv).tag !== TAG_BOOLEAN)
      return null;
    if (oidEquals(b, id, OID_BASIC_CONSTRAINTS)) {
      const flag = basicConstraintsCa(b, value);
      if (flag === null) return null;
      ca = flag;
    }
  }
  return ca;
}

const TBS_FIXED_TAGS = [
  TAG_INTEGER,
  TAG_SEQUENCE,
  TAG_SEQUENCE,
  TAG_SEQUENCE,
  TAG_SEQUENCE,
  TAG_SEQUENCE,
];

/** The three top-level members of Certificate, or null when the shape is wrong. */
function certificateMembers(der: Uint8Array): [Tlv, Tlv, Tlv] | null {
  const outer = readTlv(der, 0, der.length);
  if (outer === null || outer.tag !== TAG_SEQUENCE || outer.end !== der.length)
    return null;
  const top = children(der, outer, 3);
  if (top === null || top.length !== 3) return null;
  const [tbs, alg, sig] = top as [Tlv, Tlv, Tlv];
  if (
    tbs.tag !== TAG_SEQUENCE ||
    alg.tag !== TAG_SEQUENCE ||
    sig.tag !== TAG_BIT_STRING
  )
    return null;
  return [tbs, alg, sig];
}

/** Index of the first optional TBSCertificate member after the fixed ones, or null. */
function afterFixedTbsFields(fields: Tlv[]): number | null {
  let i = fields[0]?.tag === TAG_CTX_0 ? 1 : 0;
  for (const tag of TBS_FIXED_TAGS) {
    if (fields[i]?.tag !== tag) return null;
    i += 1;
  }
  return i;
}

/** Walks the optional [1] [2] [3] members; returns the CA flag, or null on a bad shape. */
function optionalTbsFields(
  der: Uint8Array,
  fields: Tlv[],
  from: number,
): boolean | null {
  let i = from;
  let ca = false;
  for (const optional of [TAG_CTX_1, TAG_CTX_2, TAG_CTX_3]) {
    const field = fields[i];
    if (field === undefined) break;
    if (field.tag !== optional) continue;
    if (optional === TAG_CTX_3) {
      const flag = extensionsCa(der, field);
      if (flag === null) return null;
      ca = flag;
    }
    i += 1;
  }
  return i === fields.length ? ca : null;
}

/**
 * Returns whether `der` is a CA certificate, or `null` when it is not exactly
 * one well-formed certificate.
 */
export function inspectCertificate(
  der: Uint8Array,
): { readonly ca: boolean } | null {
  const members = certificateMembers(der);
  if (members === null) return null;
  const fields = children(der, members[0], 10);
  if (fields === null) return null;
  const from = afterFixedTbsFields(fields);
  if (from === null) return null;
  const ca = optionalTbsFields(der, fields, from);
  return ca === null ? null : { ca };
}
