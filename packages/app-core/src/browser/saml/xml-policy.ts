/** Structural policy before XMLDSIG processes untrusted SAML response bytes. */
const DS = "http://www.w3.org/2000/09/xmldsig#";
const ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";
const PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const XML = "http://www.w3.org/XML/1998/namespace";
const ID = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export type SamlXmlInspection = {
  document: Document;
  response: Element;
  assertion: Element;
  signatures: { signature: Element; target: Element }[];
};

function invalid(): never {
  throw new Error("Invalid SAML signed document");
}

function attributes(element: Element, allowed: readonly string[]): void {
  for (const attribute of element.attributes) {
    if (attribute.namespaceURI === XMLNS) continue;
    if (attribute.namespaceURI || !allowed.includes(attribute.name)) invalid();
  }
}

function children(element: Element, names: readonly string[]): Element[] {
  const actual = [...element.children];
  if (actual.length !== names.length) invalid();
  for (const [index, child] of actual.entries()) {
    if (child.namespaceURI !== DS || child.localName !== names[index])
      invalid();
  }
  for (const node of element.childNodes) {
    if (
      (node.nodeType === Node.TEXT_NODE ||
        node.nodeType === Node.CDATA_SECTION_NODE) &&
      node.textContent?.trim()
    )
      invalid();
  }
  return actual;
}

function algorithm(element: Element, expected: string): void {
  attributes(element, ["Algorithm"]);
  children(element, []);
  if (element.getAttribute("Algorithm") !== expected) invalid();
}

function value(element: Element, allowed: readonly string[] = []): void {
  attributes(element, allowed);
  if (element.children.length || !element.textContent?.trim()) invalid();
}

function inspectIds(element: Element, ids: Set<string>): void {
  let count = 0;
  for (const attribute of element.attributes) {
    const ordinary =
      !attribute.namespaceURI && ["ID", "Id", "id"].includes(attribute.name);
    const xmlId =
      attribute.namespaceURI === XML && attribute.localName === "id";
    if (!ordinary && !xmlId) continue;
    if (++count > 1 || !ID.test(attribute.value) || ids.has(attribute.value))
      invalid();
    ids.add(attribute.value);
  }
}

function inspectNodes(document: Document): void {
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
  const ids = new Set<string>();
  let count = 0;
  for (
    let node: Node | null = walker.currentNode;
    node;
    node = walker.nextNode()
  ) {
    if (++count > 4096) invalid();
    let depth = 0;
    for (
      let ancestor = node.parentNode;
      ancestor;
      ancestor = ancestor.parentNode
    ) {
      if (++depth > 32) invalid();
    }
    if (
      node.nodeType === Node.DOCUMENT_TYPE_NODE ||
      node.nodeType === Node.PROCESSING_INSTRUCTION_NODE
    )
      invalid();
    if ((node.nodeValue?.length ?? 0) > 16384) invalid();
    if (node.nodeType === Node.ELEMENT_NODE) {
      // SAFETY: The checked DOM nodeType discriminant establishes the Element invariant.
      inspectElement(node as Element, ids);
    }
  }
}

function inspectElement(element: Element, ids: Set<string>): void {
  if (element.attributes.length > 32) invalid();
  for (const attribute of element.attributes) {
    if (attribute.value.length > 16384) invalid();
  }
  inspectIds(element, ids);
  if (
    element.namespaceURI === DS &&
    ["Object", "Manifest", "RetrievalMethod"].includes(element.localName)
  )
    invalid();
}

function inspectReference(reference: Element, target: Element): void {
  attributes(reference, ["URI"]);
  const id = target.getAttribute("ID");
  if (!id || reference.getAttribute("URI") !== `#${id}`) invalid();
  const [transforms, digest, digestValue] = children(reference, [
    "Transforms",
    "DigestMethod",
    "DigestValue",
  ]);
  attributes(transforms, []);
  const [enveloped, canonicalization] = children(transforms, [
    "Transform",
    "Transform",
  ]);
  algorithm(enveloped, `${DS}enveloped-signature`);
  algorithm(canonicalization, C14N);
  algorithm(digest, "http://www.w3.org/2001/04/xmlenc#sha256");
  value(digestValue);
}

function inspectSignature(signature: Element, target: Element): void {
  attributes(signature, ["Id"]);
  const hasKeyInfo = signature.children.length === 3;
  const [info, signatureValue, keyInfo] = children(
    signature,
    hasKeyInfo
      ? ["SignedInfo", "SignatureValue", "KeyInfo"]
      : ["SignedInfo", "SignatureValue"],
  );
  attributes(info, ["Id"]);
  const [canonicalization, method, reference] = children(info, [
    "CanonicalizationMethod",
    "SignatureMethod",
    "Reference",
  ]);
  algorithm(canonicalization, C14N);
  algorithm(method, "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256");
  inspectReference(reference, target);
  value(signatureValue, ["Id"]);
  if (keyInfo) attributes(keyInfo, ["Id"]);
}

/** This inspection establishes structure and coverage intent, never authentication. */
export function inspectSamlXml(xml: string): SamlXmlInspection {
  if (xml.length > 262144) invalid();
  if (
    new TextEncoder().encode(xml).length > 262144 ||
    /<!\s*(DOCTYPE|ENTITY)/i.test(xml)
  )
    invalid();
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length) invalid();
  inspectNodes(document);
  const response = document.documentElement;
  if (response.namespaceURI !== PROTOCOL || response.localName !== "Response")
    invalid();
  const assertions = document.getElementsByTagNameNS(ASSERTION, "Assertion");
  if (assertions.length !== 1) invalid();
  const assertion = assertions[0];
  if (assertion.parentElement !== response) invalid();
  for (const target of [response, assertion]) {
    if (!target.getAttribute("ID") || target.getAttribute("Version") !== "2.0")
      invalid();
  }
  const signatures = [...document.getElementsByTagNameNS(DS, "Signature")];
  if (!signatures.length || signatures.length > 2) invalid();
  const targets = new Set<Element>();
  const covered = signatures.map((signature) => {
    const target = signature.parentElement;
    if (
      !target ||
      ![response, assertion].includes(target) ||
      targets.has(target)
    )
      invalid();
    targets.add(target);
    inspectSignature(signature, target);
    return { signature, target };
  });
  return { document, response, assertion, signatures: covered };
}
