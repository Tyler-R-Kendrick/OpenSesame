/** @vitest-environment jsdom */
import {
  X509Certificate,
  generateKeyPairSync,
  sign,
  webcrypto,
} from "node:crypto";
import { asBufferSource } from "@opensesame/os-domain";
import { X509CertificateGenerator } from "@peculiar/x509";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readSamlIdpMetadata } from "./metadata.js";

const MD = "urn:oasis:names:tc:SAML:2.0:metadata";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const entity = "urn:oracle:idp";
const owner = () => ({
  signal: new AbortController().signal,
  assertCurrent() {},
});
const certificates: string[] = [];
let signingKey = "";
let expectedSpki = "";
beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  for (let index = 0; index < 5; index++) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const keys = {
      privateKey: await crypto.subtle.importKey(
        "pkcs8",
        new Uint8Array(
          pair.privateKey.export({ type: "pkcs8", format: "der" }),
        ),
        algorithm,
        false,
        ["sign"],
      ),
      publicKey: await crypto.subtle.importKey(
        "spki",
        new Uint8Array(pair.publicKey.export({ type: "spki", format: "der" })),
        algorithm,
        true,
        ["verify"],
      ),
    };
    // Portable mature ASN.1 certificate generation; independent Node/OpenSSL verifies it.
    const generated = await X509CertificateGenerator.createSelfSigned(
      {
        serialNumber: (index + 1).toString(16).padStart(2, "0"),
        name: "CN=Public synthetic SAML fixture",
        notBefore: new Date(Date.now() - 60000),
        notAfter: new Date(Date.now() + 86400000),
        signingAlgorithm: algorithm,
        keys,
      },
      crypto,
    );
    const der = Buffer.from(generated.rawData);
    const certificate = new X509Certificate(der);
    expect(certificate.verify(pair.publicKey)).toBe(true);
    certificates.push(der.toString("base64"));
    if (index === 0) {
      signingKey = key;
      expectedSpki = pair.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64");
    }
  }
});
afterAll(() => {
  signingKey = "";
  vi.unstubAllGlobals();
});
function key(certificate = certificates[0], use = "signing"): string {
  return `<m:KeyDescriptor use="${use}"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></m:KeyDescriptor>`;
}
function metadata(keys = key(), options = ""): string {
  return `<m:EntityDescriptor xmlns:m="${MD}" xmlns:ds="${DS}" entityID="${entity}" ID="_metadata"><m:IDPSSODescriptor protocolSupportEnumeration="${P}" ${options}>${keys}<m:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</m:NameIDFormat><m:SingleSignOnService Binding="${POST}" Location="https://idp.example.test/sso?tenant=fixture"/></m:IDPSSODescriptor></m:EntityDescriptor>`;
}
it("extracts an actual X509 RSA key through mature browser XMLDSIG code and verifies an independent Node signature", async () => {
  const parsed = await readSamlIdpMetadata(metadata(), entity, owner());
  expect(parsed.signingSpki).toEqual([expectedSpki]);
  expect(parsed.postUrl).toBe("https://idp.example.test/sso?tenant=fixture");
  expect(parsed.signedRequests).toBe(false);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.signingSpki)).toBe(true);
  const publicKey = await crypto.subtle.importKey(
    "spki",
    asBufferSource(Buffer.from(parsed.signingSpki[0], "base64")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const message = Buffer.from(
    "independent public synthetic metadata-key interoperability",
  );
  expect(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      asBufferSource(sign("sha256", message, signingKey)),
      asBufferSource(message),
    ),
  ).toBe(true);
});
it("accepts four distinct rollover signing anchors, deduplicates certificates, and ignores encryption keys", async () => {
  const keys =
    certificates
      .slice(0, 4)
      .map((value) => key(value))
      .join("") +
    key() +
    key("not-a-signing-certificate", "encryption");
  expect(
    (await readSamlIdpMetadata(metadata(keys), entity, owner())).signingSpki,
  ).toHaveLength(4);
});
it("uses the configured entity inside nested federation groups and ignores unrelated entities", async () => {
  const selected = metadata().replace(' ID="_metadata"', "");
  const other = selected.replace(
    `entityID="${entity}"`,
    'entityID="urn:other:idp"',
  );
  const grouped = `<m:EntitiesDescriptor xmlns:m="${MD}">${other}<m:EntitiesDescriptor>${selected}</m:EntitiesDescriptor></m:EntitiesDescriptor>`;
  expect((await readSamlIdpMetadata(grouped, entity, owner())).entityId).toBe(
    entity,
  );
});
it.each(["true", "1", "false", "0"])(
  "captures the standard WantAuthnRequestsSigned value %s",
  async (value) => {
    expect(
      (
        await readSamlIdpMetadata(
          metadata(key(), `WantAuthnRequestsSigned="${value}"`),
          entity,
          owner(),
        )
      ).signedRequests,
    ).toBe(["true", "1"].includes(value));
  },
);
it("intersects metadata group/entity/descriptor validity with strict SAML calendar parsing", async () => {
  const deadline = new Date(Date.now() + 60000).toISOString();
  const later = new Date(Date.now() + 120000).toISOString();
  const xml = `<m:EntitiesDescriptor xmlns:m="${MD}" validUntil="${deadline}">${metadata(key(), `validUntil="${later}"`)}</m:EntitiesDescriptor>`;
  expect((await readSamlIdpMetadata(xml, entity, owner())).expiresAt).toBe(
    Date.parse(deadline),
  );
});
it.each([
  [
    "wrong configured entity",
    () =>
      metadata().replace(
        'entityID="urn:oracle:idp"',
        'entityID="urn:foreign:idp"',
      ),
  ],
  [
    "foreign metadata namespace",
    () => metadata().replaceAll(MD, "urn:foreign:metadata"),
  ],
  [
    "duplicate entity",
    () =>
      `<m:EntitiesDescriptor xmlns:m="${MD}">${metadata().replace(' ID="_metadata"', "")}${metadata().replace(' ID="_metadata"', "")}</m:EntitiesDescriptor>`,
  ],
  [
    "entity hidden in extensions",
    () =>
      `<m:EntitiesDescriptor xmlns:m="${MD}"><m:Extensions>${metadata()}</m:Extensions></m:EntitiesDescriptor>`,
  ],
  [
    "duplicate XML ID",
    () =>
      metadata().replace("<m:NameIDFormat>", '<m:NameIDFormat ID="_metadata">'),
  ],
  [
    "DTD",
    () => `<!DOCTYPE m:EntityDescriptor [<!ENTITY x "hidden">]>${metadata()}`,
  ],
  [
    "processing instruction",
    () => `<?stylesheet external="https://foreign.test/"?>${metadata()}`,
  ],
  ["XML byte limit", () => metadata() + " ".repeat(262144)],
  [
    "XML depth",
    () =>
      `<m:EntitiesDescriptor xmlns:m="${MD}">${"<m:EntitiesDescriptor>".repeat(33)}${metadata()}${"</m:EntitiesDescriptor>".repeat(33)}</m:EntitiesDescriptor>`,
  ],
  [
    "expired metadata",
    () => metadata(key(), 'validUntil="2000-01-01T00:00:00Z"'),
  ],
  [
    "invalid future calendar",
    () => metadata(key(), 'validUntil="2096-02-30T00:00:00Z"'),
  ],
  [
    "missing POST binding",
    () =>
      metadata().replace(
        POST,
        "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
      ),
  ],
  [
    "ambiguous POST endpoints",
    () =>
      metadata().replace(
        "</m:IDPSSODescriptor>",
        `<m:SingleSignOnService Binding="${POST}" Location="https://other.example.test/sso"/></m:IDPSSODescriptor>`,
      ),
  ],
  [
    "foreign SAML protocol",
    () => metadata().replace(P, "urn:foreign:protocol"),
  ],
  [
    "invalid signing flag",
    () => metadata(key(), 'WantAuthnRequestsSigned="yes"'),
  ],
  ["missing signing key", () => metadata("")],
  [
    "too many signing keys",
    () => metadata(certificates.map((value) => key(value)).join("")),
  ],
  ["encryption key only", () => metadata(key(certificates[0], "encryption"))],
  [
    "external key retrieval",
    () =>
      metadata(
        '<m:KeyDescriptor><ds:KeyInfo><ds:RetrievalMethod URI="https://foreign.test/key"/></ds:KeyInfo></m:KeyDescriptor>',
      ),
  ],
  ["invalid certificate encoding", () => metadata(key("not-base64!"))],
  ["invalid ASN1 certificate", () => metadata(key("YWJjZA=="))],
  [
    "SSO credentials in URL",
    () =>
      metadata().replace(
        "https://idp.example.test/sso?tenant=fixture",
        "https://user:pass@idp.example.test/sso",
      ),
  ],
  [
    "insecure nonloopback SSO",
    () =>
      metadata().replace(
        "https://idp.example.test/sso?tenant=fixture",
        "http://idp.example.test/sso",
      ),
  ],
] as const)("refuses %s", async (_name, xml) => {
  await expect(readSamlIdpMetadata(xml(), entity, owner())).rejects.toThrow();
});
it("allows explicit browser development loopback SSO", async () => {
  expect(
    (
      await readSamlIdpMetadata(
        metadata().replace(
          "https://idp.example.test/sso?tenant=fixture",
          "http://127.0.0.1:12345/sso",
        ),
        entity,
        owner(),
      )
    ).postUrl,
  ).toBe("http://127.0.0.1:12345/sso");
});
it("rejects already-cancelled ownership before parsing or importing keys", async () => {
  await expect(
    readSamlIdpMetadata(metadata(), entity, {
      signal: AbortSignal.abort(),
      assertCurrent() {},
    }),
  ).rejects.toThrow();
});
it("rechecks the original owner after actual X509 public-key export before returning copied trust", async () => {
  const control = new AbortController();
  const original = crypto.subtle.exportKey.bind(crypto.subtle);
  let reached: () => void = () => undefined;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(crypto.subtle, "exportKey")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      reached();
      await proceed;
      return result;
    });
  const work = readSamlIdpMetadata(metadata(), entity, {
    signal: control.signal,
    assertCurrent() {},
  });
  const rejected = expect(work).rejects.toThrow();
  try {
    await held;
    control.abort();
    release();
    await rejected;
  } finally {
    release();
    spy.mockRestore();
  }
});
