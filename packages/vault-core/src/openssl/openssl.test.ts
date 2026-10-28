import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectPrivateKeyPem } from "./keys.js";
import { parsePemBlocks, toPem } from "./pem.js";
import { matchingTestCertificate, testEcKey } from "./openssl-test-support.js";
import { inspectCertificateBundle, inspectCertificateDer } from "./x509.js";

/** A disposable P-256 certificate made by `openssl req -x509`. */
const CERT = `-----BEGIN CERTIFICATE-----
MIIB0zCCAXmgAwIBAgIUOb3aB2p34qA0V7YK5uKtFPzTYL0wCgYIKoZIzj0EAwIw
HzEdMBsGA1UEAwwUb3BlbnNzbC5leGFtcGxlLnRlc3QwHhcNMjYxMDIyMDMyMjEz
WhcNMjcxMDIyMDMyMjEzWjAfMR0wGwYDVQQDDBRvcGVuc3NsLmV4YW1wbGUudGVz
dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABBtgRS/7WCoTAO0u3K/a0elgkGAf
Oa3nqkHTZSdaz9XxFFbNHWrikvwQTW5/YyCrEl3bRMvExYJNOgNHhB7fMoWjgZIw
gY8wHQYDVR0OBBYEFKju9zUcXFin4yQIPJWYqrIw1QBeMB8GA1UdIwQYMBaAFKju
9zUcXFin4yQIPJWYqrIw1QBeMD8GA1UdEQQ4MDaCFG9wZW5zc2wuZXhhbXBsZS50
ZXN0ghh3d3cub3BlbnNzbC5leGFtcGxlLnRlc3SHBH8AAAEwDAYDVR0TAQH/BAIw
ADAKBggqhkjOPQQDAgNIADBFAiEAkFnTBx9knF9msFG2IDOHnQNozdKYgy8LhLQl
O2NFkOkCIHvR4129TsMirGQxJBuwHQhIARZ6+xRo3NaOfaZ92aRz
-----END CERTIFICATE-----`;

const ecPrivate = testEcKey(1);
const EC_KEY = ecPrivate.export({ type: "sec1", format: "pem" }).toString();

const rsaPrivate = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
const RSA_1024 = rsaPrivate.export({ type: "pkcs1", format: "pem" }).toString();

describe("synthetic certificate and key", () => {
  it("retains the original certificate fields with a matching test-only key", () => {
    const certificate = matchingTestCertificate(CERT, ecPrivate);
    expect(certificate.checkPrivateKey(ecPrivate)).toBe(true);
    expect(certificate.verify(createPublicKey(ecPrivate))).toBe(true);
    expect(inspectCertificateBundle(certificate.toString())).not.toBeNull();
  });
});

describe("OpenSSL PEM and X.509 inspection", () => {
  it("reads an OpenSSL certificate's subject, SANs, serial, expiry and CA flag", () => {
    const bundle = inspectCertificateBundle(CERT);
    expect(bundle).not.toBeNull();
    const leaf = bundle?.certificates[0];
    expect(leaf).toMatchObject({
      subjectCommonName: "openssl.example.test",
      issuerCommonName: "openssl.example.test",
      dnsNames: ["openssl.example.test", "www.openssl.example.test"],
      ipAddrs: ["127.0.0.1"],
      keyAlgorithm: "ec",
      isCa: false,
    });
    expect(leaf?.serial).toMatch(/^[0-9A-F]+$/u);
    expect(leaf?.notAfter).toMatch(/^2027-10-22T/u);
    expect(leaf?.signatureAlgorithm).toBe("1.2.840.10045.4.3.2");
  });

  it("keeps a chain in order and re-armours each certificate", () => {
    const bundle = inspectCertificateBundle(`${CERT}\n${CERT}`);
    expect(bundle?.certificates).toHaveLength(2);
    expect(bundle?.pem).toHaveLength(2);
    expect(bundle?.pem[0]).toContain("BEGIN CERTIFICATE");
  });

  it("refuses malformed armour and trailing DER", () => {
    expect(
      inspectCertificateBundle(
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      ),
    ).toBeNull();
    const der = parsePemBlocks(CERT)[0]?.der;
    if (der === undefined) throw new Error("fixture did not parse");
    expect(inspectCertificateDer(new Uint8Array([...der, 0]))).toBeNull();
  });

  it("reads PKCS#1 and SEC1 private keys, including key size", () => {
    expect(inspectPrivateKeyPem(RSA_1024)).toMatchObject({
      algorithm: "rsa",
      bits: 1024,
      encrypted: false,
    });
    expect(inspectPrivateKeyPem(EC_KEY)).toMatchObject({
      algorithm: "ec",
      bits: 256,
      encrypted: false,
    });
  });

  it("recognises encrypted PKCS#8 without decrypting it", () => {
    const encrypted = rsaPrivate.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "test-only",
    }).toString();
    expect(inspectPrivateKeyPem(encrypted)).toMatchObject({
      encrypted: true,
      bits: null,
      algorithm: "unknown",
    });
  });

  it("recognises legacy OpenSSL encryption without decrypting it", () => {
    const encrypted = rsaPrivate.export({
      type: "pkcs1",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "test-only",
    }).toString();
    expect(inspectPrivateKeyPem(encrypted)).toMatchObject({
      algorithm: "rsa",
      encrypted: true,
      bits: null,
    });
  });

  it("round-trips one PEM block and rejects non-PEM input", () => {
    const decoded = parsePemBlocks(CERT)[0];
    if (decoded === undefined) throw new Error("fixture did not parse");
    expect(parsePemBlocks(toPem(decoded.der, "CERTIFICATE"))[0]?.der).toEqual(
      decoded.der,
    );
    expect(parsePemBlocks("not a PEM file")).toEqual([]);
  });
});
