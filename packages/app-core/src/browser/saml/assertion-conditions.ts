/** SAML request, audience and time conditions over the original signature-covered DOM. */
export type SamlPostOwner = Readonly<{
  signal: AbortSignal;
  assertCurrent: () => void;
}>;
export function assertSamlPostOwner(owner: SamlPostOwner): void {
  owner.signal.throwIfAborted();
  owner.assertCurrent();
}

export const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const XMLNS = "http://www.w3.org/2000/xmlns/";
export type SamlPendingRequest = Readonly<{
  requestId: string;
  issuer: string;
  audience: string;
  acsUrl: string;
  issuedAt: number;
  expiresAt: number;
  nameIdFormat: string;
  authnContext: string;
  forceAuthentication: boolean;
}>;
export type SamlTimePolicy = Readonly<{
  clockSkewMs: number;
  maxAssertionAgeMs: number;
  maxAuthenticationAgeMs: number;
  maxSessionDurationMs: number;
}>;

export function invalidSamlAssertion(): never {
  throw new Error("SAML assertion does not match the pending sign-in");
}

export function samlAttributes(
  element: Element,
  allowed: readonly string[],
): void {
  for (const attribute of element.attributes) {
    if (attribute.namespaceURI === XMLNS) continue;
    if (attribute.namespaceURI || !allowed.includes(attribute.name))
      invalidSamlAssertion();
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function samlText(element: Element): string {
  const value = element.textContent ?? "";
  if (
    element.children.length ||
    !value.trim() ||
    value.length > 2048 ||
    hasControlCharacter(value)
  )
    invalidSamlAssertion();
  return value;
}

export function samlUriText(element: Element): string {
  const value = (element.textContent ?? "")
    .replace(/[ \t\r\n]+/g, " ")
    .replace(/^ +| +$/g, "");
  if (
    element.children.length ||
    !value ||
    value.length > 2048 ||
    hasControlCharacter(value)
  )
    invalidSamlAssertion();
  return value;
}

export function samlChild(
  element: Element,
  namespace: string,
  name: string,
): Element {
  const matches = [...element.children].filter(
    (child) => child.namespaceURI === namespace && child.localName === name,
  );
  if (matches.length !== 1) invalidSamlAssertion();
  return matches[0];
}

export function samlInstant(
  value: string | null,
  rounding: "floor" | "ceil" = "floor",
): number {
  if (
    !value ||
    !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  )
    invalidSamlAssertion();
  const instant = Date.parse(value);
  if (
    !Number.isFinite(instant) ||
    new Date(instant).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    invalidSamlAssertion();
  // Browser clocks use milliseconds: round lower bounds up and expiry bounds down.
  const fraction = /\.(\d+)Z$/.exec(value)?.[1] ?? "";
  return (
    instant + (rounding === "ceil" && /[1-9]/.test(fraction.slice(3)) ? 1 : 0)
  );
}

function bounded(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    invalidSamlAssertion();
}

export function assertSamlRequest(
  request: SamlPendingRequest,
  policy: SamlTimePolicy,
  now: number,
): void {
  bounded(now, 0, Number.MAX_SAFE_INTEGER);
  bounded(policy.clockSkewMs, 0, 120000);
  bounded(policy.maxAssertionAgeMs, 1000, 600000);
  bounded(policy.maxAuthenticationAgeMs, 1000, 86400000);
  bounded(policy.maxSessionDurationMs, 1000, 86400000);
  bounded(request.issuedAt, 0, now + policy.clockSkewMs);
  bounded(request.expiresAt, request.issuedAt + 1, request.issuedAt + 300000);
  if (
    request.expiresAt <= now ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(request.requestId)
  )
    invalidSamlAssertion();
  for (const value of [
    request.issuer,
    request.audience,
    request.acsUrl,
    request.nameIdFormat,
  ]) {
    if (!value || value.length > 2048 || value.trim() !== value)
      invalidSamlAssertion();
  }
  if (
    request.authnContext.length > 2048 ||
    request.authnContext.trim() !== request.authnContext
  )
    invalidSamlAssertion();
  assertAcsUrl(request.acsUrl);
}

function assertAcsUrl(value: string): void {
  const acs = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(acs.hostname);
  if (acs.protocol !== "https:" && !(acs.protocol === "http:" && loopback))
    invalidSamlAssertion();
  if (acs.username || acs.password || acs.hash || acs.search)
    invalidSamlAssertion();
}

export function assertSamlIssueInstant(
  element: Element,
  request: SamlPendingRequest,
  policy: SamlTimePolicy,
  now: number,
): number {
  const issued = samlInstant(element.getAttribute("IssueInstant"));
  if (
    samlInstant(element.getAttribute("IssueInstant"), "ceil") >
      now + policy.clockSkewMs ||
    issued < request.issuedAt - policy.clockSkewMs ||
    issued < now - policy.maxAssertionAgeMs - policy.clockSkewMs
  )
    invalidSamlAssertion();
  return issued;
}

function audienceRestriction(element: Element, audience: string): void {
  samlAttributes(element, []);
  const audiences = [...element.children];
  if (!audiences.length || audiences.length > 16) invalidSamlAssertion();
  let matches = false;
  for (const item of audiences) {
    if (
      item.namespaceURI !== SAML_ASSERTION_NS ||
      item.localName !== "Audience"
    )
      invalidSamlAssertion();
    samlAttributes(item, []);
    if (samlUriText(item) === audience) matches = true;
  }
  if (!matches) invalidSamlAssertion();
}

export function samlConditions(
  element: Element,
  request: SamlPendingRequest,
  policy: SamlTimePolicy,
  now: number,
) {
  samlAttributes(element, ["NotBefore", "NotOnOrAfter"]);
  const notBefore = samlInstant(element.getAttribute("NotBefore"), "ceil");
  const notAfter = samlInstant(element.getAttribute("NotOnOrAfter"));
  if (
    notBefore >= notAfter ||
    now + policy.clockSkewMs < notBefore ||
    now - policy.clockSkewMs >= notAfter
  )
    invalidSamlAssertion();
  let restrictions = 0;
  let oneTimeUse = false;
  for (const child of element.children) {
    if (child.namespaceURI !== SAML_ASSERTION_NS) invalidSamlAssertion();
    if (child.localName === "AudienceRestriction") {
      audienceRestriction(child, request.audience);
      restrictions++;
    } else if (child.localName === "OneTimeUse") {
      if (oneTimeUse || child.childNodes.length) invalidSamlAssertion();
      samlAttributes(child, []);
      oneTimeUse = true;
    } else invalidSamlAssertion();
  }
  if (!restrictions) invalidSamlAssertion();
  return { validUntil: notAfter + policy.clockSkewMs, oneTimeUse };
}
