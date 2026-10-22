/**
 * OpenSSL private-key containers: PKCS#8 (`PRIVATE KEY`), PKCS#1
 * (`RSA PRIVATE KEY`), SEC1 (`EC PRIVATE KEY`), DSA, and the encrypted forms
 * OpenSSL writes. Detection only: a passphrase is never asked for, and no
 * encrypted key is decrypted here.
 */
import {
  type DerNode,
  children,
  integerBytes,
  objectIdentifier,
  readDer,
  sequence,
} from "./asn1.js";
import { parsePemBlocks } from "./pem.js";

const OID = {
  rsa: "1.2.840.113549.1.1.1",
  ec: "1.2.840.10045.2.1",
  ed25519: "1.3.101.112",
  ed448: "1.3.101.113",
  dsa: "1.2.840.10040.4.1",
} as const;

const CURVE_BITS: Readonly<Record<string, number>> = {
  "1.2.840.10045.3.1.7": 256,
  "1.3.132.0.34": 384,
  "1.3.132.0.35": 521,
  "1.2.840.10045.3.1.2": 192,
  "1.3.132.0.10": 256,
  "1.3.132.0.33": 224,
};

export type PrivateKeyInfo = {
  readonly label: string;
  readonly algorithm:
    | "rsa"
    | "ec"
    | "ed25519"
    | "ed448"
    | "dsa"
    | "openssh"
    | "unknown";
  readonly bits: number | null;
  readonly encrypted: boolean;
};

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

function algorithmOid(node: DerNode): string {
  const parts = sequence(node, "AlgorithmIdentifier");
  const oid = parts[0];
  if (oid === undefined) throw new KeyError("missing algorithm OID");
  return objectIdentifier(oid);
}

function algorithmFor(oid: string): PrivateKeyInfo["algorithm"] {
  if (oid === OID.rsa || oid === "1.2.840.113549.1.1.10") return "rsa";
  if (oid === OID.ec) return "ec";
  if (oid === OID.ed25519) return "ed25519";
  if (oid === OID.ed448) return "ed448";
  if (oid === OID.dsa) return "dsa";
  return "unknown";
}

function bitsOf(integer: Uint8Array): number {
  let at = 0;
  while (at < integer.length && integer[at] === 0) at += 1;
  const first = integer[at];
  if (first === undefined) return 0;
  return (integer.length - at) * 8 - Math.clz32(first) + 24;
}

function rsaBits(key: DerNode): number | null {
  try {
    const parts = sequence(key, "RSAPrivateKey");
    const modulus = parts[1];
    if (modulus === undefined) return null;
    return bitsOf(integerBytes(modulus));
  } catch {
    return null;
  }
}

function pkcs8(parts: readonly DerNode[]): {
  algorithm: string;
  bits: number | null;
} {
  const alg = parts[1];
  const secret = parts[2];
  if (alg === undefined || secret === undefined || secret.tag !== 0x04)
    throw new KeyError("bad PKCS#8");
  const oid = algorithmOid(alg);
  const algorithm = algorithmFor(oid);
  if (algorithm !== "rsa") return { algorithm: oid, bits: null };
  const inner = readDer(secret.content);
  if (inner.next !== secret.content.length)
    return { algorithm: oid, bits: null };
  return { algorithm: oid, bits: rsaBits(inner.node) };
}

function sec1(parts: readonly DerNode[]): number | null {
  const params = parts.find((part) => part.tag === 0xa0);
  if (params === undefined) return null;
  const wrapped = readDer(params.content);
  if (wrapped.node.tag !== 0x06) return null;
  return CURVE_BITS[objectIdentifier(wrapped.node)] ?? null;
}

function pkcs1Bits(parts: readonly DerNode[]): number | null {
  const modulus = parts[1];
  return modulus === undefined ? null : bitsOf(integerBytes(modulus));
}

function detect(text: string): PrivateKeyInfo | null {
  let blocks: Awaited<ReturnType<typeof parsePemBlocks>>;
  try {
    blocks = parsePemBlocks(text);
  } catch {
    return null;
  }
  if (blocks.length !== 1) return null;
  const block = blocks[0];
  return block === undefined ? null : classify(block);
}

function legacyAlgorithm(label: string): PrivateKeyInfo["algorithm"] {
  if (label.startsWith("RSA")) return "rsa";
  if (label.startsWith("EC")) return "ec";
  if (label.startsWith("DSA")) return "dsa";
  return "unknown";
}

function classify(block: import("./pem.js").PemBlock): PrivateKeyInfo | null {
  const label = block.label;
  const legacyEncrypted = (block.headers["Proc-Type"] ?? "")
    .toUpperCase()
    .includes("ENCRYPTED");
  if (legacyEncrypted)
    return {
      label,
      algorithm: legacyAlgorithm(label),
      bits: null,
      encrypted: true,
    };
  if (label === "OPENSSH PRIVATE KEY")
    return { label, algorithm: "openssh", bits: null, encrypted: false };
  try {
    const outer = readDer(block.der);
    if (outer.next !== block.der.length || outer.node.tag !== 0x30) return null;
    const parts = children(outer.node);
    if (label === "ENCRYPTED PRIVATE KEY") {
      if (parts[1] !== undefined) algorithmOid(parts[1]);
      return { label, algorithm: "unknown", bits: null, encrypted: true };
    }
    if (label === "PRIVATE KEY") {
      const parsed = pkcs8(parts);
      return {
        label,
        algorithm: algorithmFor(parsed.algorithm),
        bits: parsed.bits,
        encrypted: false,
      };
    }
    if (label === "RSA PRIVATE KEY")
      return {
        label,
        algorithm: "rsa",
        bits: pkcs1Bits(parts),
        encrypted: false,
      };
    if (label === "EC PRIVATE KEY")
      return { label, algorithm: "ec", bits: sec1(parts), encrypted: false };
    if (label === "DSA PRIVATE KEY")
      return { label, algorithm: "dsa", bits: null, encrypted: false };
    return null;
  } catch {
    return null;
  }
}

/** Detect one OpenSSL/OpenSSH private-key container, or null. */
export function inspectPrivateKeyPem(text: string): PrivateKeyInfo | null {
  return detect(text);
}
