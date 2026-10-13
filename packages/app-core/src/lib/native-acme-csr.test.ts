import { expect, it } from "vitest";
import { buildCsr, isCertificateName, p1363ToDer } from "./native-acme-csr.js";
import {
  csrSignatureHolds,
  derToP1363,
  parseCsr,
} from "./native-acme-der.test-support.js";

const keys = () =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);

it("builds a request whose names, key and signature a CA would accept", async () => {
  const pair = await keys();
  const names = ["example.com", "*.example.com", "www.example.org"];
  const parsed = parseCsr(await buildCsr(names, pair));
  expect(parsed.names).toEqual(names);
  // ACME takes its names from the request's extension, so the subject stays empty.
  expect(parsed.subjectBytes).toBe(0);
  // ecdsa-with-SHA256, 1.2.840.10045.4.3.2.
  expect(parsed.algorithm).toEqual([
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02,
  ]);
  expect(await csrSignatureHolds(parsed)).toBe(true);
  expect(parsed.spki).toEqual(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
  );
});

it("signs with the key it names, and a different key does not verify", async () => {
  const [signer, other] = [await keys(), await keys()];
  const good = parseCsr(await buildCsr(["a.example.org"], signer));
  expect(await csrSignatureHolds(good)).toBe(true);
  const forged = parseCsr(
    await buildCsr(["a.example.org"], {
      publicKey: other.publicKey,
      privateKey: signer.privateKey,
    }),
  );
  expect(await csrSignatureHolds(forged)).toBe(false);
});

it("encodes lengths past one byte, for many long names", async () => {
  const names = Array.from(
    { length: 20 },
    (_, index) => `${"a".repeat(50)}${index}.example.org`,
  );
  const parsed = parseCsr(await buildCsr(names, await keys()));
  expect(parsed.names).toEqual(names);
  expect(await csrSignatureHolds(parsed)).toBe(true);
});

it("round-trips a signature through DER, including the high bit and leading zeros", () => {
  const raw = new Uint8Array(64);
  raw[0] = 0x80;
  raw[31] = 0x01;
  raw[32] = 0x00;
  raw[33] = 0x7f;
  raw[63] = 0xff;
  expect(derToP1363(p1363ToDer(raw))).toEqual(raw);
});

it.each([
  "",
  "localhost",
  "exa mple.com",
  "a..example.com",
  "-a.example.com",
  "a-.example.com",
  "example.com/path",
  "*.*.example.com",
  "192.168.0.1",
  "example.123",
  `${"a".repeat(64)}.example.com`,
  `${"a.".repeat(130)}com`,
  "EXAMPLE.com",
])("refuses %j as a name", async (name) => {
  expect(isCertificateName(name)).toBe(false);
  await expect(buildCsr([name], await keys())).rejects.toThrow();
});

it("accepts ordinary, wildcard and internationalized names, and refuses an empty list", async () => {
  for (const name of [
    "example.com",
    "a.b.c.example.co",
    "*.example.com",
    "xn--bcher-kva.example",
    "*.xn--bcher-kva.example",
  ])
    expect(isCertificateName(name)).toBe(true);
  await expect(buildCsr([], await keys())).rejects.toThrow();
});
