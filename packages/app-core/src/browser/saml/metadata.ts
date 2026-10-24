import {
  type SamlPostOwner,
  assertSamlPostOwner,
  samlInstant,
} from "./assertion-conditions.js";
/** Native IdP metadata is operator-selected trust; response KeyInfo never changes these anchors. */

const MD = "urn:oasis:names:tc:SAML:2.0:metadata";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const XML = "http://www.w3.org/XML/1998/namespace";
export type SamlIdpMetadata = Readonly<{
  entityId: string;
  postUrl: string;
  signingSpki: readonly string[];
  nameIdFormats: readonly string[];
  signedRequests: boolean;
  expiresAt: number | null;
}>;
export function invalidSamlMetadata(): never {
  throw new Error(
    "SAML metadata does not describe one valid configured identity provider",
  );
}
function text(value: string | null): string {
  const result = (value ?? "").replace(/[ \t\r\n]+/g, " ").trim();
  if (!result || result.length > 2048) invalidSamlMetadata();
  for (const character of result)
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      invalidSamlMetadata();
  return result;
}
function elements(
  element: Element,
  namespace: string,
  localName: string,
): Element[] {
  return [...element.children].filter(
    (child) =>
      child.namespaceURI === namespace && child.localName === localName,
  );
}
function one(element: Element, namespace: string, localName: string): Element {
  const matches = elements(element, namespace, localName);
  if (matches.length !== 1) invalidSamlMetadata();
  return matches[0];
}
function inspectElement(element: Element, ids: Set<string>): void {
  if (element.attributes.length > 32) invalidSamlMetadata();
  let identifiers = 0;
  for (const attribute of element.attributes) {
    if (attribute.value.length > 16384) invalidSamlMetadata();
    if (
      (!attribute.namespaceURI &&
        ["ID", "Id", "id"].includes(attribute.name)) ||
      (attribute.namespaceURI === XML && attribute.localName === "id")
    ) {
      if (++identifiers > 1 || !attribute.value || ids.has(attribute.value))
        invalidSamlMetadata();
      ids.add(attribute.value);
    }
  }
}
function inspectNode(node: Node, ids: Set<string>): void {
  if (
    (node.nodeValue?.length ?? 0) > 16384 ||
    node.nodeType === Node.DOCUMENT_TYPE_NODE ||
    node.nodeType === Node.PROCESSING_INSTRUCTION_NODE
  )
    invalidSamlMetadata();
  let depth = 0;
  for (let parent = node.parentNode; parent; parent = parent.parentNode)
    if (++depth > 32) invalidSamlMetadata();
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  // SAFETY: The checked DOM nodeType establishes the Element invariant.
  inspectElement(node as Element, ids);
}
function boundedDocument(xml: string): Document {
  if (
    new TextEncoder().encode(xml).length > 262144 ||
    /<!(?:DOCTYPE|ENTITY)\b/i.test(xml)
  )
    invalidSamlMetadata();
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (
    !document.documentElement ||
    document.getElementsByTagName("parsererror").length
  )
    invalidSamlMetadata();
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
  const ids = new Set<string>();
  let count = 0;
  for (
    let node: Node | null = walker.currentNode;
    node;
    node = walker.nextNode()
  ) {
    if (++count > 4096) invalidSamlMetadata();
    inspectNode(node, ids);
  }
  return document;
}
function descriptors(root: Element): Element[] {
  if (root.namespaceURI !== MD) invalidSamlMetadata();
  if (root.localName === "EntityDescriptor") return [root];
  if (root.localName !== "EntitiesDescriptor") invalidSamlMetadata();
  return [...root.children].flatMap((child) =>
    child.namespaceURI === MD &&
    ["EntityDescriptor", "EntitiesDescriptor"].includes(child.localName)
      ? descriptors(child)
      : [],
  );
}
function expiry(element: Element, now: number): number | null {
  let expiresAt: number | null = null;
  for (
    let ancestor: Element | null = element;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const raw = ancestor.getAttribute("validUntil");
    if (!raw) continue;
    const date = samlInstant(raw);
    if (date <= now) invalidSamlMetadata();
    expiresAt = expiresAt === null ? date : Math.min(expiresAt, date);
  }
  return expiresAt;
}
function location(endpoint: Element): string {
  const url = new URL(text(endpoint.getAttribute("Location")));
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    invalidSamlMetadata();
  return url.href;
}
function encodedCertificate(certificate: Element): string {
  if (certificate.children.length) invalidSamlMetadata();
  const value = (certificate.textContent ?? "").replace(/[ \t\r\n]/g, "");
  if (
    !value ||
    value.length > 16384 ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    invalidSamlMetadata();
  return value;
}
function certificates(descriptor: Element): string[] {
  const certificates: string[] = [];
  for (const key of elements(descriptor, MD, "KeyDescriptor")) {
    const use = key.getAttribute("use");
    if (use === "encryption") continue;
    if (use && use !== "signing") invalidSamlMetadata();
    const info = one(key, DS, "KeyInfo");
    for (const data of elements(info, DS, "X509Data"))
      for (const certificate of elements(data, DS, "X509Certificate")) {
        const value = encodedCertificate(certificate);
        if (!certificates.includes(value)) certificates.push(value);
      }
  }
  if (!certificates.length || certificates.length > 4) invalidSamlMetadata();
  return certificates;
}
async function publicKeys(
  values: readonly string[],
  owner: SamlPostOwner,
): Promise<readonly string[]> {
  assertSamlPostOwner(owner);
  const { X509Certificate } = await import("xmldsigjs");
  assertSamlPostOwner(owner);
  const keys: string[] = [];
  for (const value of values) {
    const binary = atob(value);
    if (btoa(binary) !== value) invalidSamlMetadata();
    const certificate = new X509Certificate(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    const key = await certificate.exportKey({
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    });
    assertSamlPostOwner(owner);
    if (key.algorithm.name !== "RSASSA-PKCS1-v1_5") invalidSamlMetadata();
    // SAFETY: The checked algorithm name and WebCrypto key contract establish the RSA algorithm shape.
    const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
    if (
      algorithm.modulusLength < 2048 ||
      algorithm.modulusLength > 8192 ||
      [...algorithm.publicExponent].join(",") !== "1,0,1"
    )
      invalidSamlMetadata();
    const encoded = await crypto.subtle.exportKey("spki", key);
    assertSamlPostOwner(owner);
    if (encoded.byteLength > 4096) invalidSamlMetadata();
    const spki = btoa(String.fromCharCode(...new Uint8Array(encoded)));
    if (!keys.includes(spki)) keys.push(spki);
  }
  return Object.freeze(keys);
}
/** Parse and copy all metadata decisions before asynchronous certificate import. */
export async function readSamlIdpMetadata(
  xml: string,
  entityId: string,
  owner: SamlPostOwner,
  now = Date.now(),
): Promise<SamlIdpMetadata> {
  assertSamlPostOwner(owner);
  const expected = text(entityId);
  const document = boundedDocument(xml);
  const matches = descriptors(document.documentElement).filter(
    (entity) => entity.getAttribute("entityID") === expected,
  );
  if (matches.length !== 1) invalidSamlMetadata();
  const entity = matches[0];
  const candidates = elements(entity, MD, "IDPSSODescriptor").filter(
    (descriptor) =>
      (descriptor.getAttribute("protocolSupportEnumeration") ?? "")
        .trim()
        .split(/\s+/)
        .includes(P),
  );
  if (candidates.length !== 1) invalidSamlMetadata();
  const descriptor = candidates[0];
  const endpoints = elements(descriptor, MD, "SingleSignOnService").filter(
    (endpoint) => endpoint.getAttribute("Binding") === POST,
  );
  if (endpoints.length !== 1) invalidSamlMetadata();
  const postUrl = location(endpoints[0]);
  const expiresAt = expiry(descriptor, now);
  const requested =
    descriptor.getAttribute("WantAuthnRequestsSigned") ?? "false";
  if (!["true", "false", "1", "0"].includes(requested)) invalidSamlMetadata();
  const nameIdFormats = Object.freeze(
    elements(descriptor, MD, "NameIDFormat").map((format) => {
      if (format.children.length) invalidSamlMetadata();
      return text(format.textContent);
    }),
  );
  const encoded = certificates(descriptor);
  const signingSpki = await publicKeys(encoded, owner);
  assertSamlPostOwner(owner);
  if (expiresAt !== null && expiresAt <= Date.now()) invalidSamlMetadata();
  return Object.freeze({
    entityId: expected,
    postUrl,
    signingSpki,
    nameIdFormats,
    signedRequests: requested === "true" || requested === "1",
    expiresAt,
  });
}
