/** @vitest-environment jsdom */
import { X509Certificate, generateKeyPairSync, webcrypto } from "node:crypto";
import { X509CertificateGenerator } from "@peculiar/x509";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SignedXml } from "xml-crypto";
import type { SamlPendingRequest } from "./assertion-conditions.js";
import { createSamlAuthnPost } from "./authn-request.js";
import type { SamlRequestSigning } from "./authn-signature.js";
import type { SamlIdpMetadata } from "./metadata.js";

const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const A = "urn:oasis:names:tc:SAML:2.0:assertion";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const owner = () => ({
  signal: new AbortController().signal,
  assertCurrent() {},
});
let signing: SamlRequestSigning = { privateKeyPkcs8: "", certificate: "" };
let certificatePem = "";
let wrongPrivateKey = "";
beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const keys = {
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(pair.privateKey.export({ type: "pkcs8", format: "der" })),
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
  const generated = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: "01",
      name: "CN=Public synthetic SP fixture",
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 86400000),
      signingAlgorithm: algorithm,
      keys,
    },
    crypto,
  );
  const certificate = new X509Certificate(Buffer.from(generated.rawData));
  expect(certificate.verify(pair.publicKey)).toBe(true);
  certificatePem = certificate.toString();
  signing = {
    privateKeyPkcs8: pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    certificate: certificatePem,
  };
  wrongPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
});
afterAll(() => {
  signing = { privateKeyPkcs8: "", certificate: "" };
  wrongPrivateKey = "";
  vi.unstubAllGlobals();
});
function pending(): SamlPendingRequest {
  const now = Date.now();
  return {
    requestId: "_original_request",
    issuer: "urn:oracle:idp",
    audience: "urn:oracle:sp",
    acsUrl: "https://pwa.example.test/OpenSesame/auth/native-saml",
    issuedAt: now,
    expiresAt: now + 60000,
    nameIdFormat: FORMAT,
    authnContext:
      "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
    forceAuthentication: true,
  };
}
function metadata(signedRequests = false): SamlIdpMetadata {
  return {
    entityId: "urn:oracle:idp",
    postUrl: "https://idp.example.test/sso?tenant=fixture",
    signingSpki: [],
    nameIdFormats: [FORMAT],
    signedRequests,
    expiresAt: Date.now() + 120000,
  };
}
function parsed(encoded: string): Document {
  return new DOMParser().parseFromString(
    Buffer.from(encoded, "base64").toString("utf8"),
    "application/xml",
  );
}
function independentlyVerify(xml: string): boolean {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const signature = doc.getElementsByTagNameNS(DS, "Signature")[0];
  const verifier = new SignedXml({
    publicCert: certificatePem,
    getCertFromKeyInfo: () => null,
  });
  verifier.loadSignature(new XMLSerializer().serializeToString(signature));
  return verifier.checkSignature(xml);
}
it("encodes exact POST AuthnRequest fields as data with original ID, SP issuer, ACS, NameID and requested context", async () => {
  const request = pending();
  const result = await createSamlAuthnPost(request, metadata(), owner());
  const document = parsed(result.request);
  const root = document.documentElement;
  expect(root.namespaceURI).toBe(P);
  expect(root.localName).toBe("AuthnRequest");
  expect(result.destination).toBe(
    "https://idp.example.test/sso?tenant=fixture",
  );
  expect(root.getAttribute("ID")).toBe(request.requestId);
  expect(root.getAttribute("AssertionConsumerServiceURL")).toBe(request.acsUrl);
  expect(root.getAttribute("IssueInstant")).toBe(
    new Date(request.issuedAt).toISOString(),
  );
  expect(root.getAttribute("Destination")).toBe(result.destination);
  expect(root.getAttribute("ForceAuthn")).toBe("true");
  expect(document.getElementsByTagNameNS(A, "Issuer")[0].textContent).toBe(
    request.audience,
  );
  expect(
    document
      .getElementsByTagNameNS(P, "NameIDPolicy")[0]
      .getAttribute("Format"),
  ).toBe(FORMAT);
  expect(
    document.getElementsByTagNameNS(A, "AuthnContextClassRef")[0].textContent,
  ).toBe(request.authnContext);
  expect(document.getElementsByTagNameNS(DS, "Signature")).toHaveLength(0);
  expect(Object.isFrozen(result)).toBe(true);
});
it("uses official mature request signing with matching SP certificate and independent XML-crypto verification", async () => {
  const result = await createSamlAuthnPost(
    pending(),
    metadata(true),
    owner(),
    signing,
  );
  const xml = Buffer.from(result.request, "base64").toString("utf8");
  const document = parsed(result.request);
  expect(
    [...document.documentElement.children].map((child) => child.localName),
  ).toEqual(["Issuer", "Signature", "NameIDPolicy", "RequestedAuthnContext"]);
  expect(
    document.getElementsByTagNameNS(DS, "Reference")[0].getAttribute("URI"),
  ).toBe("#_original_request");
  expect(
    document
      .getElementsByTagNameNS(DS, "CanonicalizationMethod")[0]
      .getAttribute("Algorithm"),
  ).toBe("http://www.w3.org/2001/10/xml-exc-c14n#");
  expect(
    document
      .getElementsByTagNameNS(DS, "SignatureMethod")[0]
      .getAttribute("Algorithm"),
  ).toBe("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256");
  expect(independentlyVerify(xml)).toBe(true);
  expect(
    independentlyVerify(xml.replace("urn:oracle:sp", "urn:foreign:sp")),
  ).toBe(false);
  expect(
    independentlyVerify(
      xml.replace(
        "https://pwa.example.test/OpenSesame/auth/native-saml",
        "https://foreign.example.test/acs",
      ),
    ),
  ).toBe(false);
});
it("permits omitted exact authentication class and data-escapes SP text rather than injecting elements", async () => {
  const result = await createSamlAuthnPost(
    {
      ...pending(),
      audience: "urn:sp:<injected/>",
      authnContext: "",
      forceAuthentication: false,
    },
    metadata(),
    owner(),
  );
  const document = parsed(result.request);
  expect(document.getElementsByTagName("injected")).toHaveLength(0);
  expect(document.getElementsByTagNameNS(A, "Issuer")[0].textContent).toBe(
    "urn:sp:<injected/>",
  );
  expect(
    document.getElementsByTagNameNS(P, "RequestedAuthnContext"),
  ).toHaveLength(0);
});
it.each([
  ["foreign issuer", () => ({ ...pending(), issuer: "urn:foreign:idp" })],
  [
    "expired original request",
    () => ({ ...pending(), expiresAt: Date.now() - 1 }),
  ],
  ["future request", () => ({ ...pending(), issuedAt: Date.now() + 60000 })],
  [
    "excessive request lifetime",
    () => ({ ...pending(), expiresAt: Date.now() + 600000 }),
  ],
  [
    "invalid XML identifier",
    () => ({ ...pending(), requestId: "request with spaces" }),
  ],
  [
    "callback query secret",
    () => ({
      ...pending(),
      acsUrl: "https://pwa.example.test/acs?secret=value",
    }),
  ],
  [
    "callback insecure host",
    () => ({ ...pending(), acsUrl: "http://pwa.example.test/acs" }),
  ],
  ["control character", () => ({ ...pending(), audience: "urn:sp:\u0000" })],
  [
    "unadvertised NameID",
    () => ({ ...pending(), nameIdFormat: "urn:foreign:format" }),
  ],
] as const)("refuses %s before POST construction", async (_name, request) => {
  await expect(
    createSamlAuthnPost(request(), metadata(), owner()),
  ).rejects.toThrow();
});
it.each([
  ["metadata expired", () => ({ ...metadata(), expiresAt: Date.now() - 1 })],
  [
    "insecure IdP endpoint",
    () => ({ ...metadata(), postUrl: "http://idp.example.test/sso" }),
  ],
  [
    "IdP userinfo",
    () => ({
      ...metadata(),
      postUrl: "https://user:pass@idp.example.test/sso",
    }),
  ],
  [
    "IdP fragment",
    () => ({ ...metadata(), postUrl: "https://idp.example.test/sso#fragment" }),
  ],
  ["required signature missing", () => metadata(true)],
] as const)("refuses %s", async (_name, provider) => {
  await expect(
    createSamlAuthnPost(pending(), provider(), owner()),
  ).rejects.toThrow();
});
it.each([
  [
    "mismatched SP private key",
    () => ({ ...signing, privateKeyPkcs8: wrongPrivateKey }),
  ],
  [
    "malformed private key",
    () => ({ ...signing, privateKeyPkcs8: "not a key" }),
  ],
  [
    "encrypted private key label",
    () => ({
      ...signing,
      privateKeyPkcs8: signing.privateKeyPkcs8.replaceAll(
        "PRIVATE KEY",
        "ENCRYPTED PRIVATE KEY",
      ),
    }),
  ],
  ["malformed SP certificate", () => ({ ...signing, certificate: "YWJjZA==" })],
] as const)(
  "refuses %s with actual key parsing/matching",
  async (_name, credentials) => {
    await expect(
      createSamlAuthnPost(pending(), metadata(true), owner(), credentials()),
    ).rejects.toThrow();
  },
);
it("refuses an already cancelled owner", async () => {
  await expect(
    createSamlAuthnPost(pending(), metadata(), {
      signal: AbortSignal.abort(),
      assertCurrent() {},
    }),
  ).rejects.toThrow();
});
it("copies original request and signing configuration before a real async sign operation", async () => {
  const request = { ...pending() };
  const credentials = { ...signing };
  const operation = createSamlAuthnPost(
    request,
    metadata(true),
    owner(),
    credentials,
  );
  request.audience = "urn:changed:sp";
  request.acsUrl = "https://foreign.example.test/acs";
  credentials.privateKeyPkcs8 = wrongPrivateKey;
  const result = await operation;
  const document = parsed(result.request);
  expect(document.getElementsByTagNameNS(A, "Issuer")[0].textContent).toBe(
    "urn:oracle:sp",
  );
  expect(
    independentlyVerify(Buffer.from(result.request, "base64").toString("utf8")),
  ).toBe(true);
});
it("rechecks cancellation after a genuine signature operation rather than returning a stale signed POST", async () => {
  const control = new AbortController();
  const original = crypto.subtle.sign.bind(crypto.subtle);
  let reached: () => void = () => undefined;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(crypto.subtle, "sign")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      reached();
      await proceed;
      return result;
    });
  const work = createSamlAuthnPost(
    pending(),
    metadata(true),
    { signal: control.signal, assertCurrent() {} },
    signing,
  );
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
