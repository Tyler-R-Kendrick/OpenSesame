/** Closed RSA/SHA-256 SAML certificate surface, backed by the existing official parser. */
import { X509Certificate as ParsedCertificate } from "@peculiar/x509";
import { z } from "zod";
import { Application } from "./xml-crypto-application.js";

const admittedAlgorithm = z.object({
  name: z.literal("RSASSA-PKCS1-v1_5"),
  hash: z.union([
    z.literal("SHA-256"),
    z.object({ name: z.literal("SHA-256") }),
  ]),
});

function bytes(source: BufferSource): Uint8Array<ArrayBuffer> {
  const value = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  return Uint8Array.from(value);
}

/** The build plugin pins every SDK caller and the app's admitted algorithm policy. */
export class X509Certificate {
  readonly #raw: Uint8Array<ArrayBuffer>;
  readonly #certificate: ParsedCertificate;
  #publicKey: CryptoKey | null = null;

  constructor(rawData: BufferSource) {
    this.#raw = bytes(rawData);
    this.#certificate = new ParsedCertificate(this.#raw);
  }

  get SerialNumber(): string {
    return BigInt(`0x${this.#certificate.serialNumber}`).toString();
  }

  get Issuer(): string {
    return this.#certificate.issuer;
  }

  get Subject(): string {
    return this.#certificate.subject;
  }

  get PublicKey(): CryptoKey | null {
    return this.#publicKey;
  }

  GetRaw(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.#raw);
  }

  Thumbprint(algorithm = "SHA-1"): Promise<ArrayBuffer> {
    return Application.crypto.subtle.digest(algorithm, this.#raw);
  }

  async exportKey(
    algorithm: Algorithm | RsaHashedImportParams = {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
  ): Promise<CryptoKey> {
    if (!admittedAlgorithm.safeParse(algorithm).success)
      throw new Error("SAML certificate key algorithm is not admitted");
    const key = await this.#certificate.publicKey.export(
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      ["verify"],
      Application.crypto,
    );
    this.#publicKey = key;
    return key;
  }
}
