/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  type SamlSignatureProof,
  consumeSamlSignatureProof,
  verifySamlXmlSignature,
} from "./xml-signature.js";

// Public-only synthetic vectors: independent xml-crypto6.1.2 RSA2048 signer.
// Private oracle receipt73c7354ac2cf982908db42477a9325736f8c7dcae89ccb57d7edf141e710d254;
// fixtures.json is pinned there. No verifier-library signer or private keys.
const vectors = {
  publicSpki:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAme43F+w5rwZjkrU6AeI6HyHx4n3CJa2fOSYdStZD9eI5uuSDkoJc6VW+RPUu/ltmRx3f4Sgge2UljUvCTRTFmdpRMX5TAOAWsyYz+4+vVAhAAikEXaQ1ZEa6vIey9XnrQkwitYA0VKyD2EJ4SVEAV0E8A1enRh8kqM2xQNa3A0qZyKZNdM19iR8LLkJ1BrFOZ6bcQUoU8VH0KC2b722sX69p+kE9fyS/z07EKuR51x64kvb/HVkFIpHdrM/rfO+X2xJDdAnbi3h+k9kJ8GbhiQ5WF71y45b+bGlXu3Soc0G6rp1uVn2p9QIU09iTOcZY3YqIpr+Jw/2Pn+Nwci98iQIDAQAB",
  otherSpki:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAovcOy7FpXz8TqXDiyPMcb2tr/8TLjBUuHSmNCm3y6mbP9p50hmLRTtxh0O8BM/egirLasiG3JPbwOoNoU3Ix2mxWtFSsQ2UZchDDLjY+JJfE4kwnu3dc40uLU7oqjQf19avN+FvTyf2aSgcJ1Qf+iRT+++FjCYYzWF+DaR2WGeULZQ3ZOdGIwLcbgYwb5v2kZ7wECgZeXPOXHNMeg3sctX5w2aTfvnQxEAfmIVhmTsX2wlBQ77cqbGbhzVwEZVj0ZxhviMkEpYL12pUbUul8W+pVs3PBeYyu8+7GiAJi74RwAaXn6+K0OqEiYHK+cdDP0qt/3tUTwjolygj3bhqJdwIDAQAB",
  root: '<p:Response xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:context="urn:oracle:ancestor" ID="_response" Version="2.0"><a:Issuer>urn:oracle:idp</a:Issuer><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#_response"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>79NQi2Ivyz66VfnWCnW3weKK+lFGyDhzEmESRUOVSCM=</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>UoUmhUJVTPzPkHHs27B+OlH/V1p9ICdldGD7JFjuWS73e7AbEq+W3XSKgASNt0nwkiwh1VcPJlUAd68FVdDEwWxjc/6LRNQPqfvuxKizM0WlofsiLaW1D4YZ07ViMdeodT0jZ/yucnbSe1d4iF2ijvc0MMHSM60zZYlTEIfyrxp5EAV+NO28L7hqt4RXnnw+aly5+yffLXoPt5TlaWuR9fJ8702MKRZqHfsYGLs0mVTESUBXL24/lLSPzkHuOrD7Dwx98K1QEedj98cVme5U7mqNaAPucv/UZgC8QQ8C/7JP97VYcsT3/7GFmatW3usY+/muubboEkBpWftsQNo1Vw==</ds:SignatureValue></ds:Signature><p:Status ID="_status"><p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></p:Status><a:Assertion ID="_assertion" Version="2.0"><a:Issuer>urn:oracle:idp</a:Issuer><a:Subject><a:NameID context:scope="fixed">synthetic-subject</a:NameID></a:Subject></a:Assertion></p:Response>',
  assertion:
    '<p:Response xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:context="urn:oracle:ancestor" ID="_response" Version="2.0"><a:Issuer>urn:oracle:idp</a:Issuer><p:Status ID="_status"><p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></p:Status><a:Assertion ID="_assertion" Version="2.0"><a:Issuer>urn:oracle:idp</a:Issuer><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#_assertion"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>Y++vHAEx8FTh2ApjswHJzvIQwZyWkgSXgSuOxANatWg=</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>jX9SJ7VPue5b+G6MhKFP1EELJVe3SRFAJvOKIl5oVA1AoDraYPrXrPaCqMURoWQdCMNZpCnf0grTCywuHIq4LHKAuVuP4WNBtEZxDh+h5zvz4vA86A4A+4RLKDXUqT0ThT+UmKSfCOO+cquXs4V39NqEfQG8c0fenM76FlUYSBua1M4i8aL5FWGe2KBJIf24ho7J0Rxn68jO4xqlnVT3Kzx5frV8fZuHbd6tutxmZqJv7SXGiQUCSIWiGoVfi0tIElUUs1OoJEiDTcLQ7qoRhkby3i9mzGpzWFxORoZAwI164rJkdRnb/f/8+5AQN5kCsScq6noUiuSsz2W+FdS0Xw==</ds:SignatureValue></ds:Signature><a:Subject><a:NameID context:scope="fixed">synthetic-subject</a:NameID></a:Subject></a:Assertion></p:Response>',
  both: '<p:Response xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:context="urn:oracle:ancestor" ID="_response" Version="2.0"><a:Issuer>urn:oracle:idp</a:Issuer><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#_response"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>QABHuIjwtRHRo4K7SsiQohDHtadKy1SBTQwG/Wxy3ok=</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>KNRBEzRlfroiOtEo7Z5LATfImF/99XCIYT0v3ZZX6SfcNNehAKyNhGHw0Ec4eB8a1Xp7kXcP4FiU1fix7uRUhvbCA8mJ13TaxLMD3f7B1RHz/8t8TfAyHS+ck1GoFomu8ygbbWUqGreLExVli/eioNkG5WXwuDRmG8RLx0Z9mfxyKxEpvVu3Ls56++MCCAbCsXPgaUhVOcHiwnMq9NKfNHZ8ChFoCpek8HD2RPzLldDi0/S7dA+NJYmZPEH43PEAT7FYKqGiWm+Sl11cgOL1leWbFfm4Q7DSb+VhRGMD/3kPC4f9XfceF4XwPgu4BAn65dGJzqqamzuUJmVY96ytZA==</ds:SignatureValue></ds:Signature><p:Status ID="_status"><p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></p:Status><a:Assertion ID="_assertion" Version="2.0"><a:Issuer>urn:oracle:idp</a:Issuer><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#_assertion"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>Y++vHAEx8FTh2ApjswHJzvIQwZyWkgSXgSuOxANatWg=</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>jX9SJ7VPue5b+G6MhKFP1EELJVe3SRFAJvOKIl5oVA1AoDraYPrXrPaCqMURoWQdCMNZpCnf0grTCywuHIq4LHKAuVuP4WNBtEZxDh+h5zvz4vA86A4A+4RLKDXUqT0ThT+UmKSfCOO+cquXs4V39NqEfQG8c0fenM76FlUYSBua1M4i8aL5FWGe2KBJIf24ho7J0Rxn68jO4xqlnVT3Kzx5frV8fZuHbd6tutxmZqJv7SXGiQUCSIWiGoVfi0tIElUUs1OoJEiDTcLQ7qoRhkby3i9mzGpzWFxORoZAwI164rJkdRnb/f/8+5AQN5kCsScq6noUiuSsz2W+FdS0Xw==</ds:SignatureValue></ds:Signature><a:Subject><a:NameID context:scope="fixed">synthetic-subject</a:NameID></a:Subject></a:Assertion></p:Response>',
  wrongElement:
    '<p:Response xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:context="urn:oracle:ancestor" ID="_response" Version="2.0"><a:Issuer>urn:oracle:idp</a:Issuer><p:Status ID="_status"><p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></p:Status><a:Assertion ID="_assertion" Version="2.0"><a:Issuer>urn:oracle:idp</a:Issuer><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#_status"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>aLVn3pzOg0/sB9E4Ro5+3BqRrS8OFJxENlTwPM3jf2o=</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>TCi42doQ09oXvevgcCt+b6kRcFORFh03sL0fkmPnO63pBjNp+8A3Z1JLZdoiOJLz3mcvyIDl85xYHzvksqYeUzFddK1PgIfY6XsLwlXkCE/lXKQTBItmgevUmGV54W7lzttTRMAQurHwiAwoFcRDQzplaOYaoi4oWaruMyunlbJQ4aidnqu8Lk0cy17rHaGPFY5lMSa1Odibxqd9Lkt1cV+Ms+jvjbD8crqcKi0VN+uA7UXMgmd0OMPecoOrY7VQt5Ed6BDr6MmHFyXAr0FK4VslyvuFm7VTAbUyGU2USUFEBDdrxIZhIkMvKSG+trO+JQEs0CwrcYEFyW84pX3Klg==</ds:SignatureValue></ds:Signature><a:Subject><a:NameID context:scope="fixed">synthetic-subject</a:NameID></a:Subject></a:Assertion></p:Response>',
  sha1: '<p:Response xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:context="urn:oracle:ancestor" ID="_response" Version="2.0"><a:Issuer>urn:oracle:idp</a:Issuer><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><ds:Reference URI="#_response"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><ds:DigestValue>Ik7u/xQuYQ4eSmuQIe0mdqRe3FE=</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>C+bsxlqyPiYyO0RZCJpy28ThgUJIZDwWrq7YOz0TaWuw3XYxtb9Kp3VLHlKzAtoLeGL0pGBdMx4eX6B1TH6g1EDpDhTcRlFAW9WT1dWec4qwrARvILNVjJbuHEcf3k8VqHYy+WHZ4ceRcOsfHa+WJ7EUwydNAY+s6Q73I4cEn8zSjvjP5D4XZMUkyH5IG0POCc0n2qjSVwkW2V/icaH0bwq6EXjL7tJv3759w3F0ykImKqBd3mTkW3p6r/0XCZ3sV7E1ypDMlInNPaWaV8QzO4cJS9hzTW02WgCmODGRkO62qApSzIlJDCHkWwGBqB6PvIFPndPLdcO/iDYO8/3geQ==</ds:SignatureValue></ds:Signature><p:Status ID="_status"><p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></p:Status><a:Assertion ID="_assertion" Version="2.0"><a:Issuer>urn:oracle:idp</a:Issuer><a:Subject><a:NameID context:scope="fixed">synthetic-subject</a:NameID></a:Subject></a:Assertion></p:Response>',
};
const ds = "http://www.w3.org/2000/09/xmldsig#";
const c14n = "http://www.w3.org/2001/10/xml-exc-c14n#";
const bytes = (base64: string) =>
  Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
const owner = () => ({
  signal: new AbortController().signal,
  assertCurrent() {},
});
const verify = (xml: string) =>
  verifySamlXmlSignature(xml, [bytes(vectors.publicSpki)], owner());
beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

it.each([
  ["root", true, false],
  ["assertion", false, true],
  ["both", true, true],
] as const)(
  "verifies independent %s signatures with the exact original covered document",
  async (name, responseSigned, assertionSigned) => {
    const proof = await verify(vectors[name]);
    const covered = consumeSamlSignatureProof(proof);
    expect(covered).toMatchObject({
      responseSigned,
      assertionSigned,
      xml: vectors[name],
    });
    expect(covered.assertion.parentElement).toBe(covered.response);
    expect(
      covered.assertion.getElementsByTagNameNS(
        "urn:oasis:names:tc:SAML:2.0:assertion",
        "NameID",
      )[0].textContent,
    ).toBe("synthetic-subject");
    expect(() => consumeSamlSignatureProof(proof)).toThrow(
      "verification failed",
    );
  },
);

it("accepts a normal XML declaration without admitting processing instructions", async () => {
  const proof = await verify(
    `<?xml version="1.0" encoding="UTF-8"?>${vectors.root}`,
  );
  expect(consumeSamlSignatureProof(proof).responseSigned).toBe(true);
});

const invalidDocuments = [
  [
    "changed signed subject",
    vectors.root.replace("synthetic-subject", "attacker"),
  ],
  [
    "changed inherited namespace",
    vectors.assertion.replace("urn:oracle:ancestor", "urn:attacker"),
  ],
  [
    "duplicate ID",
    vectors.root.replace("<a:Subject>", '<a:Subject ID="_response">'),
  ],
  [
    "duplicate Id",
    vectors.root.replace("<a:Subject>", '<a:Subject Id="_response">'),
  ],
  [
    "duplicate id",
    vectors.root.replace("<a:Subject>", '<a:Subject id="_response">'),
  ],
  [
    "duplicate xml:id",
    vectors.root.replace("<a:Subject>", '<a:Subject xml:id="_response">'),
  ],
  [
    "multiple ID attributes",
    vectors.root.replace('ID="_response"', 'ID="_response" Id="_another"'),
  ],
  [
    "nested signed assertion",
    vectors.assertion.replace(
      /<a:Assertion\b[\s\S]*<\/a:Assertion>/,
      (signed) =>
        `<a:Assertion ID="_evil" Version="2.0"><a:Advice>${signed}</a:Advice></a:Assertion>`,
    ),
  ],
  [
    "second assertion",
    vectors.root.replace(
      "</p:Response>",
      '<a:Assertion ID="_extra" Version="2.0"/></p:Response>',
    ),
  ],
  ["wrong-element signature", vectors.wrongElement],
  [
    "algorithm CDATA parameter",
    vectors.root.replace(
      '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>',
      '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"><![CDATA[unapproved]]></ds:SignatureMethod>',
    ),
  ],
  [
    "external reference",
    vectors.root.replace(
      'URI="#_response"',
      'URI="https://attacker.invalid/a"',
    ),
  ],
  ["empty reference", vectors.root.replace('URI="#_response"', 'URI=""')],
  [
    "XPointer reference",
    vectors.root.replace(
      'URI="#_response"',
      "URI=\"#xpointer(id('_response'))\"",
    ),
  ],
  [
    "extra reference",
    vectors.root.replace(
      "</ds:SignedInfo>",
      '<ds:Reference URI="#_assertion"/></ds:SignedInfo>',
    ),
  ],
  [
    "unsupported transform",
    vectors.root.replace(`${ds}enveloped-signature`, `${ds}base64`),
  ],
  [
    "inclusive namespace parameter",
    vectors.root.replace(
      `<ds:Transform Algorithm="${c14n}"/>`,
      `<ds:Transform Algorithm="${c14n}"><InclusiveNamespaces xmlns="${c14n}" PrefixList="a"/></ds:Transform>`,
    ),
  ],
  [
    "reordered transforms",
    vectors.root.replace(
      `<ds:Transform Algorithm="${ds}enveloped-signature"/><ds:Transform Algorithm="${c14n}"/>`,
      `<ds:Transform Algorithm="${c14n}"/><ds:Transform Algorithm="${ds}enveloped-signature"/>`,
    ),
  ],
  ["genuinely signed SHA1", vectors.sha1],
  ["DOCTYPE", `<!DOCTYPE p:Response>${vectors.root}`],
  [
    "entity declaration",
    `<!DOCTYPE p:Response [<!ENTITY x "value">]>${vectors.root}`,
  ],
  ["processing instruction", `<?untrusted action?>${vectors.root}`],
  ["malformed XML", vectors.root.slice(0, -4)],
  ["oversized XML", `${vectors.root}${" ".repeat(262144)}`],
  [
    "excessive depth",
    vectors.root
      .replace("<a:Subject>", `<a:Subject>${"<nested>".repeat(33)}`)
      .replace("</a:Subject>", `${"</nested>".repeat(33)}</a:Subject>`),
  ],
  [
    "excessive nodes",
    vectors.root.replace("<a:Subject>", `<a:Subject>${"<node/>".repeat(4096)}`),
  ],
  [
    "excessive attributes",
    vectors.root.replace(
      "<a:Subject>",
      `<a:Subject ${Array.from({ length: 33 }, (_, index) => `x${index}="v"`).join(" ")}>`,
    ),
  ],
  [
    "oversized text",
    vectors.root.replace("synthetic-subject", "a".repeat(16385)),
  ],
  [
    "unexpected signature child",
    vectors.root.replace("</ds:Signature>", "<ds:Object/></ds:Signature>"),
  ],
  [
    "external key retrieval",
    vectors.root.replace(
      "</ds:Signature>",
      '<ds:KeyInfo><ds:RetrievalMethod URI="https://attacker.invalid/key"/></ds:KeyInfo></ds:Signature>',
    ),
  ],
  [
    "malformed extra signature",
    vectors.assertion.replace(
      "</p:Response>",
      '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></p:Response>',
    ),
  ],
] as const;
it.each(invalidDocuments)("rejects %s", async (_name, document) => {
  await expect(verify(document)).rejects.toThrow();
});

it("uses only approved anchors even when the signature carries a different public key", async () => {
  const foreign = await crypto.subtle.importKey(
    "spki",
    bytes(vectors.otherSpki),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", foreign);
  const base64 = (value: string) =>
    value.replaceAll("-", "+").replaceAll("_", "/");
  const withForeignKey = vectors.root.replace(
    "</ds:Signature>",
    `<ds:KeyInfo><ds:KeyValue><ds:RSAKeyValue><ds:Modulus>${base64(jwk.n ?? "")}</ds:Modulus><ds:Exponent>${base64(jwk.e ?? "")}</ds:Exponent></ds:RSAKeyValue></ds:KeyValue></ds:KeyInfo></ds:Signature>`,
  );
  expect(
    consumeSamlSignatureProof(await verify(withForeignKey)).responseSigned,
  ).toBe(true);
  await expect(
    verifySamlXmlSignature(withForeignKey, [bytes(vectors.otherSpki)], owner()),
  ).rejects.toThrow("verification failed");
});

it("copies approved key bytes before asynchronous library loading", async () => {
  const anchor = bytes(vectors.publicSpki);
  const operation = verifySamlXmlSignature(vectors.root, [anchor], owner());
  anchor.fill(0);
  expect(consumeSamlSignatureProof(await operation).responseSigned).toBe(true);
});

it("rejects forged, copied and already consumed signature capabilities", async () => {
  const proof = await verify(vectors.root);
  expect(() => consumeSamlSignatureProof({ ...proof })).toThrow(
    "verification failed",
  );
  // SAFETY: This negative fixture bypasses the type brand; the runtime WeakMap must refuse it.
  const forged = JSON.parse("{}") as SamlSignatureProof;
  expect(() => consumeSamlSignatureProof(forged)).toThrow(
    "verification failed",
  );
  consumeSamlSignatureProof(proof);
  expect(() => consumeSamlSignatureProof(proof)).toThrow("verification failed");
});

it("retires a verified proof when its originating owner changes before protocol consumption", async () => {
  let live = true;
  const binding = {
    ...owner(),
    assertCurrent() {
      if (!live) throw new Error("owner changed");
    },
  };
  const proof = await verifySamlXmlSignature(
    vectors.root,
    [bytes(vectors.publicSpki)],
    binding,
  );
  live = false;
  expect(() => consumeSamlSignatureProof(proof)).toThrow("owner changed");
  live = true;
  expect(() => consumeSamlSignatureProof(proof)).toThrow("verification failed");
});

it("refuses publication when cancelled during genuine WebCrypto verification", async () => {
  const controller = new AbortController();
  let entered = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const actual = crypto.subtle.verify.bind(crypto.subtle);
  const spy = vi
    .spyOn(crypto.subtle, "verify")
    .mockImplementation(async (...args) => {
      const result = await actual(...args);
      entered();
      await held;
      return result;
    });
  try {
    const operation = verifySamlXmlSignature(
      vectors.root,
      [bytes(vectors.publicSpki)],
      { signal: controller.signal, assertCurrent() {} },
    );
    const rejection = expect(operation).rejects.toThrow();
    await reached;
    controller.abort();
    release();
    await rejection;
  } finally {
    release();
    spy.mockRestore();
  }
});

it("rejects missing, excessive and malformed explicit trust anchors", async () => {
  for (const anchors of [
    [],
    Array.from({ length: 5 }, () => bytes(vectors.publicSpki)),
    [new Uint8Array(0)],
    [new Uint8Array(4097)],
    [new Uint8Array([1, 2, 3])],
  ]) {
    await expect(
      verifySamlXmlSignature(vectors.root, anchors, owner()),
    ).rejects.toThrow("verification failed");
  }
});
