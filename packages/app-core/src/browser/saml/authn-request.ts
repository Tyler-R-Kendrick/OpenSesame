/** Native SAML HTTP-POST AuthnRequest built as DOM data, with optional actual XMLDSIG signing. */
import {
  type SamlPendingRequest,
  type SamlPostOwner,
  assertSamlPostOwner,
  assertSamlRequest,
} from "./assertion-conditions.js";
import {
  type SamlRequestSigning,
  signSamlAuthnRequest,
} from "./authn-signature.js";
import type { SamlIdpMetadata } from "./metadata.js";

const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const A = "urn:oasis:names:tc:SAML:2.0:assertion";
const POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const POLICY = Object.freeze({
  clockSkewMs: 0,
  maxAssertionAgeMs: 300000,
  maxAuthenticationAgeMs: 86400000,
  maxSessionDurationMs: 86400000,
});
export type SamlAuthnPost = Readonly<{ destination: string; request: string }>;
function invalid(): never {
  throw new Error("SAML request does not match the configured provider");
}
function boundedText(value: string): void {
  if (value.length > 2048 || value.trim() !== value) invalid();
  for (const character of value)
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      invalid();
}
function assertMetadata(
  request: SamlPendingRequest,
  metadata: SamlIdpMetadata,
  now: number,
): void {
  assertSamlRequest(request, POLICY, now);
  if (
    request.issuer !== metadata.entityId ||
    (metadata.expiresAt !== null && metadata.expiresAt <= now)
  )
    invalid();
  for (const value of [
    request.issuer,
    request.audience,
    request.nameIdFormat,
    request.authnContext,
  ])
    boundedText(value);
  if (
    metadata.nameIdFormats.length &&
    !metadata.nameIdFormats.includes(request.nameIdFormat)
  )
    invalid();
  const endpoint = new URL(metadata.postUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    endpoint.hostname,
  );
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && loopback))
  )
    invalid();
}
function child(
  document: Document,
  namespace: string,
  name: string,
  value?: string,
): Element {
  const element = document.createElementNS(namespace, name);
  if (value !== undefined) element.textContent = value;
  document.documentElement.append(element);
  return element;
}
function requestDocument(
  request: SamlPendingRequest,
  destination: string,
): Document {
  const document = window.document.implementation.createDocument(
    P,
    "samlp:AuthnRequest",
  );
  const root = document.documentElement;
  for (const [name, value] of Object.entries({
    ID: request.requestId,
    Version: "2.0",
    IssueInstant: new Date(request.issuedAt).toISOString(),
    Destination: destination,
    AssertionConsumerServiceURL: request.acsUrl,
    ProtocolBinding: POST,
    ForceAuthn: String(request.forceAuthentication),
  }))
    root.setAttribute(name, value);
  child(document, A, "saml:Issuer", request.audience);
  const name = child(document, P, "samlp:NameIDPolicy");
  name.setAttribute("Format", request.nameIdFormat);
  name.setAttribute("AllowCreate", "true");
  if (request.authnContext) {
    const context = child(document, P, "samlp:RequestedAuthnContext");
    context.setAttribute("Comparison", "exact");
    const reference = document.createElementNS(A, "saml:AuthnContextClassRef");
    reference.textContent = request.authnContext;
    context.append(reference);
  }
  return document;
}
export async function createSamlAuthnPost(
  request: SamlPendingRequest,
  metadata: SamlIdpMetadata,
  owner: SamlPostOwner,
  signing?: SamlRequestSigning,
): Promise<SamlAuthnPost> {
  assertSamlPostOwner(owner);
  const capturedRequest = Object.freeze({ ...request });
  const capturedMetadata = Object.freeze({
    ...metadata,
    nameIdFormats: Object.freeze([...metadata.nameIdFormats]),
  });
  const capturedSigning = signing ? Object.freeze({ ...signing }) : undefined;
  assertMetadata(capturedRequest, capturedMetadata, Date.now());
  if (capturedMetadata.signedRequests && !capturedSigning) invalid();
  const document = requestDocument(capturedRequest, capturedMetadata.postUrl);
  if (capturedSigning)
    await signSamlAuthnRequest(
      document,
      capturedRequest.requestId,
      capturedSigning,
      owner,
    );
  assertSamlPostOwner(owner);
  assertMetadata(capturedRequest, capturedMetadata, Date.now());
  const xml = new XMLSerializer().serializeToString(document);
  const bytes = new TextEncoder().encode(xml);
  if (bytes.length > 65536) invalid();
  return Object.freeze({
    destination: capturedMetadata.postUrl,
    request: btoa(String.fromCharCode(...bytes)),
  });
}
