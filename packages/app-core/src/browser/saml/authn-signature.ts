/** Mature XMLDSIG request signing; the configured SP certificate must match its private key. */
import {
  type SamlPostOwner,
  assertSamlPostOwner,
} from "./assertion-conditions.js";

export type SamlRequestSigning = Readonly<{
  privateKeyPkcs8: string;
  certificate: string;
}>;
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
function invalid(): never {
  throw new Error(
    "SAML request signing needs a matching RSA private key and SP certificate",
  );
}
function pemBytes(
  value: string,
  label: string,
  limit: number,
): Uint8Array<ArrayBuffer> {
  if (!value || value.length > limit) invalid();
  const trimmed = value.trim();
  const prefix = `-----BEGIN ${label}-----`;
  const suffix = `-----END ${label}-----`;
  const raw =
    trimmed.startsWith(prefix) && trimmed.endsWith(suffix)
      ? trimmed.slice(prefix.length, -suffix.length)
      : trimmed;
  const base64 = raw.replace(/[ \t\r\n]/g, "");
  if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    invalid();
  const binary = atob(base64);
  if (btoa(binary) !== base64) invalid();
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function rsaKey(key: CryptoKey): void {
  if (key.algorithm.name !== ALGORITHM.name) invalid();
  // SAFETY: WebCrypto's checked RSA algorithm name establishes the algorithm shape.
  const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
  if (
    algorithm.modulusLength < 2048 ||
    algorithm.modulusLength > 8192 ||
    [...algorithm.publicExponent].join(",") !== "1,0,1"
  )
    invalid();
}
/** No key or mutable DOM is exposed to callers while signing awaits WebCrypto. */
export async function signSamlAuthnRequest(
  document: Document,
  requestId: string,
  signing: SamlRequestSigning,
  owner: SamlPostOwner,
): Promise<void> {
  assertSamlPostOwner(owner);
  const privateBytes = pemBytes(signing.privateKeyPkcs8, "PRIVATE KEY", 16384);
  const certificateBytes = pemBytes(signing.certificate, "CERTIFICATE", 16384);
  const certificateBase64 = btoa(String.fromCharCode(...certificateBytes));
  const { SignedXml, X509Certificate } = await import("xmldsigjs");
  assertSamlPostOwner(owner);
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privateBytes,
      ALGORITHM,
      false,
      ["sign"],
    );
  } finally {
    privateBytes.fill(0);
  }
  assertSamlPostOwner(owner);
  rsaKey(privateKey);
  const publicKey = await new X509Certificate(certificateBytes).exportKey(
    ALGORITHM,
  );
  assertSamlPostOwner(owner);
  rsaKey(publicKey);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign(ALGORITHM, privateKey, challenge);
  assertSamlPostOwner(owner);
  const matches = await crypto.subtle.verify(
    ALGORITHM,
    publicKey,
    signature,
    challenge,
  );
  assertSamlPostOwner(owner);
  if (!matches) invalid();
  const signed = new SignedXml(document);
  signed.XmlSignature.SignedInfo.CanonicalizationMethod.Algorithm =
    "http://www.w3.org/2001/10/xml-exc-c14n#";
  await signed.Sign(ALGORITHM, privateKey, document, {
    x509: [certificateBase64],
    references: [
      {
        uri: `#${requestId}`,
        hash: "SHA-256",
        transforms: ["enveloped", "exc-c14n"],
      },
    ],
  });
  assertSamlPostOwner(owner);
  const element = signed.GetXml();
  if (!element) invalid();
  const root = document.documentElement;
  root.insertBefore(
    document.importNode(element, true),
    root.firstElementChild?.nextSibling ?? null,
  );
}
