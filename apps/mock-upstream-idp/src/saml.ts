import { randomBytes } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import type { MockIdpSamlKeys } from "./config.js";
import { escapeHtml } from "./http.js";

/**
 * A real SAML 2.0 identity provider.
 *
 * Assertions are signed with real XML-DSig through `xml-crypto` — the same
 * library the SP side (`@node-saml/node-saml`) verifies with — over a runtime
 * generated RSA keypair wrapped in a real self-signed X.509 certificate.
 *
 * The malformation knobs are the point of a *reference* IdP: an SP is only
 * proven safe by the responses it refuses, and hand-assembling those in each
 * test would produce six subtly different fakes instead of one real IdP that
 * can be told to misbehave.
 */

export const SAML_METADATA_PATH = "/saml/metadata";
export const SAML_SSO_PATH = "/saml/sso";

const NS_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const NS_ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";
const NS_METADATA = "urn:oasis:names:tc:SAML:2.0:metadata";
const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";

const BINDING_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const BINDING_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

export const NAMEID_FORMAT_PERSISTENT =
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
export const NAMEID_FORMAT_EMAIL =
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

/** Standard attribute names real IdPs emit, so SP attribute mapping is real. */
const ATTR_EMAIL = "urn:oid:0.9.2342.19200300.100.1.3";
const ATTR_NAME = "urn:oid:2.5.4.3";

/**
 * The negative cases every SAML SP has to refuse.
 *
 * - `unsigned` — no XML-DSig at all.
 * - `wrong-element` — a cryptographically valid signature that covers
 *   `<samlp:Status>` instead of the assertion it is parked inside.
 * - `wrapped` — signature wrapping: the honestly signed assertion is moved
 *   into an attacker-authored assertion's `<saml:Advice>`, so a validator that
 *   asks only "is there a valid signature in this document?" reads the
 *   attacker's `NameID`.
 * - `wrong-audience` — `<saml:Audience>` names somebody else's SP.
 * - `expired` / `future` — `<saml:Conditions>` outside its validity window.
 */
export type SamlMutation =
  | "unsigned"
  | "wrong-element"
  | "wrapped"
  | "wrong-audience"
  | "expired"
  | "future";

export interface SamlAssertionInput {
  /** Where the response is destined — also the `Recipient`. */
  acsUrl: string;
  /** The SP entityID the assertion is restricted to. */
  audience: string;
  issuerEntityId: string;
  subject: string;
  nameIdFormat?: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  /** Set for SP-initiated flows; absent for IdP-initiated ones. */
  inResponseTo?: string;
  /** Fixed value so a caller can re-post the same assertion id (replay). */
  assertionId?: string;
  mutate?: SamlMutation;
}

export interface ParsedAuthnRequest {
  id: string;
  acsUrl?: string;
  issuer?: string;
  destination?: string;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function newId(prefix: string): string {
  return `_${prefix}${randomBytes(16).toString("hex")}`;
}

function instant(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface ConditionsWindow {
  notBefore: string;
  notOnOrAfter: string;
}

function conditionsWindow(mutate: SamlMutation | undefined): ConditionsWindow {
  if (mutate === "expired") {
    return { notBefore: instant(-600_000), notOnOrAfter: instant(-300_000) };
  }
  if (mutate === "future") {
    return { notBefore: instant(300_000), notOnOrAfter: instant(900_000) };
  }
  return { notBefore: instant(-60_000), notOnOrAfter: instant(300_000) };
}

/** Whether the IdP would itself have signed the enclosing `<samlp:Response>`. */
function responseIsSigned(mutate: SamlMutation | undefined): boolean {
  return (
    mutate !== "unsigned" && mutate !== "wrong-element" && mutate !== "wrapped"
  );
}

function attributeXml(name: string, friendlyName: string, value: string) {
  return [
    `<saml:Attribute Name="${xmlEscape(name)}" FriendlyName="${xmlEscape(friendlyName)}"`,
    ' NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri">',
    `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema"`,
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    ` xsi:type="xs:string">${xmlEscape(value)}</saml:AttributeValue>`,
    "</saml:Attribute>",
  ].join("");
}

function assertionXml(
  input: SamlAssertionInput,
  assertionId: string,
  subject: string,
): string {
  const window = conditionsWindow(input.mutate);
  const audience =
    input.mutate === "wrong-audience"
      ? "https://audience.invalid/sp"
      : input.audience;
  const attributes: string[] = [];
  if (input.email !== undefined) {
    attributes.push(attributeXml(ATTR_EMAIL, "mail", input.email));
  }
  if (input.emailVerified !== undefined) {
    attributes.push(
      attributeXml(
        "http://schemas.opensesame.dev/claims/emailverified",
        "emailVerified",
        input.emailVerified ? "true" : "false",
      ),
    );
  }
  if (input.name !== undefined) {
    attributes.push(attributeXml(ATTR_NAME, "cn", input.name));
  }
  return [
    `<saml:Assertion xmlns:saml="${NS_ASSERTION}" ID="${assertionId}"`,
    ` Version="2.0" IssueInstant="${instant(0)}">`,
    `<saml:Issuer>${xmlEscape(input.issuerEntityId)}</saml:Issuer>`,
    "<saml:Subject>",
    `<saml:NameID Format="${xmlEscape(input.nameIdFormat ?? NAMEID_FORMAT_PERSISTENT)}">`,
    `${xmlEscape(subject)}</saml:NameID>`,
    '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">',
    `<saml:SubjectConfirmationData NotOnOrAfter="${window.notOnOrAfter}"`,
    ` Recipient="${xmlEscape(input.acsUrl)}"`,
    input.inResponseTo !== undefined
      ? ` InResponseTo="${xmlEscape(input.inResponseTo)}"`
      : "",
    "/>",
    "</saml:SubjectConfirmation>",
    "</saml:Subject>",
    `<saml:Conditions NotBefore="${window.notBefore}" NotOnOrAfter="${window.notOnOrAfter}">`,
    `<saml:AudienceRestriction><saml:Audience>${xmlEscape(audience)}</saml:Audience>`,
    "</saml:AudienceRestriction>",
    "</saml:Conditions>",
    `<saml:AuthnStatement AuthnInstant="${instant(0)}" SessionIndex="${newId("sess")}">`,
    "<saml:AuthnContext><saml:AuthnContextClassRef>",
    "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
    "</saml:AuthnContextClassRef></saml:AuthnContext>",
    "</saml:AuthnStatement>",
    attributes.length > 0
      ? `<saml:AttributeStatement>${attributes.join("")}</saml:AttributeStatement>`
      : "",
    "</saml:Assertion>",
  ].join("");
}

function responseXml(
  input: SamlAssertionInput,
  responseId: string,
  statusId: string,
  assertion: string,
): string {
  return [
    `<samlp:Response xmlns:samlp="${NS_PROTOCOL}" xmlns:saml="${NS_ASSERTION}"`,
    ` ID="${responseId}" Version="2.0" IssueInstant="${instant(0)}"`,
    ` Destination="${xmlEscape(input.acsUrl)}"`,
    input.inResponseTo !== undefined
      ? ` InResponseTo="${xmlEscape(input.inResponseTo)}"`
      : "",
    ">",
    `<saml:Issuer>${xmlEscape(input.issuerEntityId)}</saml:Issuer>`,
    `<samlp:Status ID="${statusId}">`,
    '<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>',
    "</samlp:Status>",
    assertion,
    "</samlp:Response>",
  ].join("");
}

interface SignPlacement {
  /** XPath of the element whose digest the reference covers. */
  referenceXpath: string;
  referenceUri: string;
  /** XPath of the element the `<ds:Signature>` is inserted after. */
  afterXpath: string;
}

function signElement(
  xml: string,
  keys: MockIdpSamlKeys,
  placement: SignPlacement,
): string {
  const signer = new SignedXml({
    privateKey: keys.privateKeyPem,
    publicCert: keys.certificatePem,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signer.addReference({
    xpath: placement.referenceXpath,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    uri: placement.referenceUri,
  });
  signer.computeSignature(xml, {
    prefix: "ds",
    location: { reference: placement.afterXpath, action: "after" },
  });
  return signer.getSignedXml();
}

/** Move the honestly signed assertion under an attacker-authored one. */
function wrapSignedAssertion(signedResponse: string): string {
  const start = signedResponse.indexOf("<saml:Assertion");
  const endMarker = "</saml:Assertion>";
  const end = signedResponse.lastIndexOf(endMarker);
  if (start < 0 || end < 0) return signedResponse;
  const signedAssertion = signedResponse.slice(start, end + endMarker.length);
  const evilId = newId("evil");
  const issuerEnd = signedAssertion.indexOf("</saml:Issuer>");
  const issuerBlock = signedAssertion.slice(
    signedAssertion.indexOf("<saml:Issuer>"),
    issuerEnd + "</saml:Issuer>".length,
  );
  const bodyStart = issuerEnd + "</saml:Issuer>".length;
  const evilBody = signedAssertion
    .slice(bodyStart, signedAssertion.length - endMarker.length)
    .replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, "")
    .replace(
      /(<saml:NameID[^>]*>)[^<]*(<\/saml:NameID>)/,
      "$1attacker@evil.example$2",
    );
  const evilAssertion = [
    `<saml:Assertion xmlns:saml="${NS_ASSERTION}" ID="${evilId}"`,
    ` Version="2.0" IssueInstant="${instant(0)}">`,
    issuerBlock,
    `<saml:Advice>${signedAssertion}</saml:Advice>`,
    evilBody,
    endMarker,
  ].join("");
  return (
    signedResponse.slice(0, start) +
    evilAssertion +
    signedResponse.slice(end + endMarker.length)
  );
}

/** Build a complete `<samlp:Response>`, applying the requested malformation. */
export function buildSamlResponseXml(
  keys: MockIdpSamlKeys,
  input: SamlAssertionInput,
): string {
  const assertionId = input.assertionId ?? newId("assert");
  const responseId = newId("resp");
  const statusId = newId("status");
  const assertion = assertionXml(input, assertionId, input.subject);
  const unsigned = responseXml(input, responseId, statusId, assertion);

  if (input.mutate === "unsigned") return unsigned;

  if (input.mutate === "wrong-element") {
    // A real signature — over `<samlp:Status>` — parked inside the assertion
    // where an assertion signature belongs.
    return signElement(unsigned, keys, {
      referenceXpath: "//*[local-name()='Status']",
      referenceUri: `#${statusId}`,
      afterXpath: "//*[local-name()='Assertion']/*[local-name()='Issuer']",
    });
  }

  const signedAssertion = signElement(unsigned, keys, {
    referenceXpath: "//*[local-name()='Assertion']",
    referenceUri: `#${assertionId}`,
    afterXpath: "//*[local-name()='Assertion']/*[local-name()='Issuer']",
  });

  if (input.mutate === "wrapped") {
    // The attacker cannot re-sign, so the response signature is not reapplied.
    return wrapSignedAssertion(signedAssertion);
  }

  if (!responseIsSigned(input.mutate)) return signedAssertion;

  return signElement(signedAssertion, keys, {
    referenceXpath: "/*[local-name()='Response']",
    referenceUri: `#${responseId}`,
    afterXpath: "/*[local-name()='Response']/*[local-name()='Issuer']",
  });
}

export function encodeSamlMessage(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}

/** Decode a `SAMLRequest` from either binding (deflated or plain base64). */
export function decodeSamlMessage(encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  try {
    return inflateRawSync(raw).toString("utf8");
  } catch {
    try {
      return inflateSync(raw).toString("utf8");
    } catch {
      return raw.toString("utf8");
    }
  }
}

export function parseAuthnRequest(
  encoded: string,
): ParsedAuthnRequest | undefined {
  const xml = decodeSamlMessage(encoded);
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "AuthnRequest") return undefined;
  const id = root.getAttribute("ID") ?? "";
  if (id.length === 0) return undefined;
  const acs = root.getAttribute("AssertionConsumerServiceURL") ?? "";
  const destination = root.getAttribute("Destination") ?? "";
  const issuerNodes = root.getElementsByTagNameNS(NS_ASSERTION, "Issuer");
  const issuerNode = issuerNodes.length > 0 ? issuerNodes[0] : undefined;
  const issuer = issuerNode?.textContent ?? "";
  return {
    id,
    ...(acs.length > 0 ? { acsUrl: acs } : undefined),
    ...(issuer.length > 0 ? { issuer } : undefined),
    ...(destination.length > 0 ? { destination } : undefined),
  };
}

export function buildIdpMetadataXml(
  entityId: string,
  ssoUrl: string,
  certificateBase64: string,
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<md:EntityDescriptor xmlns:md="${NS_METADATA}" entityID="${xmlEscape(entityId)}">`,
    '<md:IDPSSODescriptor WantAuthnRequestsSigned="false"',
    ` protocolSupportEnumeration="${NS_PROTOCOL}">`,
    '<md:KeyDescriptor use="signing">',
    `<ds:KeyInfo xmlns:ds="${NS_DSIG}"><ds:X509Data>`,
    `<ds:X509Certificate>${certificateBase64}</ds:X509Certificate>`,
    "</ds:X509Data></ds:KeyInfo></md:KeyDescriptor>",
    `<md:NameIDFormat>${NAMEID_FORMAT_PERSISTENT}</md:NameIDFormat>`,
    `<md:NameIDFormat>${NAMEID_FORMAT_EMAIL}</md:NameIDFormat>`,
    `<md:SingleSignOnService Binding="${BINDING_REDIRECT}" Location="${xmlEscape(ssoUrl)}"/>`,
    `<md:SingleSignOnService Binding="${BINDING_POST}" Location="${xmlEscape(ssoUrl)}"/>`,
    "</md:IDPSSODescriptor>",
    "</md:EntityDescriptor>",
  ].join("");
}

/** The HTML-POST-binding document an IdP answers an AuthnRequest with. */
export function samlPostBindingHtml(
  acsUrl: string,
  samlResponse: string,
  relayState: string | undefined,
): string {
  const relayInput =
    relayState === undefined
      ? ""
      : `<input type="hidden" name="RelayState" value="${escapeHtml(relayState)}"/>`;
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"/>',
    "<title>Reference IdP — SAML POST binding</title></head>",
    '<body onload="document.forms[0].submit()">',
    `<form method="post" action="${escapeHtml(acsUrl)}">`,
    `<input type="hidden" name="SAMLResponse" value="${escapeHtml(samlResponse)}"/>`,
    relayInput,
    '<noscript><button type="submit">Continue</button></noscript>',
    "</form>",
    "<script>document.forms[0].submit();</script>",
    "</body></html>",
  ].join("");
}
