import { asBufferSource } from "@opensesame/os-domain";
/**
 * A PKCS#10 certificate request, built in this page (RFC 2986), for ACME's
 * finalize step: an ECDSA P-256 key, the names in a subjectAltName extension,
 * an empty subject (ACME takes its names from the SAN), signed with
 * ecdsa-with-SHA256. Only what that needs is encoded.
 */

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OID = 0x06;
const ATTRIBUTES = 0xa0;
const DNS_NAME = 0x82;

/** 1.2.840.113549.1.9.14 extensionRequest, 2.5.29.17 subjectAltName, 1.2.840.10045.4.3.2 ecdsa-with-SHA256. */
const OID_EXTENSION_REQUEST = [
  0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e,
];
const OID_SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11];
const OID_ECDSA_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthOf(size: number): Uint8Array {
  if (size < 0x80) return Uint8Array.of(size);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256))
    bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function der(tag: number, ...parts: readonly Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([Uint8Array.of(tag), lengthOf(body.length), body]);
}

/** An unsigned big-endian integer: no leading zeros, a zero first where the high bit is set. */
function unsignedInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.slice(start);
  return der(
    INTEGER,
    trimmed[0] !== undefined && trimmed[0] >= 0x80
      ? concat([Uint8Array.of(0), trimmed])
      : trimmed,
  );
}

/** WebCrypto signs ECDSA as r || s; X.509 wants SEQUENCE { INTEGER r, INTEGER s }. */
export function p1363ToDer(signature: Uint8Array): Uint8Array {
  const half = signature.length / 2;
  return der(
    SEQUENCE,
    unsignedInteger(signature.slice(0, half)),
    unsignedInteger(signature.slice(half)),
  );
}

const DNS =
  /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isCertificateName(name: string): boolean {
  return (
    DNS.test(name) ||
    /^(?:\*\.)?(?:[a-z0-9-]+\.)+xn--[a-z0-9-]{1,59}$/.test(name)
  );
}

/** A DER CertificationRequest for these names, signed by the key pair's private half. */
export async function buildCsr(
  names: readonly string[],
  keys: { publicKey: CryptoKey; privateKey: CryptoKey },
): Promise<Uint8Array> {
  if (!names.length || names.some((name) => !isCertificateName(name)))
    throw new Error("Enter valid DNS names");
  const altNames = der(
    SEQUENCE,
    ...names.map((name) => der(DNS_NAME, new TextEncoder().encode(name))),
  );
  const extension = der(
    SEQUENCE,
    der(
      SEQUENCE,
      der(OID, Uint8Array.from(OID_SUBJECT_ALT_NAME)),
      der(OCTET_STRING, altNames),
    ),
  );
  const info = der(
    SEQUENCE,
    der(INTEGER, Uint8Array.of(0)),
    der(SEQUENCE),
    new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
    der(
      ATTRIBUTES,
      der(
        SEQUENCE,
        der(OID, Uint8Array.from(OID_EXTENSION_REQUEST)),
        der(SET, extension),
      ),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      asBufferSource(info),
    ),
  );
  return der(
    SEQUENCE,
    info,
    der(SEQUENCE, der(OID, Uint8Array.from(OID_ECDSA_SHA256))),
    der(BIT_STRING, Uint8Array.of(0), p1363ToDer(signature)),
  );
}
