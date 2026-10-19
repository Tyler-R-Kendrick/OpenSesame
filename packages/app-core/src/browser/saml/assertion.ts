/** Native SAML protocol validation; no JWT, broker or account admission is fabricated. */
import {
  SAML_ASSERTION_NS as A,
  type SamlPendingRequest,
  type SamlTimePolicy,
  assertSamlIssueInstant,
  assertSamlRequest,
  invalidSamlAssertion as invalid,
  samlAttributes,
  samlChild,
  samlConditions,
  samlInstant,
  samlText,
  samlUriText,
} from "./assertion-conditions.js";
import {
  type SamlSignatureProof,
  consumeSamlSignatureProof,
} from "./xml-signature.js";

const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const UNSPECIFIED = "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";
export type SamlProtocolClaims = Readonly<{
  protocol: "saml";
  issuer: string;
  audience: string;
  requestId: string;
  responseId: string;
  assertionId: string;
  subject: string;
  nameIdFormat: string;
  nameQualifier: string;
  spNameQualifier: string;
  authnContext: string;
  sessionIndex: string;
  authenticatedAt: number;
  acceptedAt: number;
  validUntil: number;
  oneTimeUse: boolean;
}>;

function sequence(element: Element, expected: readonly string[]): void {
  const actual = [...element.children].map(
    (child) => `${child.namespaceURI}:${child.localName}`,
  );
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  )
    invalid();
}

function issuer(element: Element, expected: string): void {
  const value = samlChild(element, A, "Issuer");
  samlAttributes(value, ["Format"]);
  const format = value.getAttribute("Format");
  if (format && format !== "urn:oasis:names:tc:SAML:2.0:nameid-format:entity")
    invalid();
  if (samlUriText(value) !== expected) invalid();
}

function responseStatus(response: Element): void {
  const status = samlChild(response, P, "Status");
  samlAttributes(status, []);
  const code = samlChild(status, P, "StatusCode");
  samlAttributes(code, ["Value"]);
  if (
    code.getAttribute("Value") !==
      "urn:oasis:names:tc:SAML:2.0:status:Success" ||
    code.children.length
  )
    invalid();
  for (const child of status.children) {
    if (child === code) continue;
    if (child.namespaceURI !== P || child.localName !== "StatusMessage")
      invalid();
    samlText(child);
  }
}

function subject(
  assertion: Element,
  request: SamlPendingRequest,
  policy: SamlTimePolicy,
  now: number,
) {
  const element = samlChild(assertion, A, "Subject");
  samlAttributes(element, []);
  sequence(element, [`${A}:NameID`, `${A}:SubjectConfirmation`]);
  const name = samlChild(element, A, "NameID");
  samlAttributes(name, ["Format", "NameQualifier", "SPNameQualifier"]);
  const format = name.getAttribute("Format") || UNSPECIFIED;
  const qualifier = name.getAttribute("NameQualifier") ?? "";
  const spQualifier = name.getAttribute("SPNameQualifier") ?? "";
  if (
    format !== request.nameIdFormat ||
    (qualifier && qualifier !== request.issuer) ||
    (spQualifier && spQualifier !== request.audience)
  )
    invalid();
  const confirmation = samlChild(element, A, "SubjectConfirmation");
  samlAttributes(confirmation, ["Method"]);
  if (confirmation.getAttribute("Method") !== BEARER) invalid();
  sequence(confirmation, [`${A}:SubjectConfirmationData`]);
  const data = samlChild(confirmation, A, "SubjectConfirmationData");
  // Browser SSO profile4.1.4.3 makes checking the optional Address hint a MAY.
  // This adapter authenticates signed bearer/request facts, not the client's IP.
  samlAttributes(data, [
    "Recipient",
    "InResponseTo",
    "NotOnOrAfter",
    "Address",
  ]);
  if (
    data.children.length ||
    data.getAttribute("Recipient") !== request.acsUrl ||
    data.getAttribute("InResponseTo") !== request.requestId
  )
    invalid();
  const validUntil =
    samlInstant(data.getAttribute("NotOnOrAfter")) + policy.clockSkewMs;
  if (validUntil <= now) invalid();
  return {
    subject: samlText(name),
    format,
    qualifier,
    spQualifier,
    validUntil,
  };
}

function authenticationContext(
  statement: Element,
  request: SamlPendingRequest,
): string {
  const context = samlChild(statement, A, "AuthnContext");
  samlAttributes(context, []);
  const authorities = [...context.children].filter(
    (child) =>
      child.namespaceURI === A && child.localName === "AuthenticatingAuthority",
  );
  if (authorities.length > 16) invalid();
  sequence(context, [
    `${A}:AuthnContextClassRef`,
    ...authorities.map(() => `${A}:AuthenticatingAuthority`),
  ]);
  for (const authority of authorities) {
    samlAttributes(authority, []);
    samlUriText(authority);
  }
  const reference = samlChild(context, A, "AuthnContextClassRef");
  samlAttributes(reference, []);
  const authnContext = samlUriText(reference);
  if (request.authnContext && authnContext !== request.authnContext) invalid();
  return authnContext;
}

function authentication(
  assertion: Element,
  request: SamlPendingRequest,
  policy: SamlTimePolicy,
  now: number,
  issuedAt: number,
) {
  const statement = samlChild(assertion, A, "AuthnStatement");
  samlAttributes(statement, [
    "AuthnInstant",
    "SessionIndex",
    "SessionNotOnOrAfter",
  ]);
  const locality = [...statement.children].filter(
    (child) =>
      child.namespaceURI === A && child.localName === "SubjectLocality",
  );
  if (locality.length > 1) invalid();
  sequence(statement, [
    ...locality.map(() => `${A}:SubjectLocality`),
    `${A}:AuthnContext`,
  ]);
  if (locality[0]) {
    samlAttributes(locality[0], ["Address", "DNSName"]);
    if (locality[0].children.length) invalid();
  }
  const authenticatedAt = samlInstant(statement.getAttribute("AuthnInstant"));
  const latestAuthentication = samlInstant(
    statement.getAttribute("AuthnInstant"),
    "ceil",
  );
  if (
    latestAuthentication > now + policy.clockSkewMs ||
    latestAuthentication > issuedAt + policy.clockSkewMs ||
    authenticatedAt < now - policy.maxAuthenticationAgeMs - policy.clockSkewMs
  )
    invalid();
  if (
    request.forceAuthentication &&
    authenticatedAt < request.issuedAt - policy.clockSkewMs
  )
    invalid();
  const authnContext = authenticationContext(statement, request);
  const sessionIndex = statement.getAttribute("SessionIndex") ?? "";
  if (sessionIndex.length > 2048) invalid();
  const expiry = statement.getAttribute("SessionNotOnOrAfter");
  const sessionExpiry = expiry ? samlInstant(expiry) : Number.POSITIVE_INFINITY;
  if (
    sessionExpiry <= authenticatedAt ||
    sessionExpiry + policy.clockSkewMs <= now
  )
    invalid();
  return {
    authenticatedAt,
    authnContext,
    sessionIndex,
    validUntil: sessionExpiry + policy.clockSkewMs,
  };
}

function validateResponse(
  response: Element,
  request: SamlPendingRequest,
  policy: SamlTimePolicy,
  now: number,
  responseSigned: boolean,
): number {
  samlAttributes(response, [
    "ID",
    "Version",
    "IssueInstant",
    "Destination",
    "InResponseTo",
    "Consent",
  ]);
  sequence(response, [
    `${A}:Issuer`,
    ...(responseSigned ? [`${DS}:Signature`] : []),
    `${P}:Status`,
    `${A}:Assertion`,
  ]);
  if (
    response.getAttribute("Destination") !== request.acsUrl ||
    response.getAttribute("InResponseTo") !== request.requestId
  )
    invalid();
  issuer(response, request.issuer);
  responseStatus(response);
  return assertSamlIssueInstant(response, request, policy, now);
}

/** Synchronous after one-use signature proof consumption; callers own pending/replay admission. */
export function validateSamlAssertion(
  proof: SamlSignatureProof,
  request: SamlPendingRequest,
  policy: SamlTimePolicy,
  now = Date.now(),
): SamlProtocolClaims {
  const covered = consumeSamlSignatureProof(proof);
  assertSamlRequest(request, policy, now);
  const { response, assertion, responseSigned, assertionSigned } = covered;
  const responseIssuedAt = validateResponse(
    response,
    request,
    policy,
    now,
    responseSigned,
  );
  samlAttributes(assertion, ["ID", "Version", "IssueInstant"]);
  const attributes = [...assertion.children].filter(
    (child) =>
      child.namespaceURI === A && child.localName === "AttributeStatement",
  );
  if (attributes.length > 8) invalid();
  sequence(assertion, [
    `${A}:Issuer`,
    ...(assertionSigned ? [`${DS}:Signature`] : []),
    `${A}:Subject`,
    `${A}:Conditions`,
    `${A}:AuthnStatement`,
    ...attributes.map(() => `${A}:AttributeStatement`),
  ]);
  issuer(assertion, request.issuer);
  const assertionIssuedAt = assertSamlIssueInstant(
    assertion,
    request,
    policy,
    now,
  );
  if (
    samlInstant(assertion.getAttribute("IssueInstant"), "ceil") >
    responseIssuedAt + policy.clockSkewMs
  )
    invalid();
  const identity = subject(assertion, request, policy, now);
  const conditions = samlConditions(
    samlChild(assertion, A, "Conditions"),
    request,
    policy,
    now,
  );
  const authn = authentication(
    assertion,
    request,
    policy,
    now,
    assertionIssuedAt,
  );
  const validUntil = Math.min(
    identity.validUntil,
    conditions.validUntil,
    authn.validUntil,
    now + policy.maxSessionDurationMs,
  );
  if (validUntil <= now) invalid();
  return Object.freeze({
    protocol: "saml",
    issuer: request.issuer,
    audience: request.audience,
    requestId: request.requestId,
    responseId: response.getAttribute("ID") ?? "",
    assertionId: assertion.getAttribute("ID") ?? "",
    subject: identity.subject,
    nameIdFormat: identity.format,
    nameQualifier: identity.qualifier,
    spNameQualifier: identity.spQualifier,
    authnContext: authn.authnContext,
    sessionIndex: authn.sessionIndex,
    authenticatedAt: authn.authenticatedAt,
    acceptedAt: now,
    validUntil,
    oneTimeUse: conditions.oneTimeUse,
  });
}
