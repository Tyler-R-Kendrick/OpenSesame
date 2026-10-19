/**
 * Minimal CBOR reading, COSE P-256 key conversion, and ES256 signature
 * reshaping for the CLI approval
 * passkey. Only the shapes a WebAuthn attestation carries are understood;
 * anything else reads as `other` or fails closed with `null`.
 */

const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

type CborValue =
  | { kind: "uint"; n: number }
  | { kind: "nint"; n: number }
  | { kind: "bytes"; b: Uint8Array }
  | { kind: "text"; s: string }
  | { kind: "array"; items: CborValue[] }
  | { kind: "map"; entries: ReadonlyArray<readonly [CborValue, CborValue]> }
  | { kind: "other" };

function readLength(
  bytes: Uint8Array,
  offset: number,
  info: number,
): { n: number; offset: number } | null {
  if (info < 24) return { n: info, offset };
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  if (width === 0 || offset + width > bytes.length) return null;
  let n = 0;
  for (let i = 0; i < width; i++) n = n * 256 + (bytes[offset + i] ?? 0);
  return { n, offset: offset + width };
}

function readCbor(
  bytes: Uint8Array,
  offset: number,
): { value: CborValue; offset: number } | null {
  if (offset >= bytes.length) return null;
  const initial = bytes[offset] ?? 0;
  const major = initial >> 5;
  const info = initial & 0x1f;
  const length = readLength(bytes, offset + 1, info);
  if (!length) return null;
  if (major === 0) {
    return { value: { kind: "uint", n: length.n }, offset: length.offset };
  }
  if (major === 1) {
    return { value: { kind: "nint", n: -1 - length.n }, offset: length.offset };
  }
  if (major === 2 || major === 3) {
    const end = length.offset + length.n;
    if (end > bytes.length) return null;
    const slice = bytes.subarray(length.offset, end);
    if (major === 2) return { value: { kind: "bytes", b: slice }, offset: end };
    return {
      value: { kind: "text", s: new TextDecoder().decode(slice) },
      offset: end,
    };
  }
  if (major === 4) return readCborArray(bytes, length.offset, length.n);
  if (major === 5) return readCborMap(bytes, length.offset, length.n);
  return { value: { kind: "other" }, offset: length.offset };
}

function readCborArray(
  bytes: Uint8Array,
  start: number,
  count: number,
): { value: CborValue; offset: number } | null {
  const items: CborValue[] = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    const item = readCbor(bytes, cursor);
    if (!item) return null;
    items.push(item.value);
    cursor = item.offset;
  }
  return { value: { kind: "array", items }, offset: cursor };
}

function readCborMap(
  bytes: Uint8Array,
  start: number,
  count: number,
): { value: CborValue; offset: number } | null {
  const entries: Array<readonly [CborValue, CborValue]> = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    const key = readCbor(bytes, cursor);
    if (!key) return null;
    const value = readCbor(bytes, key.offset);
    if (!value) return null;
    entries.push([key.value, value.value]);
    cursor = value.offset;
  }
  return { value: { kind: "map", entries }, offset: cursor };
}

function mapBytes(value: CborValue, key: string): Uint8Array | null {
  if (value.kind !== "map") return null;
  for (const [entryKey, entryValue] of value.entries) {
    if (
      entryKey.kind === "text" &&
      entryKey.s === key &&
      entryValue.kind === "bytes"
    ) {
      return entryValue.b;
    }
  }
  return null;
}

function mapCoord(value: CborValue, key: number): Uint8Array | null {
  if (value.kind !== "map") return null;
  for (const [entryKey, entryValue] of value.entries) {
    const matches =
      (entryKey.kind === "nint" && entryKey.n === key) ||
      (entryKey.kind === "uint" && entryKey.n === key);
    if (matches && entryValue.kind === "bytes" && entryValue.b.length === 32) {
      return entryValue.b;
    }
  }
  return null;
}

/** COSE_Key EC2 P-256 (`kty` 2, `crv` 1) stored beside the credential id. */
export function encodeCoseP256(
  x: Uint8Array,
  y: Uint8Array,
): Uint8Array | null {
  if (x.length !== 32 || y.length !== 32) return null;
  const out = new Uint8Array(77);
  out.set([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20], 0);
  out.set(x, 10);
  out.set([0x22, 0x58, 0x20], 42);
  out.set(y, 45);
  return out;
}

export function coseP256ToSpki(cose: Uint8Array): Uint8Array | null {
  const parsed = readCbor(cose, 0);
  if (!parsed || parsed.offset !== cose.length) return null;
  const x = mapCoord(parsed.value, -2);
  const y = mapCoord(parsed.value, -3);
  if (!x || !y) return null;
  const spki = new Uint8Array(P256_SPKI_PREFIX.length + 65);
  spki.set(P256_SPKI_PREFIX, 0);
  spki[P256_SPKI_PREFIX.length] = 0x04;
  spki.set(x, P256_SPKI_PREFIX.length + 1);
  spki.set(y, P256_SPKI_PREFIX.length + 33);
  return spki;
}

export function spkiToCose(spki: Uint8Array): Uint8Array | null {
  if (spki.length < 65 || spki[spki.length - 65] !== 0x04) return null;
  const point = spki.subarray(spki.length - 65);
  return encodeCoseP256(point.subarray(1, 33), point.subarray(33, 65));
}

export function authDataFromAttestation(
  attestation: Uint8Array,
): Uint8Array | null {
  const parsed = readCbor(attestation, 0);
  if (!parsed) return null;
  const authData = mapBytes(parsed.value, "authData");
  return authData ? new Uint8Array(authData) : null;
}

export function coseFromAuthData(authData: Uint8Array): Uint8Array | null {
  if (authData.length < 55 || (authData[32] & 0x40) === 0) return null;
  const credLen = ((authData[53] ?? 0) << 8) | (authData[54] ?? 0);
  const start = 55 + credLen;
  if (credLen === 0 || start >= authData.length) return null;
  return authData.subarray(start);
}

/** WebAuthn ES256 signatures are DER. The daemon verifier takes raw `r || s`. */
export function ecdsaDerToP1363(signature: Uint8Array): Uint8Array | null {
  if (signature.length === 64) return signature;
  if (signature[0] !== 0x30 || signature.length < 8) return null;
  let offset = 2;
  if ((signature[1] ?? 0) & 0x80) {
    offset = 2 + ((signature[1] ?? 0) & 0x7f);
  }
  const readInt = (): Uint8Array | null => {
    if (signature[offset] !== 0x02) return null;
    const len = signature[offset + 1] ?? 0;
    const start = offset + 2;
    const end = start + len;
    if (end > signature.length) return null;
    offset = end;
    return signature.subarray(start, end);
  };
  const r = readInt();
  const s = readInt();
  if (!r || !s) return null;
  const out = new Uint8Array(64);
  const put = (src: Uint8Array, at: number): boolean => {
    let value = src;
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32 || value.length === 0) return false;
    out.set(value, at + (32 - value.length));
    return true;
  };
  return put(r, 0) && put(s, 32) ? out : null;
}

export function signCountOf(authData: Uint8Array): number | null {
  if (authData.length < 37) return null;
  return new DataView(
    authData.buffer,
    authData.byteOffset,
    authData.byteLength,
  ).getUint32(33);
}
