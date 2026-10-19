/** Actual transformed XMLDSIG, independently signed XML and real native WebCrypto. */
import { X509Certificate, generateKeyPairSync, webcrypto } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { JSDOM } from "jsdom";
import { build } from "vite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  readSamlBrowserCryptoInputs,
  samlBrowserCrypto,
} from "./saml-browser-crypto.mjs";

const root = existsSync(resolve(process.cwd(), "pnpm-workspace.yaml"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const core = resolve(root, "packages/app-core");
const oracle = createRequire(resolve(core, "package.json"));
const { SignedXml: IndependentSigner } = oracle("xml-crypto");
const { X509CertificateGenerator } = oracle("@peculiar/x509");
const input = readSamlBrowserCryptoInputs(root);
const directory = mkdtempSync(join(tmpdir(), "saml-real-sdk-"));
const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const A = "urn:oasis:names:tc:SAML:2.0:assertion";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const owner = () => ({
  signal: new AbortController().signal,
  assertCurrent() {},
});
let dom;
let api;
let included;
let raw;
let optimized;
let certificate;
let privateKey;
let spki;
let signed;

async function compile(plugins, name, unowned = false) {
  const entry = "\0owned-saml-application-test";
  const owned = ["xml-signature", "metadata", "authn-request"]
    .map(
      (file) =>
        `export * from ${JSON.stringify(resolve(core, `src/browser/saml/${file}.ts`))};`,
    )
    .join("\n");
  const code =
    unowned === "root"
      ? `export { SignedXml } from ${JSON.stringify(resolve(input.esm, "index.js"))};`
      : unowned === "internal"
        ? `${owned}\nexport { SignedXml } from ${JSON.stringify(resolve(input.esm, "signed_xml.js"))};`
        : owned;
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "test-owned-saml-application-entry",
        resolveId(id, importer) {
          if (id === entry) return entry;
          // Private candidate paths retain their actual app-core package owner.
          if (
            importer?.includes("/src/browser/saml/xml-crypto-") &&
            !id.startsWith(".")
          )
            return this.resolve(
              id,
              resolve(core, "src/browser/saml/xml-signature.ts"),
              { skipSelf: true },
            );
          return null;
        },
        load(id) {
          return id === entry ? code : null;
        },
      },
      ...plugins,
    ],
    build: {
      write: false,
      minify: "esbuild",
      target: "es2022",
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: "strict",
        output: { format: "es", inlineDynamicImports: true },
      },
    },
  });
  const chunks = result.output.filter((value) => value.type === "chunk");
  expect(chunks).toHaveLength(1);
  const path = join(directory, `${name}.mjs`);
  writeFileSync(path, chunks[0].code);
  return { path, code: chunks[0].code, ids: Object.keys(chunks[0].modules) };
}
function pending() {
  const now = Date.now();
  return {
    requestId: "_request",
    issuedAt: now,
    expiresAt: now + 60000,
    issuer: "urn:adapter:idp",
    audience: "urn:adapter:sp",
    acsUrl: "https://app.example/callback",
    nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    forceAuthentication: true,
    authnContext:
      "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
  };
}
function sign(xml) {
  const signer = new IndependentSigner({
    privateKey,
    publicCert: certificate,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: C14N,
  });
  signer.addReference({
    xpath: "//*[@ID='_response']",
    uri: "#_response",
    transforms: [`${DS}enveloped-signature`, C14N],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(xml, {
    prefix: "ds",
    location: { reference: "/*/*[local-name()='Issuer']", action: "after" },
  });
  return signer.getSignedXml();
}
function metadata(
  encoded = new X509Certificate(certificate).raw.toString("base64"),
) {
  return `<m:EntityDescriptor xmlns:m="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="${DS}" entityID="urn:adapter:idp"><m:IDPSSODescriptor protocolSupportEnumeration="${P}" WantAuthnRequestsSigned="true"><m:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${encoded}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></m:KeyDescriptor><m:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</m:NameIDFormat><m:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/sso"/></m:IDPSSODescriptor></m:EntityDescriptor>`;
}
beforeAll(async () => {
  dom = new JSDOM("<!doctype html><html></html>");
  Object.defineProperty(dom.window, "crypto", { value: webcrypto });
  for (const name of [
    "window",
    "self",
    "document",
    "DOMParser",
    "XMLSerializer",
    "Node",
    "NodeFilter",
    "XPathResult",
  ])
    vi.stubGlobal(name, name === "self" ? dom.window : dom.window[name]);
  vi.stubGlobal("crypto", webcrypto);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  spki = new Uint8Array(pair.publicKey.export({ type: "spki", format: "der" }));
  const keys = {
    publicKey: await crypto.subtle.importKey("spki", spki, algorithm, true, [
      "verify",
    ]),
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      pair.privateKey.export({ type: "pkcs8", format: "der" }),
      algorithm,
      false,
      ["sign"],
    ),
  };
  const generated = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: "01",
      name: "CN=Public transformed XMLDSIG fixture",
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 86400000),
      signingAlgorithm: algorithm,
      keys,
    },
    crypto,
  );
  const checked = new X509Certificate(Buffer.from(generated.rawData));
  expect(checked.verify(pair.publicKey)).toBe(true);
  certificate = checked.toString();
  raw = await compile([], "original-sdk");
  optimized = await compile([samlBrowserCrypto(root)], "shared-crypto-sdk");
  included = optimized.ids;
  api = await import(pathToFileURL(optimized.path).href);
  signed = sign(
    `<p:Response xmlns:p="${P}" xmlns:a="${A}" ID="_response" Version="2.0"><a:Issuer>urn:adapter:idp</a:Issuer><p:Status><p:StatusCode Value="${P}:status:Success"/></p:Status><a:Assertion ID="_assertion" Version="2.0"><a:Issuer>urn:adapter:idp</a:Issuer><a:Subject><a:NameID>synthetic-subject</a:NameID></a:Subject></a:Assertion></p:Response>`,
  );
}, 20000);
afterAll(() => {
  privateKey = "";
  dom?.window.close();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

it("retains the official XML verifier/canonicalizer with one existing certificate parser and no PKIjs", () => {
  expect(
    included.some((id) => id.endsWith("/xmldsigjs/build/esm/signed_xml.js")),
  ).toBe(true);
  expect(
    included.some((id) => id.endsWith("/xmldsigjs/build/esm/canonicalizer.js")),
  ).toBe(true);
  expect(
    included.filter((id) => id.endsWith("/@peculiar/x509/build/x509.es.js")),
  ).toHaveLength(1);
  expect(included.some((id) => /\/(pkijs|bytestreamjs)\//.test(id))).toBe(
    false,
  );
  expect(raw.ids.some((id) => id.includes("/pkijs/"))).toBe(true);
  expect(Buffer.byteLength(optimized.code)).toBeLessThan(
    Buffer.byteLength(raw.code),
  );
  expect(gzipSync(optimized.code, { level: 9 }).length).toBeLessThan(
    gzipSync(raw.code, { level: 9 }).length,
  );
});
it("verifies an independently signed certificate-bearing SAML response with explicit trusted SPKI", async () => {
  expect(signed).toContain("X509Certificate");
  const proof = await api.verifySamlXmlSignature(signed, [spki], owner());
  const covered = api.consumeSamlSignatureProof(proof);
  expect(covered.responseSigned).toBe(true);
  expect(covered.assertionSigned).toBe(false);
  expect(covered.xml).toBe(signed);
  expect(
    covered.assertion.getElementsByTagNameNS(A, "NameID")[0].textContent,
  ).toBe("synthetic-subject");
  expect(() => api.consumeSamlSignatureProof(proof)).toThrow(
    "verification failed",
  );
});
it("uses the same actual transformed certificate implementation for IdP metadata", async () => {
  const result = await api.readSamlIdpMetadata(
    metadata(),
    "urn:adapter:idp",
    owner(),
  );
  expect(result.signingSpki).toEqual([Buffer.from(spki).toString("base64")]);
  expect(result.signedRequests).toBe(true);
  expect(result.postUrl).toBe("https://idp.example/sso");
});
it("signs an SP request with the real transformed SDK and passes independent XMLDSIG verification", async () => {
  const request = pending();
  const parsed = await api.readSamlIdpMetadata(
    metadata(),
    "urn:adapter:idp",
    owner(),
  );
  const result = await api.createSamlAuthnPost(request, parsed, owner(), {
    privateKeyPkcs8: privateKey,
    certificate,
  });
  const xml = Buffer.from(result.request, "base64").toString("utf8");
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const signature = document.getElementsByTagNameNS(DS, "Signature")[0];
  expect(signature).toBeDefined();
  const verifier = new IndependentSigner({
    publicCert: certificate,
    getCertFromKeyInfo: () => null,
  });
  verifier.loadSignature(new XMLSerializer().serializeToString(signature));
  expect(verifier.checkSignature(xml)).toBe(true);
  expect(xml).toContain("X509Certificate");
});
it.each([
  [
    "signed content",
    (xml) => xml.replace("synthetic-subject", "tampered"),
    "verification failed",
  ],
  [
    "duplicate ID",
    (xml) => xml.replace("<a:Subject>", '<a:Subject ID="_response">'),
    "Invalid SAML signed document",
  ],
  [
    "unadmitted digest",
    (xml) => xml.replace("xmlenc#sha256", "xmldsig#sha1"),
    "Invalid SAML signed document",
  ],
  [
    "malformed certificate",
    (xml) =>
      xml.replace(/<ds:X509Certificate>[^<]+/, "<ds:X509Certificate>AQID"),
    "verification failed",
  ],
])(
  "refuses %s without weakening app XML structure or official cryptographic validation",
  async (_, change, error) => {
    await expect(
      api.verifySamlXmlSignature(change(signed), [spki], owner()),
    ).rejects.toThrow(error);
  },
);
it("does not trust a response's valid certificate when the configured anchor is different", async () => {
  const other = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).publicKey.export({ type: "spki", format: "der" });
  await expect(
    api.verifySamlXmlSignature(signed, [other], owner()),
  ).rejects.toThrow("verification failed");
});
it("rejects malformed metadata certificates and a mismatched SP signing key", async () => {
  await expect(
    api.readSamlIdpMetadata(metadata("AQID"), "urn:adapter:idp", owner()),
  ).rejects.toThrow();
  const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const document = new DOMParser().parseFromString(
    '<Request ID="_request"/>',
    "application/xml",
  );
  const parsed = await api.readSamlIdpMetadata(
    metadata(),
    "urn:adapter:idp",
    owner(),
  );
  await expect(
    api.createSamlAuthnPost(pending(), parsed, owner(), {
      privateKeyPkcs8: wrong,
      certificate,
    }),
  ).rejects.toThrow("matching RSA");
  expect(document.documentElement.childNodes.length).toBe(0);
});
it("refuses stale ownership after a real certificate-key import and never publishes a signature proof", async () => {
  const controller = new AbortController();
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  const spy = vi
    .spyOn(crypto.subtle, "importKey")
    .mockImplementation(async (...args) => {
      const key = await original(...args);
      controller.abort();
      return key;
    });
  try {
    await expect(
      api.verifySamlXmlSignature(signed, [spki], {
        signal: controller.signal,
        assertCurrent() {},
      }),
    ).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
});
it("refuses SDK source drift before substituting either wrapper", () => {
  const plugin = samlBrowserCrypto(root);
  plugin.buildStart();
  expect(() =>
    plugin.transform(
      `${readFileSync(input.application, "utf8")}\n`,
      input.application,
    ),
  ).toThrow("pin mismatch");
  expect(() =>
    plugin.transform(
      `${readFileSync(input.certificate, "utf8")}\n`,
      input.certificate,
    ),
  ).toThrow("pin mismatch");
  expect(
    plugin.transform("untouched", `${input.application}?other`),
  ).toBeNull();
});
it.each(["root", "internal"])(
  "refuses a real SDK %s graph imported outside the pinned SAML consumers",
  async (unowned) => {
    await expect(
      compile([samlBrowserCrypto(root)], `unowned-sdk-${unowned}`, unowned),
    ).rejects.toThrow("Unexpected browser XMLDSIG consumer");
  },
);
