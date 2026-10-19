/** @vitest-environment jsdom */
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SignedXml } from "xml-crypto";
import type {
  SamlPendingRequest,
  SamlTimePolicy,
} from "./assertion-conditions.js";
import { validateSamlAssertion } from "./assertion.js";
import { verifySamlXmlSignature } from "./xml-signature.js";

const request: SamlPendingRequest = Object.freeze({
  requestId: "_request",
  issuer: "urn:oracle:idp",
  audience: "urn:oracle:sp",
  acsUrl: "https://vault.example.test/OpenSesame/auth/native-saml",
  issuedAt: Date.parse("2026-10-16T16:00:00.000Z"),
  expiresAt: Date.parse("2026-10-16T16:05:00.000Z"),
  nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  authnContext:
    "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
  forceAuthentication: false,
});
const policy: SamlTimePolicy = Object.freeze({
  clockSkewMs: 5000,
  maxAssertionAgeMs: 300000,
  maxAuthenticationAgeMs: 28800000,
  maxSessionDurationMs: 600000,
});
const now = Date.parse("2026-10-16T16:00:05.000Z");
const base = `<p:Response xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="2026-10-16T16:00:01.000Z" Destination="${request.acsUrl}" InResponseTo="_request"><a:Issuer>urn:oracle:idp</a:Issuer><p:Status><p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></p:Status><a:Assertion ID="_assertion" Version="2.0" IssueInstant="2026-10-16T16:00:01.000Z"><a:Issuer>urn:oracle:idp</a:Issuer><a:Subject><a:NameID Format="${request.nameIdFormat}" NameQualifier="urn:oracle:idp" SPNameQualifier="urn:oracle:sp">synthetic-subject</a:NameID><a:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><a:SubjectConfirmationData Recipient="${request.acsUrl}" InResponseTo="_request" NotOnOrAfter="2026-10-16T16:04:00.000Z"/></a:SubjectConfirmation></a:Subject><a:Conditions NotBefore="2026-10-16T15:59:59.000Z" NotOnOrAfter="2026-10-16T16:04:00.000Z"><a:AudienceRestriction><a:Audience>urn:oracle:sp</a:Audience></a:AudienceRestriction><a:AudienceRestriction><a:Audience>urn:oracle:other-sp</a:Audience><a:Audience>urn:oracle:sp</a:Audience></a:AudienceRestriction></a:Conditions><a:AuthnStatement AuthnInstant="2026-10-16T15:59:00.000Z" SessionIndex="oracle-session" SessionNotOnOrAfter="2026-10-16T17:00:00.000Z"><a:AuthnContext><a:AuthnContextClassRef>${request.authnContext}</a:AuthnContextClassRef></a:AuthnContext></a:AuthnStatement></a:Assertion></p:Response>`;
let privateKey = "";
let publicKey = new Uint8Array();
beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  publicKey = new Uint8Array(
    keys.publicKey.export({ type: "spki", format: "der" }),
  );
});
afterAll(() => {
  privateKey = "";
  vi.unstubAllGlobals();
});

// Independent XMLcrypto signs real XML; xmldsigjs verifies it. Keys stay in memory.
function sign(xml: string, target: string): string {
  const signer = new SignedXml({
    privateKey,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signer.addReference({
    xpath: `//*[@ID='${target}']`,
    uri: `#${target}`,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(xml, {
    prefix: "ds",
    location: {
      reference: `//*[@ID='${target}']/*[local-name()='Issuer']`,
      action: "after",
    },
  });
  return signer.getSignedXml();
}
async function signature(
  xml: string,
  coverage: "response" | "assertion" | "both" = "both",
) {
  let signed = coverage === "response" ? xml : sign(xml, "_assertion");
  if (coverage !== "assertion") signed = sign(signed, "_response");
  return verifySamlXmlSignature(signed, [publicKey], {
    signal: new AbortController().signal,
    assertCurrent() {},
  });
}
async function validate(
  xml = base,
  binding = request,
  timing = policy,
  clock = now,
) {
  return validateSamlAssertion(await signature(xml), binding, timing, clock);
}

it.each(["response", "assertion", "both"] as const)(
  "validates %s coverage and returns immutable protocol-specific scalar claims",
  async (coverage) => {
    const claims = validateSamlAssertion(
      await signature(base, coverage),
      request,
      policy,
      now,
    );
    expect(claims).toEqual({
      protocol: "saml",
      issuer: request.issuer,
      audience: request.audience,
      requestId: request.requestId,
      assertionId: "_assertion",
      responseId: "_response",
      subject: "synthetic-subject",
      nameIdFormat: request.nameIdFormat,
      nameQualifier: request.issuer,
      spNameQualifier: request.audience,
      authnContext: request.authnContext,
      sessionIndex: "oracle-session",
      authenticatedAt: Date.parse("2026-10-16T15:59:00.000Z"),
      acceptedAt: now,
      validUntil: Date.parse("2026-10-16T16:04:05.000Z"),
      oneTimeUse: false,
    });
    expect(Object.isFrozen(claims)).toBe(true);
  },
);

const negatives = [
  [
    "response issuer",
    base.replace("<a:Issuer>urn:oracle:idp", "<a:Issuer>urn:attacker"),
  ],
  [
    "assertion issuer",
    base.replace(
      '<a:Assertion ID="_assertion" Version="2.0" IssueInstant="2026-10-16T16:00:01.000Z"><a:Issuer>urn:oracle:idp',
      '<a:Assertion ID="_assertion" Version="2.0" IssueInstant="2026-10-16T16:00:01.000Z"><a:Issuer>urn:attacker',
    ),
  ],
  [
    "destination",
    base.replace(
      'Destination="https://vault.example.test/OpenSesame/auth/native-saml"',
      'Destination="https://attacker.invalid/acs"',
    ),
  ],
  [
    "response request",
    base.replace('InResponseTo="_request"', 'InResponseTo="_other"'),
  ],
  ["unsolicited response", base.replace(' InResponseTo="_request"', "")],
  [
    "bearer recipient",
    base.replace(
      'Recipient="https://vault.example.test/OpenSesame/auth/native-saml"',
      'Recipient="https://attacker.invalid/acs"',
    ),
  ],
  [
    "bearer request",
    base.replace(
      'Recipient="https://vault.example.test/OpenSesame/auth/native-saml" InResponseTo="_request"',
      'Recipient="https://vault.example.test/OpenSesame/auth/native-saml" InResponseTo="_other"',
    ),
  ],
  ["bearer method", base.replace(":cm:bearer", ":cm:holder-of-key")],
  [
    "bearer expiry",
    base.replace(
      'InResponseTo="_request" NotOnOrAfter="2026-10-16T16:04:00.000Z"',
      'InResponseTo="_request" NotOnOrAfter="2026-10-16T15:59:00.000Z"',
    ),
  ],
  [
    "forbidden bearer NotBefore",
    base.replace(
      "<a:SubjectConfirmationData Recipient=",
      '<a:SubjectConfirmationData NotBefore="2026-10-16T16:00:00.000Z" Recipient=',
    ),
  ],
  [
    "NameID format",
    base.replace(":nameid-format:persistent", ":nameid-format:transient"),
  ],
  [
    "NameID issuer qualifier",
    base.replace(
      'NameQualifier="urn:oracle:idp"',
      'NameQualifier="urn:attacker"',
    ),
  ],
  [
    "NameID SP qualifier",
    base.replace(
      'SPNameQualifier="urn:oracle:sp"',
      'SPNameQualifier="urn:attacker"',
    ),
  ],
  ["empty subject", base.replace("synthetic-subject", " ")],
  [
    "duplicate Subject",
    base.replace("</a:Subject>", "</a:Subject><a:Subject/>"),
  ],
  [
    "conditions expired",
    base.replace(
      '<a:Conditions NotBefore="2026-10-16T15:59:59.000Z" NotOnOrAfter="2026-10-16T16:04:00.000Z"',
      '<a:Conditions NotBefore="2026-10-16T15:50:00.000Z" NotOnOrAfter="2026-10-16T15:59:00.000Z"',
    ),
  ],
  [
    "conditions not yet valid",
    base.replace(
      'NotBefore="2026-10-16T15:59:59.000Z"',
      'NotBefore="2026-10-16T16:01:00.000Z"',
    ),
  ],
  [
    "audience AND",
    base.replace(
      "<a:Audience>urn:oracle:other-sp</a:Audience><a:Audience>urn:oracle:sp</a:Audience>",
      "<a:Audience>urn:oracle:other-sp</a:Audience>",
    ),
  ],
  [
    "missing audience restriction",
    base.replace(
      /<a:AudienceRestriction>[\s\S]*?<\/a:AudienceRestriction>/g,
      "",
    ),
  ],
  [
    "unknown restrictive condition",
    base.replace(
      "</a:Conditions>",
      '<a:ProxyRestriction Count="0"/></a:Conditions>',
    ),
  ],
  [
    "invalid calendar instant",
    base.replace("2026-10-16T15:59:59.000Z", "2026-02-30T15:59:59.000Z"),
  ],
  [
    "missing timezone",
    base.replace("2026-10-16T15:59:59.000Z", "2026-10-16T15:59:59.000"),
  ],
  [
    "future issue instant",
    base.replaceAll("2026-10-16T16:00:01.000Z", "2026-10-16T16:01:00.000Z"),
  ],
  [
    "issue predates original request",
    base.replaceAll("2026-10-16T16:00:01.000Z", "2026-10-16T15:59:00.000Z"),
  ],
  [
    "stale authentication",
    base.replace("2026-10-16T15:59:00.000Z", "2026-10-15T15:59:00.000Z"),
  ],
  [
    "future authentication",
    base.replace("2026-10-16T15:59:00.000Z", "2026-10-16T16:01:00.000Z"),
  ],
  [
    "expired session",
    base.replace("2026-10-16T17:00:00.000Z", "2026-10-16T15:59:30.000Z"),
  ],
  [
    "wrong assurance",
    base.replace(":classes:PasswordProtectedTransport", ":classes:Password"),
  ],
  ["non-success status", base.replace(":status:Success", ":status:Responder")],
  [
    "duplicate AuthnStatement",
    base.replace("</a:Assertion>", "<a:AuthnStatement/></a:Assertion>"),
  ],
] as const;
it.each(negatives)("rejects genuinely signed %s", async (_name, xml) => {
  expect(xml).not.toBe(base);
  await expect(validate(xml)).rejects.toThrow("does not match");
});

it.each([
  ["request ID", { requestId: "_different" }],
  ["configured issuer", { issuer: "urn:different" }],
  ["configured audience", { audience: "urn:different" }],
  ["configured ACS", { acsUrl: "https://other.example.test/acs" }],
  ["expired pending request", { expiresAt: now }],
  ["excessive request lifetime", { expiresAt: request.issuedAt + 300001 }],
  ["nonfinite request", { issuedAt: Number.NaN }],
  ["fresh authentication requirement", { forceAuthentication: true }],
] as const)("refuses changed original %s binding", async (_name, changes) => {
  await expect(validate(base, { ...request, ...changes })).rejects.toThrow(
    "does not match",
  );
});

it("does not use unsigned response values to override signed bearer request or recipient", async () => {
  const signedAssertion = sign(base, "_assertion");
  const tamperedOuter = signedAssertion.replace(
    'Destination="https://vault.example.test/OpenSesame/auth/native-saml"',
    'Destination="https://attacker.invalid/acs"',
  );
  const proof = await verifySamlXmlSignature(tamperedOuter, [publicKey], {
    signal: new AbortController().signal,
    assertCurrent() {},
  });
  expect(() => validateSamlAssertion(proof, request, policy, now)).toThrow(
    "does not match",
  );
});
it("carries signed OneTimeUse and preserves NameID spelling for later replay/account policy", async () => {
  const claims = await validate(
    base
      .replace("</a:Conditions>", "<a:OneTimeUse/></a:Conditions>")
      .replace("synthetic-subject", " synthetic-subject "),
  );
  expect(claims.oneTimeUse).toBe(true);
  expect(claims.subject).toBe(" synthetic-subject ");
});
it("accepts XML-schema whitespace around URI values without normalizing NameID", async () => {
  const claims = await validate(
    base
      .replaceAll(">urn:oracle:idp<", ">\nurn:oracle:idp\n<")
      .replaceAll(">urn:oracle:sp<", ">\nurn:oracle:sp\n<"),
  );
  expect(claims.issuer).toBe(request.issuer);
});
it("intersects signed condition, bearer and session lifetimes with explicit local policy", async () => {
  const claims = await validate(base, request, {
    ...policy,
    maxSessionDurationMs: 1000,
  });
  expect(claims.validUntil).toBe(now + 1000);
});
it("honors an earlier signed session deadline and nanosecond-formatted provider instants", async () => {
  const xml = base
    .replace("2026-10-16T17:00:00.000Z", "2026-10-16T16:00:35.1234567Z")
    .replaceAll(".000Z", ".0000000Z");
  expect((await validate(xml)).validUntil).toBe(
    Date.parse("2026-10-16T16:00:40.123Z"),
  );
});
it("accepts the optional signed Address hint without claiming browser IP attestation", async () => {
  const xml = base.replace(
    "<a:SubjectConfirmationData Recipient=",
    '<a:SubjectConfirmationData Address="192.0.2.1" Recipient=',
  );
  expect((await validate(xml)).subject).toBe("synthetic-subject");
});
it("never rounds a submillisecond NotBefore down into an earlier admission", async () => {
  const xml = base.replace(
    "2026-10-16T15:59:59.000Z",
    "2026-10-16T16:00:05.0000001Z",
  );
  await expect(
    validate(xml, request, { ...policy, clockSkewMs: 0 }),
  ).rejects.toThrow("does not match");
  expect(
    (await validate(xml, request, { ...policy, clockSkewMs: 0 }, now + 1))
      .subject,
  ).toBe("synthetic-subject");
});
it("treats the skew-adjusted NotOnOrAfter boundary as exclusive", async () => {
  const boundary = Date.parse("2026-10-16T16:04:05.000Z");
  expect((await validate(base, request, policy, boundary - 1)).validUntil).toBe(
    boundary,
  );
  await expect(validate(base, request, policy, boundary)).rejects.toThrow(
    "does not match",
  );
});
it("consumes an invalid original request proof once and cannot retry it under a new binding", async () => {
  const proof = await signature(base);
  expect(() =>
    validateSamlAssertion(
      proof,
      { ...request, requestId: "_different" },
      policy,
      now,
    ),
  ).toThrow("does not match");
  expect(() => validateSamlAssertion(proof, request, policy, now)).toThrow(
    "verification failed",
  );
});
it("rejects duplicate signed assertions before any protocol claim selection", async () => {
  await expect(
    validate(
      base.replace(
        "</p:Response>",
        '<a:Assertion ID="_other" Version="2.0"/></p:Response>',
      ),
    ),
  ).rejects.toThrow("Invalid SAML signed document");
});
