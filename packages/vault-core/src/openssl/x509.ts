/**
 * The X.509 facts a person can check: subject CN, SANs, serial, validity,
 * issuer, CA flag, key algorithm and signature algorithm. This is not a path
 * validator and not a replacement for WebCrypto or a platform X.509 stack; it
 * reads the certificate the way `openssl x509 -noout -text` does.
 */
import {
  type DerNode,
  children,
  integerBytes,
  objectIdentifier,
  readDer,
  sequence,
  stringValue,
  timeValue,
} from "./asn1.js";
import {
  type PemBlock,
  isCertificateLabel,
  parsePemBlocks,
  toPem,
} from "./pem.js";

const OID = {
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
} as const;

const KEY_ALGORITHMS: ReadonlyMap<string, string> = new Map([
  ["1.2.840.113549.1.1.1", "rsa"],
  ["1.2.840.10045.2.1", "ec"],
  ["1.3.101.112", "ed25519"],
  ["1.3.101.113", "ed448"],
  ["1.2.840.10040.4.1", "dsa"],
]);

export type CertificateInfo = {
  readonly subjectCommonName: string;
  readonly issuerCommonName: string;
  readonly serial: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly dnsNames: readonly string[];
  readonly ipAddrs: readonly string[];
  readonly keyAlgorithm: string;
  readonly signatureAlgorithm: string;
  readonly isCa: boolean;
  readonly der: Uint8Array;
};

export type CertificateBundle = {
  readonly certificates: readonly CertificateInfo[];
  /** Leaf first, each re-armoured as `CERTIFICATE`. */
  readonly pem: readonly string[];
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function algorithmOid(node: DerNode): string {
  const parts = sequence(node, "AlgorithmIdentifier");
  const oid = parts[0];
  if (oid === undefined) throw new Error("missing algorithm OID");
  return objectIdentifier(oid);
}

function commonName(node: DerNode): string {
  for (const rdn of children(node)) {
    if (rdn.tag !== 0x31) continue;
    for (const attribute of children(rdn)) {
      const parts = children(attribute);
      const oid = parts[0];
      const value = parts[1];
      if (oid === undefined || value === undefined) continue;
      if (objectIdentifier(oid) !== OID.commonName) continue;
      const text = stringValue(value);
      if (text !== null) return text;
    }
  }
  return "";
}

type Extension = { readonly oid: string; readonly value: DerNode };

function extensions(node: DerNode | undefined): Extension[] {
  if (node === undefined || node.tag !== 0xa3) return [];
  const wrapped = readDer(node.content);
  if (wrapped.next !== node.content.length || wrapped.node.tag !== 0x30)
    throw new Error("bad extensions wrapper");
  const out: Extension[] = [];
  for (const extension of children(wrapped.node)) {
    const parts = children(extension);
    const oid = parts[0];
    const value = parts.find((part) => part.tag === 0x04);
    if (oid === undefined || value === undefined) continue;
    out.push({ oid: objectIdentifier(oid), value });
  }
  return out;
}

function ipv4(bytes: Uint8Array): string {
  return Array.from(bytes).join(".");
}

function ipv6(bytes: Uint8Array): string {
  const words: number[] = [];
  for (let at = 0; at + 1 < bytes.length; at += 2)
    words.push(((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0));
  let bestAt = -1;
  let bestLen = 0;
  for (let at = 0; at < words.length; ) {
    if (words[at] !== 0) {
      at += 1;
      continue;
    }
    let end = at;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - at > bestLen) {
      bestAt = at;
      bestLen = end - at;
    }
    at = end;
  }
  if (bestLen < 2) return words.map((word) => word.toString(16)).join(":");
  const left = words
    .slice(0, bestAt)
    .map((word) => word.toString(16))
    .join(":");
  const right = words
    .slice(bestAt + bestLen)
    .map((word) => word.toString(16))
    .join(":");
  return `${left}::${right}`;
}

/** The DNS names and IP addresses a certificate's SAN lists. */
type AltNames = { dns: string[]; ips: string[] };

function subjectAltName(extension: Extension): AltNames {
  const wrapped = readDer(extension.value.content);
  if (
    wrapped.next !== extension.value.content.length ||
    wrapped.node.tag !== 0x30
  )
    throw new Error("bad subjectAltName");
  const dns: string[] = [];
  const ips: string[] = [];
  for (const name of children(wrapped.node)) {
    if (name.tag === 0x82) {
      const value = stringValue({ tag: 0x16, content: name.content });
      if (value !== null && value !== "" && value.length <= 253)
        dns.push(value);
    } else if (name.tag === 0x87) {
      if (name.content.length === 4) ips.push(ipv4(name.content));
      else if (name.content.length === 16) ips.push(ipv6(name.content));
    }
  }
  return { dns, ips };
}

function basicCa(extension: Extension): boolean {
  const wrapped = readDer(extension.value.content);
  if (
    wrapped.next !== extension.value.content.length ||
    wrapped.node.tag !== 0x30
  )
    throw new Error("bad basicConstraints");
  const first = children(wrapped.node)[0];
  return first?.tag === 0x01 && first.content[0] === 0xff;
}

function timeAt(nodes: readonly DerNode[], index: number): string {
  const node = nodes[index];
  if (node === undefined) throw new Error("missing validity time");
  const value = timeValue(node);
  if (value === null) throw new Error("bad validity time");
  return value;
}
function needed(nodes: readonly DerNode[], index: number): DerNode {
  const node = nodes[index];
  if (node === undefined) throw new Error("missing certificate field");
  return node;
}

/** Read one DER certificate, or return null when it is not one. */
export function inspectCertificateDer(der: Uint8Array): CertificateInfo | null {
  try {
    const outer = readDer(der);
    if (outer.next !== der.length || outer.node.tag !== 0x30) return null;
    const top = children(outer.node);
    if (top.length !== 3) return null;
    const fields = sequence(needed(top, 0), "TBSCertificate");
    const at = fields[0]?.tag === 0xa0 ? 1 : 0;
    const serial = needed(fields, at);
    needed(fields, at + 1);
    const issuer = needed(fields, at + 2);
    const validity = needed(fields, at + 3);
    const subject = needed(fields, at + 4);
    const spki = needed(fields, at + 5);
    const extensionNode = fields.find((field) => field.tag === 0xa3);
    const validityParts = sequence(validity, "Validity");
    const spkiParts = sequence(spki, "SubjectPublicKeyInfo");
    const keyOid = algorithmOid(needed(spkiParts, 0));
    let dnsNames: string[] = [];
    let ipAddrs: string[] = [];
    let isCa = false;
    for (const extension of extensions(extensionNode)) {
      if (extension.oid === OID.subjectAltName) {
        const san = subjectAltName(extension);
        dnsNames = san.dns;
        ipAddrs = san.ips;
      } else if (extension.oid === OID.basicConstraints) {
        isCa = basicCa(extension);
      }
    }
    return {
      subjectCommonName: commonName(subject),
      issuerCommonName: commonName(issuer),
      serial: hex(integerBytes(serial)),
      notBefore: timeAt(validityParts, 0),
      notAfter: timeAt(validityParts, 1),
      dnsNames,
      ipAddrs,
      keyAlgorithm: KEY_ALGORITHMS.get(keyOid) ?? keyOid,
      signatureAlgorithm: algorithmOid(needed(top, 1)),
      isCa,
      der,
    };
  } catch {
    return null;
  }
}

/** Parse an OpenSSL certificate chain; all blocks must be certificates. */
export function inspectCertificateBundle(
  text: string,
): CertificateBundle | null {
  let blocks: PemBlock[];
  try {
    blocks = parsePemBlocks(text);
  } catch {
    return null;
  }
  if (blocks.length === 0 || blocks.length > 8) return null;
  if (!blocks.every((block) => isCertificateLabel(block.label))) return null;
  const certificates: CertificateInfo[] = [];
  for (const block of blocks) {
    const certificate = inspectCertificateDer(block.der);
    if (certificate === null) return null;
    certificates.push(certificate);
  }
  return {
    certificates,
    pem: blocks.map((block) => toPem(block.der, "CERTIFICATE")),
  };
}
