/** Test-only, reproducible P-256 keys and an independently signed certificate. */
import {
  type KeyObject,
  X509Certificate,
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";

/** The scalar is public test data, never a credential. */
export function testEcKey(scalar: 1 | 2): KeyObject {
  const secret = Buffer.alloc(32);
  secret[31] = scalar;
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(secret);
  const point = ecdh.getPublicKey(undefined, "uncompressed");
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: secret.toString("base64url"),
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
  });
}

type Element = { tag: number; bytes: Buffer; body: Buffer; end: number };

function element(bytes: Buffer, start: number): Element {
  if (start + 2 > bytes.length) throw new Error("Truncated test certificate");
  const tag = bytes[start];
  const first = bytes[start + 1];
  if (tag === undefined || first === undefined)
    throw new Error("Missing DER tag");
  let cursor = start + 2;
  let length = first;
  if (first >= 128) {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || cursor + count > bytes.length)
      throw new Error("Invalid DER length");
    length = 0;
    for (let i = 0; i < count; i++) {
      const next = bytes[cursor++];
      if (next === undefined) throw new Error("Missing DER length byte");
      length = length * 256 + next;
    }
  }
  const end = cursor + length;
  if (end > bytes.length) throw new Error("Truncated DER body");
  return {
    tag,
    bytes: bytes.subarray(start, end),
    body: bytes.subarray(cursor, end),
    end,
  };
}

function children(bytes: Buffer): Element[] {
  const values: Element[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const value = element(bytes, offset);
    values.push(value);
    offset = value.end;
  }
  return values;
}

function wrap(tag: number, body: Buffer): Buffer {
  let length = body.length;
  if (length < 128) return Buffer.concat([Buffer.from([tag, length]), body]);
  const digits: number[] = [];
  while (length > 0) {
    digits.unshift(length & 255);
    length = Math.floor(length / 256);
  }
  return Buffer.concat([
    Buffer.from([tag, 128 | digits.length, ...digits]),
    body,
  ]);
}

function replacementIdentifier(extension: Element, identifier: Buffer): Buffer {
  const parts = children(extension.body);
  const oid = parts[0]?.bytes.toString("hex");
  const value = parts.at(-1);
  if (!value || value.tag !== 0x04)
    throw new Error("Invalid test certificate extension");
  let inner: Buffer;
  if (oid === "0603551d0e") inner = wrap(0x04, identifier);
  else if (oid === "0603551d23") inner = wrap(0x30, wrap(0x80, identifier));
  else return extension.bytes;
  return wrap(
    0x30,
    Buffer.concat([
      ...parts.slice(0, -1).map((part) => part.bytes),
      wrap(0x04, inner),
    ]),
  );
}

function withKeyIdentifiers(field: Element, spki: Buffer): Buffer {
  const [sequence] = children(field.body);
  if (!sequence || sequence.tag !== 0x30)
    throw new Error("Invalid certificate extensions");
  const extensions = children(sequence.body);
  const oids = extensions.map((item) =>
    children(item.body)[0]?.bytes.toString("hex"),
  );
  if (
    oids.filter((oid) => oid === "0603551d0e").length !== 1 ||
    oids.filter((oid) => oid === "0603551d23").length !== 1
  )
    throw new Error("Missing certificate key identifiers");
  const identifier = createHash("sha256").update(spki).digest().subarray(0, 20);
  const encoded = extensions.map((item) =>
    replacementIdentifier(item, identifier),
  );
  return wrap(0xa3, wrap(0x30, Buffer.concat(encoded)));
}

/** Keep the public template's fields while signing a certificate for the test key. */
export function matchingTestCertificate(
  template: string,
  key: KeyObject,
): X509Certificate {
  const certificate = new X509Certificate(template);
  const root = element(certificate.raw, 0);
  if (root.tag !== 0x30 || root.end !== certificate.raw.length)
    throw new Error("Invalid test certificate");
  const [tbs, signatureAlgorithm, signatureValue] = children(root.body);
  if (
    !tbs ||
    !signatureAlgorithm ||
    !signatureValue ||
    tbs.tag !== 0x30 ||
    !signatureAlgorithm.bytes.equals(
      Buffer.from("300a06082a8648ce3d040302", "hex"),
    )
  )
    throw new Error("Unexpected test certificate algorithm");
  const fields = children(tbs.body);
  const spkiIndex = fields[0]?.tag === 0xa0 ? 6 : 5;
  if (!fields[spkiIndex] || fields[spkiIndex]?.tag !== 0x30)
    throw new Error("Missing test certificate public key");
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const signed = wrap(
    0x30,
    Buffer.concat(
      fields.map((field, index) => {
        if (index === spkiIndex) return spki;
        if (field.tag === 0xa3) return withKeyIdentifiers(field, spki);
        return field.bytes;
      }),
    ),
  );
  const signature = sign("sha256", signed, key);
  const encoded = wrap(
    0x30,
    Buffer.concat([
      signed,
      signatureAlgorithm.bytes,
      wrap(0x03, Buffer.concat([Buffer.from([0]), signature])),
    ]),
  );
  return new X509Certificate(encoded);
}
