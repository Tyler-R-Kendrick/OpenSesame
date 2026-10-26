import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  SAML,
  ValidateInResponseTo,
  generateServiceProviderMetadata,
} from "@node-saml/node-saml";
// The DOM helpers node-saml itself validates with. Reaching for the same
// parser — rather than a second XML dependency, or a regex over signed
// material — is what keeps "what we routed on" and "what was verified" the
// same document. The package pins exactly and publishes no `exports` map, so
// the path is stable for this version and moves only when the pin does.
import type { Profile } from "@node-saml/node-saml";
import { parseDomFromString, xpath } from "@node-saml/node-saml/lib/xml.js";
import { appendAuditEvent } from "@opensesame/audit";
import {
  type JsonObject,
  type JsonValue,
  type Organization,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { ControlPlaneConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { sameOriginPath } from "../middleware/same-origin-path.js";
import {
  jitJoinOrganization,
  usesNativeSaml,
} from "../routes/organizations.js";
import { ensurePersonalOnAuthenticatedSession } from "../routes/projects.js";
import { provisionedRoleForSubject } from "../routes/scim.js";
import {
  UnsafeUpstreamError,
  assertPublicUpstreamUrl,
  guardedFetch,
} from "../services/guarded-fetch.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import { organizationAssertedEmailIsVerified } from "../services/org-email-trust.js";
import {
  ProvisionalMintRefusedError,
  mintProvisionalForInteraction,
} from "./handlers.js";
import { SamlAuthError } from "./saml-errors.js";
import { claimSamlEntityId, issuerForResult } from "./saml-issuer-claim.js";

/**
 * Native SAML 2.0 service provider (ADR 0056, C14/D9/D10).
 *
 * ADR 0016 said OpenSesame would never parse SAML and would broker it through
 * an external Keycloak instead. That is superseded for the SP half: tenants
 * running Okta, Entra, ADFS or Shibboleth configure their IdP here directly.
 * The brokered path still works; this is additive.
 *
 * XML-DSig is not hand-rolled anywhere in this file. `@node-saml/node-saml`
 * owns signature verification, condition windows and audience restriction —
 * the mature-library rule of ADR 0008 applies with unusual force to XML
 * signatures, where the exploitable ground is the parser rather than the
 * cryptography. What this module owns is everything around that: which IdP's
 * key a response is judged against, whether the request it answers was one we
 * made, and whether the assertion has been seen before.
 *
 * SECURITY INVARIANT (T25): SAML pending state is NEVER a cookie. The ACS is a
 * cross-site POST from the IdP and carries no `SameSite=Lax` cookie, and a
 * multi-KB assertion cannot be re-materialized into a GET query the way
 * Apple's four `form_post` parameters can. The request→interaction binding
 * lives in `ctx.stores.saml.pending`, keyed by the AuthnRequest id, and the
 * browser is handed back to the interaction by a one-time completion code on a
 * top-level GET — which does carry the Lax cookies.
 */

/** Standard attribute names real IdPs emit for a human's mail address. */
const ATTR_EMAIL_OID = "urn:oid:0.9.2342.19200300.100.1.3";
const ATTR_EMAIL_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
const ATTR_EMAIL_FRIENDLY = ["mail", "email", "emailAddress"];

/** ...and for a display name. */
const ATTR_NAME_OID = "urn:oid:2.5.4.3";
const ATTR_NAME_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name";
const ATTR_NAME_FRIENDLY = ["displayName", "name", "cn"];

const NAMEID_FORMAT_PERSISTENT =
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const BINDING_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";

/**
 * Clock skew tolerated on `NotBefore`/`NotOnOrAfter` (D10). Deliberately tight:
 * the whole value of a condition window is that it is short, and an SP that
 * accepts minutes of skew has converted a signed one-shot assertion into a
 * bearer token with a long life.
 */
const CLOCK_SKEW_MS = 30_000;

/** Refuse an assertion older than this regardless of its own window. */
const MAX_ASSERTION_AGE_MS = 5 * 60 * 1000;

/** A SAML response larger than this is not a sign-in. */
const MAX_SAML_RESPONSE_BYTES = 512 * 1024;

/** How long IdP metadata is reused before it is fetched again. */
const METADATA_CACHE_TTL_MS = 10 * 60 * 1000;

/** How long the browser has to spend a completion code. Seconds, by design. */
/** Timeout for the metadata fetch. */
const METADATA_FETCH_MS = 5_000;

export type SamlOrgConfig = {
  organizationId: string;
  /** IdP entityID. Empty adopts whatever the configured metadata declares. */
  idpEntityId: string;
  /** Exactly one source resolves to signing cert(s) + the SSO endpoint. */
  metadataUrl?: string;
  metadataXml?: string;
};

export type SamlAssertionResult = {
  subject: string;
  nameIdFormat: string;
  organizationId: string;
  /**
   * Display only, deliberately (C14). A SAML attribute carries no verification
   * signal an SP can trust, so neither of these is ever an account-linking key
   * — and an `emailAddress`-format NameID is a subject string, not an address.
   */
  email?: string;
  name?: string;
};

export { SamlAuthError, type SamlAuthErrorCode } from "./saml-errors.js";

/** What a started SP-initiated leg hands back to the route that started it. */
export type SamlAuthStart = {
  redirectUrl: string;
  requestId: string;
};

export type SamlCompletion = {
  interactionUid: string;
  result: SamlAssertionResult;
};

export type SamlResponseOutcome =
  | {
      flow: "sp";
      interactionUid: string;
      result: SamlAssertionResult;
      completionCode: string;
    }
  | { flow: "idp_initiated"; result: SamlAssertionResult; relayPath: string };

/** The SP entityID: the metadata URL, as SAML deployments conventionally do. */
export function samlEntityId(config: ControlPlaneConfig): string {
  return `${baseUrl(config)}/v1/saml/metadata`;
}

/** Where the IdP POSTs its response. */
export function samlAcsUrl(config: ControlPlaneConfig): string {
  return `${baseUrl(config)}/v1/saml/acs`;
}

function baseUrl(config: ControlPlaneConfig): string {
  return config.publicUrl.replace(/\/+$/, "");
}

/**
 * The SP EntityDescriptor this deployment publishes.
 *
 * Unsigned and with `AuthnRequestsSigned="false"`: this SP holds no signing
 * key, so claiming otherwise in metadata would make every IdP that honours it
 * reject our requests.
 */
export function samlServiceProviderMetadata(
  config: ControlPlaneConfig,
): string {
  return generateServiceProviderMetadata({
    issuer: samlEntityId(config),
    callbackUrl: samlAcsUrl(config),
    identifierFormat: NAMEID_FORMAT_PERSISTENT,
    wantAssertionsSigned: true,
    // Stable across restarts: metadata is a document IdP operators diff, and a
    // fresh random id on every read makes every read look like a change.
    generateUniqueId: () => "_opensesame-sp-metadata",
  });
}

/** The native-SAML configuration of a tenant, when it has one. */
export function samlOrgConfig(org: Organization): SamlOrgConfig | undefined {
  if (!usesNativeSaml(org)) return undefined;
  return {
    organizationId: org.id,
    idpEntityId: org.samlIssuer ?? "",
    ...(org.samlMetadataUrl ? { metadataUrl: org.samlMetadataUrl } : undefined),
    ...(org.samlMetadataXml ? { metadataXml: org.samlMetadataXml } : undefined),
  };
}

type ResolvedIdpMetadata = {
  entityId: string;
  ssoUrl: string;
  certificates: string[];
};

const metadataCache = new Map<
  string,
  { value: ResolvedIdpMetadata; expiresAt: number }
>();

/** Test hook, and the operator's answer to a rotated IdP certificate. */
export function resetSamlMetadataCache(): void {
  metadataCache.clear();
}

/**
 * Completion codes: the SP-initiated hand-back from the ACS to the interaction.
 *
 * The code is a short-lived, AES-GCM-sealed envelope rather than an entry in a
 * process-local map. A response verified on one replica is therefore resumable
 * on another, and a restart between the ACS redirect and the GET it provokes
 * does not strand the browser. The sealed payload names the interaction and the
 * assertion this process just verified; it carries no standing authority of its
 * own, and single use is claimed in the durable SAML replay ledger so a copied
 * completion URL cannot be spent twice.
 */
const COMPLETION_CODE_TTL_MS = 2 * 60 * 1000;

function completionCodeKey(ctx: AppContext): Buffer {
  return createHash("sha256")
    .update("opensesame:saml-completion:v1\0")
    .update(ctx.config.claimPepper)
    .digest();
}

/** Test hook retained for suites that reset module state between cases. */
export function resetSamlCompletionCodes(): void {
  // Completion codes are stateless; single use lives in the durable replay
  // ledger, which the suite resets through its own SAML store.
}

function issueCompletionCode(
  ctx: AppContext,
  completion: SamlCompletion,
  now: number,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", completionCodeKey(ctx), iv);
  const plaintext = Buffer.from(
    JSON.stringify({
      exp: now + COMPLETION_CODE_TTL_MS,
      interactionUid: completion.interactionUid,
      result: completion.result,
    }),
    "utf8",
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function completionFromPayload(record: JsonObject): SamlCompletion | undefined {
  const interactionUid = record.interactionUid;
  const result = record.result;
  if (!isString(interactionUid) || !isJsonObject(result)) return undefined;
  const subject = result.subject;
  const nameIdFormat = result.nameIdFormat;
  const organizationId = result.organizationId;
  if (
    !isString(subject) ||
    !isString(nameIdFormat) ||
    !isString(organizationId)
  ) {
    return undefined;
  }
  const email = isString(result.email) ? result.email : undefined;
  const name = isString(result.name) ? result.name : undefined;
  return {
    interactionUid,
    result: {
      subject,
      nameIdFormat,
      organizationId,
      ...(email !== undefined ? { email } : undefined),
      ...(name !== undefined ? { name } : undefined),
    },
  };
}

/** Single-use: the durable replay claim is what consumes the code. */
export async function takeSamlCompletion(
  ctx: AppContext,
  code: string | undefined,
  now: number,
): Promise<SamlCompletion | undefined> {
  if (!code) return undefined;
  const [version, ivRaw, tagRaw, ciphertextRaw] = code.split(".");
  if (
    version !== "v1" ||
    !ivRaw ||
    !tagRaw ||
    !ciphertextRaw ||
    code.length > 8192
  ) {
    return undefined;
  }
  let payload: JsonValue;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      completionCodeKey(ctx),
      Buffer.from(ivRaw, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    payload = JSON.parse(plaintext);
  } catch {
    return undefined;
  }
  if (!isJsonObject(payload)) return undefined;
  const exp = payload.exp;
  if (!isNumber(exp) || exp <= now || exp > now + COMPLETION_CODE_TTL_MS) {
    return undefined;
  }
  const completion = completionFromPayload(payload);
  if (!completion) return undefined;
  const replayKey = `otc:${createHash("sha256").update(code).digest("hex")}`;
  if (await ctx.stores.saml.replay.seen(replayKey, new Date(exp))) {
    return undefined;
  }
  return completion;
}

function pemFromBase64(certificate: string): string {
  const body = certificate.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * Fetch a tenant-supplied metadata URL under the network fence.
 *
 * Same posture as the org-assertion leg: `guardedFetch` refuses private,
 * loopback, link-local and cloud-metadata targets (T21) — as written AND as
 * the name resolves, pinning the socket to the address it judged — refuses
 * redirects rather than following them, and bounds the body. The private-host
 * half is relaxed only under dev defaults, where the dev stack is loopback.
 */
async function fetchMetadataDocument(
  ctx: AppContext,
  rawUrl: string,
): Promise<string> {
  const blockPrivateHosts = !ctx.config.allowDevDefaults;
  let url: URL;
  try {
    url = blockPrivateHosts ? assertPublicUpstreamUrl(rawUrl) : new URL(rawUrl);
  } catch (error) {
    if (error instanceof UnsafeUpstreamError) {
      throw new SamlAuthError(
        "metadata_unavailable",
        "The organization's SAML metadata host is not reachable from this deployment.",
      );
    }
    throw new SamlAuthError(
      "metadata_unavailable",
      "The organization's SAML metadata URL is not a URL.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SamlAuthError(
      "metadata_unavailable",
      "The organization's SAML metadata URL is not http(s).",
    );
  }
  let response: Response;
  try {
    response = await guardedFetch(url, blockPrivateHosts, {
      signal: AbortSignal.timeout(METADATA_FETCH_MS),
      maxBytes: MAX_SAML_RESPONSE_BYTES,
    });
  } catch {
    throw new SamlAuthError(
      "metadata_unavailable",
      "Could not reach the organization's SAML metadata.",
    );
  }
  if (!response.ok) {
    throw new SamlAuthError(
      "metadata_unavailable",
      `The organization's SAML metadata returned ${response.status}.`,
    );
  }
  const body = await response.text();
  if (body.length > MAX_SAML_RESPONSE_BYTES) {
    throw new SamlAuthError(
      "metadata_unavailable",
      "The organization's SAML metadata document is implausibly large.",
    );
  }
  return body;
}

async function parseIdpMetadata(
  xml: string,
  allowHttp: boolean,
): Promise<ResolvedIdpMetadata> {
  let doc: Document;
  try {
    doc = await parseDomFromString(xml);
  } catch {
    throw new SamlAuthError(
      "metadata_unavailable",
      "The organization's SAML metadata is not parseable XML.",
    );
  }
  const entityId =
    xpath
      .selectAttributes(doc, "/*[local-name()='EntityDescriptor']/@entityID")
      .at(0)?.nodeValue ?? "";
  const certificates = xpath
    .selectElements(
      doc,
      "//*[local-name()='IDPSSODescriptor']//*[local-name()='KeyDescriptor']" +
        "[not(@use) or @use='signing']" +
        "//*[local-name()='X509Certificate']",
    )
    .map((node) => (node.textContent ?? "").trim())
    .filter((value) => value.length > 0)
    .map(pemFromBase64);
  const ssoUrl =
    xpath
      .selectAttributes(
        doc,
        `//*[local-name()='IDPSSODescriptor']/*[local-name()='SingleSignOnService'][@Binding='${BINDING_REDIRECT}']/@Location`,
      )
      .at(0)?.nodeValue ?? "";
  if (entityId.length === 0 || certificates.length === 0 || !ssoUrl) {
    throw new SamlAuthError(
      "metadata_unavailable",
      "The organization's SAML metadata declares no entityID, signing certificate, or SSO endpoint.",
    );
  }
  let safeSso: URL;
  try {
    safeSso = new URL(ssoUrl);
    const allowedProtocol =
      safeSso.protocol === "https:" ||
      (allowHttp && safeSso.protocol === "http:");
    if (!allowedProtocol || safeSso.username || safeSso.password)
      throw new Error("unsafe SSO URL");
  } catch {
    throw new SamlAuthError(
      "metadata_unavailable",
      "The organization's SAML SSO endpoint must be an https URL.",
    );
  }
  return { entityId, ssoUrl: safeSso.href, certificates };
}

/**
 * Resolve a tenant's IdP metadata to keys and an SSO endpoint.
 *
 * Inline XML is what the operator pasted and is parsed directly; a URL is
 * fetched under the guard above and cached, because it is dereferenced on
 * every ACS POST and an IdP's metadata endpoint is not a hot path anyone
 * intends to hammer.
 */
export async function resolveIdpMetadata(
  ctx: AppContext,
  cfg: SamlOrgConfig,
): Promise<ResolvedIdpMetadata> {
  const key = cfg.metadataXml
    ? `xml:${createHash("sha256").update(cfg.metadataXml).digest("hex")}`
    : `url:${cfg.metadataUrl ?? ""}`;
  const now = ctx.clock().getTime();
  const cached = metadataCache.get(key);
  if (cached && cached.expiresAt > now) return assertEntity(cfg, cached.value);

  const xml =
    cfg.metadataXml ??
    (await fetchMetadataDocument(ctx, cfg.metadataUrl ?? ""));
  const resolved = await parseIdpMetadata(xml, ctx.config.allowDevDefaults);
  metadataCache.set(key, {
    value: resolved,
    expiresAt: now + METADATA_CACHE_TTL_MS,
  });
  return assertEntity(cfg, resolved);
}

/**
 * A configured entityID is authoritative over the document that claims it.
 * Absent one, the metadata's own entityID is adopted — the operator pointed at
 * this document, and a tenant that never recorded an entityID has nothing else
 * to be measured against.
 */
function assertEntity(
  cfg: SamlOrgConfig,
  resolved: ResolvedIdpMetadata,
): ResolvedIdpMetadata {
  if (cfg.idpEntityId.length > 0 && cfg.idpEntityId !== resolved.entityId) {
    throw new SamlAuthError(
      "metadata_unavailable",
      "The organization's SAML metadata does not match its configured entityID.",
    );
  }
  return resolved;
}

function samlOrganizationSignsIn(organization: Organization): boolean {
  return organization.state !== "suspended" && organization.state !== "deleted";
}

function buildSamlClient(
  ctx: AppContext,
  metadata: ResolvedIdpMetadata,
  requestId?: string,
): SAML {
  const entityId = samlEntityId(ctx.config);
  return new SAML({
    idpCert: metadata.certificates,
    // Our entityID is both what we call ourselves in the AuthnRequest and the
    // `Audience` an assertion must be restricted to (D10) — the same string,
    // deliberately, so an assertion minted for another SP cannot be replayed
    // here even with a valid signature from a shared IdP.
    issuer: entityId,
    audience: entityId,
    callbackUrl: samlAcsUrl(ctx.config),
    entryPoint: metadata.ssoUrl,
    idpIssuer: metadata.entityId,
    identifierFormat: NAMEID_FORMAT_PERSISTENT,
    // The assertion must carry its own signature. Requiring the enclosing
    // Response to be signed as well would be stricter than most real IdPs
    // (Okta and Entra sign the assertion only) and buys nothing here: every
    // field this SP acts on is read from the verified assertion, never from
    // the unsigned wrapper.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,
    // node-saml's own InResponseTo cache is bypassed: the binding lives in the
    // durable pending store instead, and is checked here against the *signed*
    // SubjectConfirmationData rather than the malleable Response attribute.
    validateInResponseTo: ValidateInResponseTo.never,
    disableRequestedAuthnContext: true,
    ...(requestId !== undefined
      ? { generateUniqueId: () => requestId }
      : undefined),
  });
}

/**
 * Start SP-initiated sign-in: an HTTP-Redirect AuthnRequest, and a server-side
 * record of the request id so the response can be matched to this interaction.
 *
 * The id is generated here rather than read back out of the library, because
 * the record has to exist before the browser can possibly return.
 */
export async function beginSamlAuth(
  ctx: AppContext,
  uid: string,
  org: SamlOrgConfig,
): Promise<SamlAuthStart> {
  const metadata = await resolveIdpMetadata(ctx, org);
  if (metadata.ssoUrl.length === 0) {
    throw new SamlAuthError(
      "metadata_unavailable",
      "The organization's SAML metadata publishes no HTTP-Redirect sign-on endpoint.",
    );
  }
  await claimSamlEntityId(ctx, org.organizationId, metadata.entityId);
  // An XML ID is an NCName: it may not start with a digit.
  const requestId = `_${randomBytes(20).toString("hex")}`;
  const client = buildSamlClient(ctx, metadata, requestId);
  const redirectUrl = await client.getAuthorizeUrlAsync("", undefined, {});
  await ctx.stores.saml.pending.put({
    requestId,
    interactionUid: uid,
    organizationId: org.organizationId,
    createdAt: ctx.clock(),
  });
  return { redirectUrl, requestId };
}

/**
 * What the UNVERIFIED envelope says about where a response should be judged.
 * Nothing here is trusted: it only chooses which tenant's certificate answers.
 */
type SamlResponseRouting = {
  inResponseTo?: string;
  issuer?: string;
};

type AssertionFacts = {
  assertionId: string;
  notOnOrAfter?: Date;
  subjectInResponseTo?: string;
};

/**
 * Read the replay key and the request binding out of the VERIFIED assertion.
 *
 * Both matter more than they look. The `InResponseTo` on the enclosing
 * `<samlp:Response>` is not covered by the assertion's signature and an
 * attacker can rewrite it freely; the copy inside `SubjectConfirmationData`
 * is signed, and is therefore the only one that can bind an assertion to a
 * request we actually made.
 */
async function assertionFacts(assertionXml: string): Promise<AssertionFacts> {
  const doc = await parseDomFromString(assertionXml);
  const assertionId =
    xpath.selectAttributes(doc, "/*[local-name()='Assertion']/@ID").at(0)
      ?.nodeValue ?? "";
  const notOnOrAfterRaw = xpath
    .selectAttributes(
      doc,
      "/*[local-name()='Assertion']/*[local-name()='Conditions']/@NotOnOrAfter",
    )
    .at(0)?.nodeValue;
  const subjectInResponseTo = xpath
    .selectAttributes(
      doc,
      "/*[local-name()='Assertion']/*[local-name()='Subject']" +
        "/*[local-name()='SubjectConfirmation']" +
        "/*[local-name()='SubjectConfirmationData']/@InResponseTo",
    )
    .at(0)?.nodeValue;
  const notOnOrAfter = notOnOrAfterRaw ? new Date(notOnOrAfterRaw) : undefined;
  return {
    assertionId,
    ...(notOnOrAfter && !Number.isNaN(notOnOrAfter.getTime())
      ? { notOnOrAfter }
      : undefined),
    ...(subjectInResponseTo ? { subjectInResponseTo } : undefined),
  };
}

/** The first attribute present among a set of equivalent names. */
function firstAttribute(
  attributes: ReadonlyMap<string, string>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = attributes.get(name);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * RelayState is honoured only when it names a path on this deployment (D10).
 *
 * An IdP-initiated sign-in is the one flow where a stranger's parameter
 * decides where an authenticated browser lands, so the value has to survive
 * two questions, not one: is it shaped like a location on this server (an
 * absolute URL or a rooted path — never a bare relative string that resolves
 * to whatever it happens to resolve to), and does it actually land on our
 * origin? A protocol-relative `//host/…` passes the first and fails the
 * second, which is precisely why both are asked — and both are asked of the
 * value a browser will parse, so a stripped tab or a `/..//host` path is
 * refused too (`sameOriginPath`).
 */
export function samlRelayPath(
  config: ControlPlaneConfig,
  relayState: string | undefined,
): string {
  if (!relayState) return "/";
  return (
    sameOriginPath(relayState, baseUrl(config), { allowAbsolute: true }) ?? "/"
  );
}

async function readResponseRouting(
  samlResponse: string,
): Promise<SamlResponseRouting> {
  // Base64 expands by 4/3. Refuse before allocating a decoded buffer, so a
  // multi-megabyte form field cannot turn the ACS into a memory amplifier.
  if (
    samlResponse.length === 0 ||
    samlResponse.length > Math.ceil((MAX_SAML_RESPONSE_BYTES * 4) / 3) + 4
  ) {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }
  const raw = Buffer.from(samlResponse, "base64");
  if (raw.byteLength === 0 || raw.byteLength > MAX_SAML_RESPONSE_BYTES) {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }
  let doc: Document;
  try {
    doc = await parseDomFromString(raw.toString("utf8"));
  } catch {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }
  const inResponseTo = xpath
    .selectAttributes(doc, "/*[local-name()='Response']/@InResponseTo")
    .at(0)?.nodeValue;
  const issuer = xpath
    .selectElements(doc, "/*[local-name()='Response']/*[local-name()='Issuer']")
    .at(0)
    ?.textContent?.trim();
  return {
    ...(inResponseTo ? { inResponseTo } : undefined),
    ...(issuer ? { issuer } : undefined),
  };
}

/**
 * Validate a SAML response and say what to do with it (C14).
 *
 * The order is deliberate and fail-closed:
 *
 * 1. Route on the *unverified* document — `InResponseTo` for SP-initiated,
 *    `Issuer` for IdP-initiated — to decide whose key answers for it. Routing
 *    on unverified content is safe precisely because it only ever chooses a
 *    verifier; a response naming somebody else's tenant is then judged against
 *    that tenant's certificate and fails.
 * 2. Consume the pending record (single-use in the store by construction).
 * 3. Verify: signature, `Audience`, condition window — the library's job.
 * 4. Re-check the things the library does not: the issuer of the *assertion*,
 *    the signed `InResponseTo`, and assertion-id replay.
 */
const SAML_ACS_WINDOW_MS = 60_000;
const SAML_ACS_PER_ISSUER = 30;
const SAML_ACS_GLOBAL = 200;
const SAML_ACS_MAX_KEYS = 2048;
const SAML_ACS_GLOBAL_KEY = "__global__";
const samlAcsAttempts = new Map<string, number[]>();

function consumeSamlAcsBudget(
  issuer: string | undefined,
  now: number,
  chargeGlobal = true,
): boolean {
  for (const [key, times] of samlAcsAttempts) {
    const live = times.filter((at) => now - at < SAML_ACS_WINDOW_MS);
    if (live.length === 0) samlAcsAttempts.delete(key);
    else if (live.length !== times.length) samlAcsAttempts.set(key, live);
  }
  const global = samlAcsAttempts.get(SAML_ACS_GLOBAL_KEY) ?? [];
  const issuerKey = issuer ? `issuer:${issuer}` : undefined;
  const mine = issuerKey ? (samlAcsAttempts.get(issuerKey) ?? []) : [];
  if (
    (chargeGlobal && global.length >= SAML_ACS_GLOBAL) ||
    mine.length >= SAML_ACS_PER_ISSUER
  ) {
    return false;
  }
  if (chargeGlobal) {
    global.push(now);
    samlAcsAttempts.set(SAML_ACS_GLOBAL_KEY, global);
  }
  if (issuerKey) {
    mine.push(now);
    samlAcsAttempts.set(issuerKey, mine);
  }
  while (samlAcsAttempts.size > SAML_ACS_MAX_KEYS) {
    const victim = [...samlAcsAttempts.keys()].find(
      (key) => key !== SAML_ACS_GLOBAL_KEY,
    );
    if (victim === undefined) break;
    samlAcsAttempts.delete(victim);
  }
  return true;
}

/** Test hook. */
export function resetSamlAcsBudget(): void {
  samlAcsAttempts.clear();
}

/**
 * New principal mints attributable to a tenant-supplied SAML IdP.
 *
 * The fleet provisional pool is shared. A tenant owner who controls their
 * metadata can forge assertions for fresh NameIDs, so without a per-tenant
 * ceiling one tenant can fill the pool and stop every other sign-in. The
 * ceiling is per organization, with a global SAML-only cap that still leaves
 * the majority of `MAX_PROVISIONAL` for every other admission leg.
 */
const SAML_MINT_WINDOW_MS = 60_000;
const SAML_MINTS_PER_ORGANIZATION = 6;
const SAML_MINTS_GLOBAL = 60;
const SAML_MINT_MAX_KEYS = 2_048;
const SAML_MINT_GLOBAL_KEY = "__global__";
const samlMintAttempts = new Map<string, number[]>();

function consumeSamlMintBudget(organizationId: string, now: number): boolean {
  for (const [key, times] of samlMintAttempts) {
    const live = times.filter((at) => now - at < SAML_MINT_WINDOW_MS);
    if (live.length === 0) samlMintAttempts.delete(key);
    else if (live.length !== times.length) samlMintAttempts.set(key, live);
  }
  const global = samlMintAttempts.get(SAML_MINT_GLOBAL_KEY) ?? [];
  const key = `organization:${organizationId}`;
  const mine = samlMintAttempts.get(key) ?? [];
  if (
    global.length >= SAML_MINTS_GLOBAL ||
    mine.length >= SAML_MINTS_PER_ORGANIZATION
  ) {
    return false;
  }
  global.push(now);
  mine.push(now);
  samlMintAttempts.set(SAML_MINT_GLOBAL_KEY, global);
  samlMintAttempts.set(key, mine);
  while (samlMintAttempts.size > SAML_MINT_MAX_KEYS) {
    const victim = [...samlMintAttempts.keys()].find(
      (candidate) => candidate !== SAML_MINT_GLOBAL_KEY,
    );
    if (victim === undefined) break;
    samlMintAttempts.delete(victim);
  }
  return true;
}

/** Test hook. */
export function resetSamlMintBudget(): void {
  samlMintAttempts.clear();
}

export async function completeSamlResponse(
  ctx: AppContext,
  body: { SAMLResponse: string; RelayState?: string },
): Promise<SamlResponseOutcome> {
  // The global bucket is charged before XML parsing: a request that names no
  // issuer at all still costs a parse, and the per-issuer key would otherwise
  // let an attacker skip the endpoint budget by omitting it.
  if (!consumeSamlAcsBudget(undefined, Date.now())) {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }
  const routing = await readResponseRouting(body.SAMLResponse);
  if (
    routing.issuer &&
    !consumeSamlAcsBudget(routing.issuer, Date.now(), false)
  ) {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }

  let organization: Organization | undefined;
  let interactionUid: string | undefined;
  if (routing.inResponseTo) {
    const pending = await ctx.stores.saml.pending.take(routing.inResponseTo);
    if (!pending) {
      throw new SamlAuthError(
        "unknown_request",
        "That sign-in request is no longer in progress. Start again.",
      );
    }
    interactionUid = pending.interactionUid;
    organization = await ctx.stores.organizations.get(pending.organizationId);
  } else if (routing.issuer) {
    organization = await ctx.stores.organizations.findByIssuer(routing.issuer);
  }

  const cfg =
    organization &&
    organization.state !== "suspended" &&
    organization.state !== "deleted"
      ? samlOrgConfig(organization)
      : undefined;
  if (!cfg) {
    throw new SamlAuthError(
      "not_configured",
      "No organization on this server accepts that identity provider.",
    );
  }

  const metadata = await resolveIdpMetadata(ctx, cfg);
  // A metadata document's entityID is an identity key. Two tenants may not
  // share one, or one tenant's assertion would resolve to the other's rows.
  // The check and the adoption of an empty `samlIssuer` are one serialized
  // claim, so two first-use tenants cannot both pass the check.
  await claimSamlEntityId(ctx, cfg.organizationId, metadata.entityId);
  const claimed = await ctx.stores.organizations.findByIssuer(
    metadata.entityId,
  );
  if (claimed && claimed.id !== cfg.organizationId) {
    throw new SamlAuthError(
      "not_configured",
      "This identity provider belongs to another tenant.",
    );
  }
  const signingOrganization = claimed ?? organization;
  if (!signingOrganization || !samlOrganizationSignsIn(signingOrganization)) {
    throw new SamlAuthError(
      "not_configured",
      "No organization on this server accepts that identity provider.",
    );
  }
  const client = buildSamlClient(ctx, metadata);
  let profile: Profile | null;
  try {
    ({ profile } = await client.validatePostResponseAsync({
      SAMLResponse: body.SAMLResponse,
      ...(body.RelayState !== undefined
        ? { RelayState: body.RelayState }
        : undefined),
    }));
  } catch (error) {
    ctx.log.warn(
      { err: error, organizationId: cfg.organizationId },
      "saml assertion rejected",
    );
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }
  if (!profile) {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }

  // The assertion's own Issuer — signed, unlike the Response wrapper's — must
  // be the IdP this tenant configured. node-saml checks this only on the
  // logout paths, so the sign-in path checks it here.
  if (profile.issuer !== metadata.entityId) {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }

  const assertionXml = profile.getAssertionXml?.() ?? "";
  if (assertionXml.length === 0) {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }
  const facts = await assertionFacts(assertionXml);

  if (routing.inResponseTo) {
    // Bind on the SIGNED copy. Equality with the wrapper's value is implied,
    // but it is the signed one that decides.
    if (facts.subjectInResponseTo !== routing.inResponseTo) {
      throw new SamlAuthError(
        "invalid_assertion",
        "That sign-in could not be completed.",
      );
    }
  } else if (facts.subjectInResponseTo) {
    // An assertion minted for somebody's SP request, re-posted with the
    // wrapper's InResponseTo stripped, is not an IdP-initiated sign-in.
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }

  if (facts.assertionId.length === 0) {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }
  const expiresAt =
    facts.notOnOrAfter ??
    new Date(ctx.clock().getTime() + MAX_ASSERTION_AGE_MS);
  if (await ctx.stores.saml.replay.seen(facts.assertionId, expiresAt)) {
    throw new SamlAuthError(
      "replayed_assertion",
      "That sign-in has already been used.",
    );
  }

  const nameId = profile.nameID;
  if (nameId.length === 0 || nameId.length > 1024) {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }
  // SAML attribute values are open by protocol: one value or a repeated one.
  // Flattened here, at the boundary, so nothing downstream reads an unparsed
  // shape — and read for display only, never as an identity key (C14).
  const attributes = new Map<string, string>();
  for (const [key, value] of Object.entries(overlapCast(profile))) {
    const first = Array.isArray(value) ? value.find(isString) : value;
    if (isString(first) && first.length > 0) attributes.set(key, first);
  }
  const email = firstAttribute(attributes, [
    ATTR_EMAIL_OID,
    ATTR_EMAIL_CLAIM,
    ...ATTR_EMAIL_FRIENDLY,
  ]);
  const name = firstAttribute(attributes, [
    ATTR_NAME_OID,
    ATTR_NAME_CLAIM,
    ...ATTR_NAME_FRIENDLY,
  ]);
  const result: SamlAssertionResult = {
    subject: nameId,
    nameIdFormat: profile.nameIDFormat || NAMEID_FORMAT_PERSISTENT,
    organizationId: cfg.organizationId,
    ...(email !== undefined && email.length <= 320 ? { email } : undefined),
    ...(name !== undefined && name.length <= 512 ? { name } : undefined),
  };

  if (interactionUid !== undefined) {
    return {
      flow: "sp",
      interactionUid,
      result,
      completionCode: issueCompletionCode(
        ctx,
        { interactionUid, result },
        ctx.clock().getTime(),
      ),
    };
  }
  return {
    flow: "idp_initiated",
    result,
    relayPath: samlRelayPath(ctx.config, body.RelayState),
  };
}

export type SamlAdmission =
  | {
      ok: true;
      principalId: string;
      /** The IdP entityID the identity row was recorded against. */
      issuer: string;
      sessionToken?: string;
    }
  | { ok: false; status: 403 | 409 | 429; message: string };

/**
 * Find-or-mint the principal a verified assertion names, and JIT-join it.
 *
 * Shared by both flows: the SP-initiated completion route resumes an
 * interaction afterwards and the IdP-initiated ACS does not, but which
 * principal signed in — and whether the tenant will have them — must not
 * depend on which door the assertion came through.
 *
 * `sessionToken` is present only for a newly minted principal (T6): a
 * returning identity already has whatever session it has, and handing it a
 * fresh provisional bearer here would hand the browser a second identity.
 */
export async function admitSamlSubject(
  ctx: AppContext,
  input: {
    result: SamlAssertionResult;
    correlationId: string;
    userAgent: string;
    /** The browser ceremony, when the assertion came through one. */
    interactionUid?: string | undefined;
    /** Server-observed peer, used only for the mint-abuse key. */
    remoteAddress?: string | undefined;
  },
): Promise<SamlAdmission> {
  const issuer = await issuerForResult(ctx, input.result);
  if (!issuer) {
    return {
      ok: false,
      status: 403,
      message: "That organization no longer accepts SAML sign-in.",
    };
  }
  const tenant = input.result.organizationId;

  const existing = await ctx.repos.externalIdentities.findByTuple({
    kind: "saml",
    issuer,
    tenant,
    subject: input.result.subject,
  });
  // Rows created before SAML identity keys carried a tenant were global.
  // Accept one only when its principal already belongs to this tenant, so a
  // forged assertion through another organization cannot resolve it.
  const legacy = existing
    ? undefined
    : await ctx.repos.externalIdentities.findByTuple({
        kind: "saml",
        issuer,
        subject: input.result.subject,
      });
  const legacyOrganization = legacy
    ? await ctx.stores.organizations.get(tenant)
    : undefined;
  const legacyMembership = legacy
    ? await ctx.stores.organizationMemberships.find(tenant, legacy.principalId)
    : undefined;
  // Legacy rows predate tenant-scoped keys. Accept one only for the SAML
  // tenant that actually owns this entityID (not an organization that merely
  // names it as an OIDC issuer) and only if the principal is already a member.
  const legacyAllowed =
    legacyOrganization?.samlIssuer === issuer && legacyMembership !== undefined;
  const resolved = existing ?? (legacyAllowed ? legacy : null);

  let principalId: string;
  let sessionToken: string | undefined;
  if (resolved) {
    const principal = await ctx.repos.principals.getById(resolved.principalId);
    if (
      !principal ||
      principal.state === "suspended" ||
      principal.state === "closed"
    ) {
      return {
        ok: false,
        status: 403,
        message: "This account is not able to sign in.",
      };
    }
    principalId = resolved.principalId;
  } else {
    if (!consumeSamlMintBudget(tenant, ctx.clock().getTime())) {
      return { ok: false, status: 429, message: "rate_limited" };
    }
    const fingerprint = createHash("sha256")
      .update(tenant)
      .update("|")
      .update(input.interactionUid ?? "")
      .update("|")
      .update(input.remoteAddress ?? input.userAgent)
      .digest("hex")
      .slice(0, 16);
    let minted: { principalId: string; accessToken: string };
    try {
      minted = await mintProvisionalForInteraction(
        ctx,
        fingerprint,
        input.correlationId,
        {
          quotaProfile: `saml:${tenant}`,
          maxLiveForProfile: 128,
          profilePrefix: "saml:",
          maxLiveForProfilePrefix: 256,
        },
      );
    } catch (error) {
      if (error instanceof ProvisionalMintRefusedError) {
        return { ok: false, status: 429, message: error.code };
      }
      throw error;
    }
    const displayHint = input.result.name ?? input.result.email;
    /*
     * SAML defines nothing like OIDC's `email_verified`, so the assertion
     * cannot say whether anyone checked this address. What it does have is
     * provenance: the attribute was set by the tenant's own IdP, in an
     * assertion this server verified the signature of, not typed by whoever is
     * signing in. That is enough exactly where the organization has proved it
     * controls the domain — the same DNS-TXT rule the directory leg uses, and
     * for the same reason (see `organizationAssertedEmailIsVerified`).
     *
     * Everything else stays a display hint: `emailNormalized` is only set
     * alongside a true `emailVerified`, so an unproven address cannot become
     * an ADR 0057 auto-link key by any path.
     */
    const emailNormalized = input.result.email?.trim().toLowerCase();
    const emailVerified = await organizationAssertedEmailIsVerified(
      ctx,
      input.result.organizationId,
      emailNormalized,
    );
    const attached = await attachVerifiedExternalIdentity(
      ctx,
      minted.principalId,
      {
        kind: "saml",
        issuer,
        tenant,
        subject: input.result.subject,
        correlationId: input.correlationId,
        // The NameID Format is provenance, not a claim about the human: it is
        // what tells a later reader whether this subject is a stable opaque
        // identifier or an address the IdP happened to spell as one.
        metadata: { nameIdFormat: input.result.nameIdFormat },
        ...(displayHint !== undefined ? { displayHint } : undefined),
        ...(emailVerified && emailNormalized !== undefined
          ? { emailNormalized, emailVerified: true }
          : undefined),
      },
    );
    if (!attached.ok) {
      return { ok: false, status: 409, message: attached.message };
    }
    principalId = attached.identity.principalId;
    await ensurePersonalOnAuthenticatedSession(
      ctx,
      principalId,
      input.correlationId,
    );
    if (principalId === minted.principalId) {
      sessionToken = minted.accessToken;
    }
  }

  const organization = await ctx.stores.organizations.get(
    input.result.organizationId,
  );
  if (organization) {
    // The directory's Groups push, where there is one, names the role this
    // subject joins at; without one `jitJoinOrganization` falls back to
    // `member` as it always has (C15).
    const role = await provisionedRoleForSubject(
      ctx,
      organization.id,
      input.result.subject,
    );
    const joined = await jitJoinOrganization(ctx, {
      organization,
      principalId,
      subject: input.result.subject,
      method: "saml",
      correlationId: input.correlationId,
      ...(role !== undefined ? { role } : undefined),
    });
    if (!joined.ok) {
      return { ok: false, status: 403, message: joined.message };
    }
  }

  return {
    ok: true,
    principalId,
    issuer,
    ...(sessionToken !== undefined ? { sessionToken } : undefined),
  };
}

/** IdP-initiated sign-in is worth its own trail entry (D10). */
export async function auditIdpInitiated(
  ctx: AppContext,
  input: {
    principalId: string;
    result: SamlAssertionResult;
    issuer: string;
    correlationId: string;
  },
): Promise<void> {
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "principal.saml_idp_initiated",
    outcome: "succeeded",
    principalId: input.principalId,
    organizationId: input.result.organizationId,
    correlationId: input.correlationId,
    metadata: {
      action: "saml.idp_initiated",
      kind: "saml",
      issuer: input.issuer,
      via: "saml_assertion",
    },
  });
}
