/** Lazy browser-only SAML XMLDSIG primitive; account admission requires protocol policy. */
import { type SamlXmlInspection, inspectSamlXml } from "./xml-policy.js";

export type SamlVerificationOwner = {
  signal: AbortSignal;
  assertCurrent(): void;
};
const brand: unique symbol = Symbol("verified-saml-signature");
export type SamlSignatureProof = Readonly<{ [brand]: true }>;
export type SamlSignatureCoverage = {
  xml: string;
  response: Element;
  assertion: Element;
  responseSigned: boolean;
  assertionSigned: boolean;
};
type Verified = {
  xml: string;
  inspected: SamlXmlInspection;
  owner: SamlVerificationOwner;
};
const proofs = new WeakMap<SamlSignatureProof, Verified>();

function current(owner: SamlVerificationOwner): void {
  owner.signal.throwIfAborted();
  owner.assertCurrent();
}

function invalid(): never {
  throw new Error("SAML signature verification failed");
}

async function approvedKey(
  bytes: Uint8Array,
  owner: SamlVerificationOwner,
): Promise<CryptoKey> {
  current(owner);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "spki",
      Uint8Array.from(bytes),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["verify"],
    );
  } catch {
    current(owner);
    invalid();
  }
  current(owner);
  if (key.type !== "public" || key.algorithm.name !== "RSASSA-PKCS1-v1_5")
    invalid();
  // SAFETY: WebCrypto's importKey contract and the checked algorithm name establish the RSA key shape.
  const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
  if (algorithm.hash.name !== "SHA-256") invalid();
  if (algorithm.modulusLength < 2048 || algorithm.modulusLength > 8192)
    invalid();
  if ([...algorithm.publicExponent].join(",") !== "1,0,1") invalid();
  return key;
}

/** Keys are explicit operator-approved SPKI anchors, never keys supplied by the response. */
export async function verifySamlXmlSignature(
  xml: string,
  anchors: readonly Uint8Array[],
  owner: SamlVerificationOwner,
): Promise<SamlSignatureProof> {
  current(owner);
  if (!anchors.length || anchors.length > 4) invalid();
  const keyBytes = anchors.map((anchor) => {
    if (anchor.length < 1 || anchor.length > 4096) invalid();
    return Uint8Array.from(anchor);
  });
  const inspected = inspectSamlXml(xml);
  const { SignedXml } = await import("xmldsigjs");
  current(owner);
  const keys: CryptoKey[] = [];
  for (const bytes of keyBytes) keys.push(await approvedKey(bytes, owner));
  for (const { signature } of inspected.signatures) {
    let accepted = false;
    for (const key of keys) {
      current(owner);
      try {
        const verifier = new SignedXml(inspected.document);
        verifier.LoadXml(signature);
        accepted = await verifier.Verify(key);
      } catch {
        accepted = false;
      }
      current(owner);
      if (accepted) break;
    }
    if (!accepted) invalid();
  }
  current(owner);
  const proof: SamlSignatureProof = Object.freeze({ [brand]: true });
  proofs.set(proof, { xml, inspected, owner });
  return proof;
}

/** Protocol policy takes the original covered document once; JSON/copies cannot mint proof. */
export function consumeSamlSignatureProof(
  proof: SamlSignatureProof,
): SamlSignatureCoverage {
  const verified = proofs.get(proof);
  if (!verified) invalid();
  proofs.delete(proof);
  current(verified.owner);
  const { response, assertion, signatures } = verified.inspected;
  return {
    xml: verified.xml,
    response,
    assertion,
    responseSigned: signatures.some(({ target }) => target === response),
    assertionSigned: signatures.some(({ target }) => target === assertion),
  };
}
