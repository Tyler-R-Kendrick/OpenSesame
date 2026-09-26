/**
 * A self-signed X.509 v3 end-entity certificate (RFC 5280), built with the
 * DER encoder beside it and signed with WebCrypto: an ECDSA P-256 key, an
 * ecdsa-with-SHA256 signature, and the extensions a local TLS server or
 * client certificate needs. The caller validates names and lifetimes; this
 * module only encodes and signs what it is given.
 */
import {
  bitString,
  boolean,
  explicit,
  implicit,
  namedBits,
  objectIdentifier,
  octetString,
  sequence,
  setOf,
  smallInteger,
  time,
  unsignedInteger,
  utf8String,
} from "./der.js";

export const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  clientAuth: "1.3.6.1.5.5.7.3.2",
} as const;

/** KeyUsage bit 0. */
const DIGITAL_SIGNATURE = 0;
/** P-256 raw signature: r and s, 32 bytes each. */
const P256_FIELD_BYTES = 32;
/** A P-256 SPKI ends in BIT STRING (0x03 0x42 0x00) + an uncompressed point. */
const P256_POINT_BYTES = 65;

export type CertificateFields = {
  /** Positive big-endian serial magnitude, at most 20 octets. */
  serial: Uint8Array;
  commonName: string;
  dnsNames: readonly string[];
  /** iPAddress octets: 4 bytes for IPv4, 16 for IPv6. */
  ipAddresses: readonly Uint8Array[];
  notBefore: Date;
  notAfter: Date;
};

export type SignedCertificate = {
  /** The complete Certificate, DER. */
  der: Uint8Array;
  /** The certificate's key as PKCS#8 DER. */
  pkcs8: Uint8Array;
};

/**
 * CSPRNG serial: 16 random bytes with the top bit cleared (positive) and
 * the first byte forced nonzero (minimal, so the INTEGER stays 16 octets
 * and carries at least 121 random bits).
 */
export function randomSerial(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[0] = (bytes[0] ?? 0) & 0x7f || 0x01;
  return bytes;
}

/** Upper-case hex, as `openssl x509 -serial` and Node print a serial. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** WebCrypto's IEEE P1363 r||s signature as a DER Ecdsa-Sig-Value. */
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== P256_FIELD_BYTES * 2) {
    throw new RangeError(`ECDSA P-256 signature is ${raw.length} bytes`);
  }
  return sequence(
    unsignedInteger(raw.subarray(0, P256_FIELD_BYTES)),
    unsignedInteger(raw.subarray(P256_FIELD_BYTES)),
  );
}

function subjectPublicKey(spki: Uint8Array): Uint8Array {
  const start = spki.length - P256_POINT_BYTES;
  const header = spki.subarray(start - 3, start);
  if (
    header[0] !== 0x03 ||
    header[1] !== P256_POINT_BYTES + 1 ||
    header[2] !== 0x00 ||
    spki[start] !== 0x04
  ) {
    throw new Error("WebCrypto returned an unexpected P-256 public key.");
  }
  return spki.subarray(start);
}

/** RFC 7093 §2 method 1: the leftmost 160 bits of SHA-256(subjectPublicKey). */
async function keyIdentifier(spki: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    subjectPublicKey(spki).slice(),
  );
  return new Uint8Array(digest).subarray(0, 20);
}

function extension(oid: string, critical: boolean, value: Uint8Array) {
  return critical
    ? sequence(objectIdentifier(oid), boolean(true), octetString(value))
    : sequence(objectIdentifier(oid), octetString(value));
}

function name(commonName: string): Uint8Array {
  return sequence(
    setOf(sequence(objectIdentifier(OID.commonName), utf8String(commonName))),
  );
}

function subjectAltName(fields: CertificateFields): Uint8Array | null {
  const encoder = new TextEncoder();
  const entries = [
    ...fields.dnsNames.map((dns) => implicit(2, encoder.encode(dns))),
    ...fields.ipAddresses.map((ip) => implicit(7, ip)),
  ];
  return entries.length === 0 ? null : sequence(...entries);
}

async function extensions(fields: CertificateFields, spki: Uint8Array) {
  const san = subjectAltName(fields);
  return explicit(
    3,
    sequence(
      extension(OID.basicConstraints, true, sequence()),
      extension(OID.keyUsage, true, namedBits([DIGITAL_SIGNATURE])),
      extension(
        OID.extKeyUsage,
        false,
        sequence(
          objectIdentifier(OID.serverAuth),
          objectIdentifier(OID.clientAuth),
        ),
      ),
      ...(san === null ? [] : [extension(OID.subjectAltName, false, san)]),
      extension(
        OID.subjectKeyIdentifier,
        false,
        octetString(await keyIdentifier(spki)),
      ),
    ),
  );
}

/** The TBSCertificate for `fields` over the SPKI WebCrypto exported. */
export async function tbsCertificate(
  fields: CertificateFields,
  spki: Uint8Array,
): Promise<Uint8Array> {
  const signatureAlgorithm = sequence(objectIdentifier(OID.ecdsaWithSha256));
  const subject = name(fields.commonName);
  return sequence(
    explicit(0, smallInteger(2)),
    unsignedInteger(fields.serial),
    signatureAlgorithm,
    subject,
    sequence(time(fields.notBefore), time(fields.notAfter)),
    subject,
    spki,
    await extensions(fields, spki),
  );
}

/**
 * Generate an extractable ECDSA P-256 key, sign the TBSCertificate with it,
 * and return the Certificate and the key.
 */
export async function signSelfSignedCertificate(
  fields: CertificateFields,
): Promise<SignedCertificate> {
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", key.publicKey),
  );
  const tbs = await tbsCertificate(fields, spki);
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      tbs.slice(),
    ),
  );
  const der = sequence(
    tbs,
    sequence(objectIdentifier(OID.ecdsaWithSha256)),
    bitString(ecdsaRawToDer(raw)),
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", key.privateKey),
  );
  return { der, pkcs8 };
}
