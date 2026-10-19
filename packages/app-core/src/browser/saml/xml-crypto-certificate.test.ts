/** @vitest-environment jsdom */
import { X509Certificate as NodeCertificate, webcrypto } from "node:crypto";
import { X509CertificateGenerator } from "@peculiar/x509";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Application } from "./xml-crypto-application.js";
import { X509Certificate } from "./xml-crypto-certificate.js";

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
let raw: Uint8Array<ArrayBuffer>;
let pair: CryptoKeyPair;
beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  Application.setEngine("public synthetic test", globalThis.crypto);
  pair = await crypto.subtle.generateKey(
    {
      ...algorithm,
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: "01",
      name: "CN=Public synthetic XMLDSIG certificate",
      notBefore: new Date("2026-01-01T00:00:00Z"),
      notAfter: new Date("2027-01-01T00:00:00Z"),
      signingAlgorithm: algorithm,
      keys: pair,
    },
    crypto,
  );
  raw = new Uint8Array(certificate.rawData);
});
afterAll(() => vi.unstubAllGlobals());

it("parses a real DER certificate and exports the independently verified RSA public key", async () => {
  const node = new NodeCertificate(raw);
  expect(node.verify(node.publicKey)).toBe(true);
  const certificate = new X509Certificate(raw);
  expect(certificate.PublicKey).toBeNull();
  const key = await certificate.exportKey(algorithm);
  expect(certificate.PublicKey).toBe(key);
  expect(Buffer.from(await crypto.subtle.exportKey("spki", key))).toEqual(
    node.publicKey.export({ format: "der", type: "spki" }),
  );
  expect(certificate.SerialNumber).toBe("1");
  expect(certificate.Issuer).toContain("Public synthetic XMLDSIG certificate");
  expect(certificate.Subject).toBe(certificate.Issuer);
  const message = new TextEncoder().encode("NUL\0 and Unicode 雪");
  const signature = await crypto.subtle.sign(
    algorithm,
    pair.privateKey,
    message,
  );
  expect(await crypto.subtle.verify(algorithm, key, signature, message)).toBe(
    true,
  );
  expect(
    await crypto.subtle.verify(algorithm, key, signature, new Uint8Array([1])),
  ).toBe(false);
});
it("retains owned DER bytes across input and returned-buffer mutations", () => {
  const input = Uint8Array.from(raw);
  const certificate = new X509Certificate(input);
  input.fill(0);
  const returned = certificate.GetRaw();
  expect(Buffer.from(returned).equals(Buffer.from(raw))).toBe(true);
  returned.fill(0);
  expect(Buffer.from(certificate.GetRaw()).equals(Buffer.from(raw))).toBe(true);
});
it("accepts BufferSource slices without consuming unrelated surrounding bytes", () => {
  const enclosing = new Uint8Array(raw.length + 8);
  enclosing.set(raw, 4);
  const view = new DataView(enclosing.buffer, 4, raw.length);
  expect(
    Buffer.from(new X509Certificate(view).GetRaw()).equals(Buffer.from(raw)),
  ).toBe(true);
});
it("uses native WebCrypto for the default certificate key and thumbprint", async () => {
  const certificate = new X509Certificate(raw);
  expect((await certificate.exportKey()).algorithm.name).toBe(algorithm.name);
  expect(await certificate.Thumbprint("SHA-256")).toEqual(
    await crypto.subtle.digest("SHA-256", raw),
  );
  expect(Application.crypto).toBe(webcrypto);
});
it.each([
  new Uint8Array(),
  new Uint8Array([0x30, 0x01]),
  new Uint8Array([1, 2, 3]),
])(
  "rejects malformed certificate DER rather than accepting a fabricated key %#",
  (value) => {
    expect(() => new X509Certificate(value)).toThrow();
  },
);
it.each([
  { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" },
  { name: "RSA-PSS", hash: "SHA-256" },
  { name: "ECDSA", hash: "SHA-256" },
  { name: "RSASSA-PKCS1-v1_5" },
])(
  "refuses an export outside the closed app RSA/SHA-256 policy %#",
  async (value) => {
    const certificate = new X509Certificate(raw);
    await expect(certificate.exportKey(value)).rejects.toThrow("not admitted");
    expect(certificate.PublicKey).toBeNull();
  },
);
it("parses ordinary EC certificate KeyInfo without rejecting a valid certificate hint", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: "02",
      name: "CN=Public EC certificate hint",
      notBefore: new Date("2026-01-01T00:00:00Z"),
      notAfter: new Date("2027-01-01T00:00:00Z"),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      keys,
    },
    crypto,
  );
  const parsed = new X509Certificate(certificate.rawData);
  expect(
    Buffer.from(parsed.GetRaw()).equals(Buffer.from(certificate.rawData)),
  ).toBe(true);
  await expect(parsed.exportKey(algorithm)).rejects.toThrow();
});
