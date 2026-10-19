/** @vitest-environment jsdom */
import { X509Certificate, generateKeyPairSync, webcrypto } from "node:crypto";
import { X509CertificateGenerator } from "@peculiar/x509";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { identityConnectionDraft } from "../../lib/identity-connections-presets.js";
import {
  bindNativeProviderTransport,
  nativeProviderTransport,
} from "../../lib/native-connector-transport.js";
import {
  loadConfiguredSamlMetadata,
  testNativeSamlConfiguration,
} from "./configured-runtime.js";

const releases: (() => void)[] = [];
let certificate = "";
let privateKey = "";
const nativeOwner = () => ({
  signal: new AbortController().signal,
  assertCurrent() {},
});
beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  privateKey = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const generated = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: "01",
      name: "CN=Public synthetic configured SAML",
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 86400000),
      signingAlgorithm: algorithm,
      keys: {
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
          new Uint8Array(
            pair.publicKey.export({ type: "spki", format: "der" }),
          ),
          algorithm,
          true,
          ["verify"],
        ),
      },
    },
    crypto,
  );
  const independentlyParsed = new X509Certificate(
    Buffer.from(generated.rawData),
  );
  expect(independentlyParsed.verify(pair.publicKey)).toBe(true);
  certificate = independentlyParsed.toString();
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
});
afterAll(() => {
  privateKey = "";
  vi.unstubAllGlobals();
});
function metadata(signed = false) {
  const der = certificate.replace(/-----[^-]+-----|\s+/g, "");
  return `<m:EntityDescriptor xmlns:m="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="urn:configured:idp"><m:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="${signed}"><m:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${der}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></m:KeyDescriptor><m:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</m:NameIDFormat><m:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/saml"/></m:IDPSSODescriptor></m:EntityDescriptor>`;
}
function draft() {
  return {
    ...identityConnectionDraft("byo-identity"),
    protocol: "saml" as const,
    samlEntityId: "urn:configured:idp",
    clientId: "urn:configured:sp",
    samlMetadataXml: metadata(),
  };
}
function transport(
  fetcher: typeof fetch,
  assertCurrent = () => undefined,
  signal?: AbortSignal,
) {
  releases.push(
    bindNativeProviderTransport({ fetch: fetcher, assertCurrent, signal }),
  );
}
it("loads inline metadata without requiring an HTTP runtime or issuing any request", async () => {
  const fetcher = vi.fn<typeof fetch>();
  transport(fetcher);
  await expect(
    loadConfiguredSamlMetadata(
      draft(),
      nativeOwner(),
      nativeProviderTransport(),
    ),
  ).resolves.toBe(metadata());
  expect(fetcher).not.toHaveBeenCalled();
});
it("uses the exact configured metadata endpoint with captured no-cookie/no-redirect transport", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(metadata()));
  transport(fetcher);
  const input = {
    ...draft(),
    samlMetadataXml: "",
    samlMetadataUrl: "https://idp.example/metadata?tenant=fixture",
  };
  await expect(
    loadConfiguredSamlMetadata(input, nativeOwner(), nativeProviderTransport()),
  ).resolves.toBe(metadata());
  expect(fetcher).toHaveBeenCalledWith(
    input.samlMetadataUrl,
    expect.objectContaining({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    }),
  );
});
it.each([
  "http://idp.example/metadata",
  "https://user:password@idp.example/metadata",
  "https://idp.example/metadata#foreign",
])("refuses an unsafe metadata endpoint %s before dispatch", async (url) => {
  const fetcher = vi.fn<typeof fetch>();
  transport(fetcher);
  await expect(
    loadConfiguredSamlMetadata(
      { ...draft(), samlMetadataXml: "", samlMetadataUrl: url },
      nativeOwner(),
      nativeProviderTransport(),
    ),
  ).rejects.toThrow("secure");
  expect(fetcher).not.toHaveBeenCalled();
});
it("refuses mixed metadata sources before dispatch", async () => {
  const fetcher = vi.fn<typeof fetch>();
  transport(fetcher);
  await expect(
    loadConfiguredSamlMetadata(
      { ...draft(), samlMetadataUrl: "https://idp.example/metadata" },
      nativeOwner(),
      nativeProviderTransport(),
    ),
  ).rejects.toThrow("exactly one");
  expect(fetcher).not.toHaveBeenCalled();
});
it("cancels an error response without exposing its raw body", async () => {
  const cancel = vi.fn();
  transport(
    async () => new Response(new ReadableStream({ cancel }), { status: 403 }),
  );
  await expect(
    loadConfiguredSamlMetadata(
      {
        ...draft(),
        samlMetadataXml: "",
        samlMetadataUrl: "https://idp.example/metadata",
      },
      nativeOwner(),
      nativeProviderTransport(),
    ),
  ).rejects.toThrow("metadata was not returned");
  expect(cancel).toHaveBeenCalledOnce();
});
it("cancels an oversized streaming XML response and releases its reader", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(262145));
      },
      cancel,
    }),
  );
  transport(async () => response);
  await expect(
    loadConfiguredSamlMetadata(
      {
        ...draft(),
        samlMetadataXml: "",
        samlMetadataUrl: "https://idp.example/metadata",
      },
      nativeOwner(),
      nativeProviderTransport(),
    ),
  ).rejects.toThrow("byte limit");
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});
it("refuses a late provider response after original owner change", async () => {
  let changed = false;
  const owner = {
    signal: new AbortController().signal,
    assertCurrent() {
      if (changed) throw new Error("Original target changed");
    },
  };
  transport(async () => {
    changed = true;
    return new Response(metadata());
  });
  await expect(
    loadConfiguredSamlMetadata(
      {
        ...draft(),
        samlMetadataXml: "",
        samlMetadataUrl: "https://idp.example/metadata",
      },
      owner,
      nativeProviderTransport(),
    ),
  ).rejects.toThrow("Original target changed");
});
it("refuses a late response from a retired transport lease", async () => {
  let changed = false;
  transport(
    async () => {
      changed = true;
      return new Response(metadata());
    },
    () => {
      if (changed) throw new Error("Original transport retired");
    },
  );
  await expect(
    loadConfiguredSamlMetadata(
      {
        ...draft(),
        samlMetadataXml: "",
        samlMetadataUrl: "https://idp.example/metadata",
      },
      nativeOwner(),
      nativeProviderTransport(),
    ),
  ).rejects.toThrow("Original transport retired");
});
it("refuses invalid UTF-8 rather than accepting replacement XML characters", async () => {
  transport(async () => new Response(new Uint8Array([0xc3, 0x28])));
  await expect(
    loadConfiguredSamlMetadata(
      {
        ...draft(),
        samlMetadataXml: "",
        samlMetadataUrl: "https://idp.example/metadata",
      },
      nativeOwner(),
      nativeProviderTransport(),
    ),
  ).rejects.toThrow();
});
it("checks genuine mature X509 metadata and unsigned request configuration without creating account evidence", async () => {
  const open = vi.spyOn(window, "open");
  expect(
    (await testNativeSamlConfiguration(draft(), nativeOwner())).message,
  ).toContain("Complete sign-in");
  expect(open).not.toHaveBeenCalled();
});
it("checks a genuine matching SP private key/certificate against mandatory signed-request metadata", async () => {
  const input = {
    ...draft(),
    samlMetadataXml: metadata(true),
    samlSigningPrivateKeyPkcs8: privateKey,
    samlSigningCertificate: certificate,
  };
  expect(
    (await testNativeSamlConfiguration(input, nativeOwner())).message,
  ).toContain("configuration verified");
});
it("refuses mandatory signed requests without a configured SP private key", async () => {
  await expect(
    testNativeSamlConfiguration(
      {
        ...draft(),
        samlMetadataXml: metadata(true),
      },
      nativeOwner(),
    ),
  ).rejects.toThrow(/sign/i);
});
it("refuses a genuine mismatched SP key and certificate", async () => {
  const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  await expect(
    testNativeSamlConfiguration(
      {
        ...draft(),
        samlMetadataXml: metadata(true),
        samlSigningPrivateKeyPkcs8: foreign,
        samlSigningCertificate: certificate,
      },
      nativeOwner(),
    ),
  ).rejects.toThrow(/match/i);
});

it("refuses URL metadata without its original captured route instead of looking up a later activation", async () => {
  const fetcher = vi.fn<typeof fetch>();
  transport(fetcher);
  await expect(
    loadConfiguredSamlMetadata(
      {
        ...draft(),
        samlMetadataXml: "",
        samlMetadataUrl: "https://idp.example/metadata",
      },
      nativeOwner(),
    ),
  ).rejects.toThrow("Original SAML metadata route is unavailable");
  expect(fetcher).not.toHaveBeenCalled();
});
