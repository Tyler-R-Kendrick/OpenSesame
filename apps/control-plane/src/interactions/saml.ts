import { createHash, randomBytes } from "node:crypto";
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
import { parseDomFromString, xpath } from "@node-saml/node-saml/lib/xml.js";
import { appendAuditEvent } from "@opensesame/audit";
import {
  UnsafeMetadataUrlError,
  assertSafeMetadataUrl,
} from "@opensesame/oauth-provider";
import type { Organization } from "@opensesame/os-domain";
import type { ControlPlaneConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { jitJoinOrganization, usesNativeSaml } from "../routes/organizations.js";
import { ensurePersonalOnAuthenticatedSession } from "../routes/projects.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import {
  ProvisionalMintRefusedError,
  mintProvisionalForInteraction,
} from "./handlers.js";

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
const COMPLETION_CODE_TTL_MS = 2 * 60 * 1000;

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

export type SamlAuthErrorCode =
  | "not_configured"
  | "metadata_unavailable"
  | "unknown_request"
  | "invalid_assertion"
  | "replayed_assertion";

export class SamlAuthError extends Error {
  constructor(
    readonly code: SamlAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SamlAuthError";
  }
}

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
export function samlServiceProviderMetadata(config: ControlPlaneConfig): string {
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
 * Process-local on purpose. The two durable halves of the flow — the
 * request→interaction binding and assertion replay refusal — live in
 * `ctx.stores.saml`, which is Postgres-backed wherever a database is
 * configured. What lives here is the few seconds between a 303 and the GET it
 * provokes, for one browser; it is single-use, short-lived, and carries no
 * authority of its own beyond naming an assertion this process just verified.
 */
const completionCodes = new Map<
  string,
  { completion: SamlCompletion; expiresAt: number }
>();

export function resetSamlCompletionCodes(): void {
  completionCodes.clear();
}

function issueCompletionCode(
  completion: SamlCompletion,
  now: number,
): string {
  for (const [code, entry] of completionCodes) {
    if (entry.expiresAt <= now) completionCodes.delete(code);
  }
  const code = randomBytes(32).toString("base64url");
  completionCodes.set(code, {
    completion,
    expiresAt: now + COMPLETION_CODE_TTL_MS,
  });
  return code;
}

/** Single-use: the read that finds a code consumes it. */
export function takeSamlCompletion(
  code: string | undefined,
  now: number,
): SamlCompletion | undefined {
  if (!code) return undefined;
  const entry = completionCodes.get(code);
  if (!entry) return undefined;
  completionCodes.delete(code);
  if (entry.expiresAt <= now) return undefined;
  return entry.completion;
}

function pemFromBase64(certificate: string): string {
  const body = certificate.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * Fetch a tenant-supplied metadata URL under the network fence.
 *
 * Same posture as the org-assertion leg: `assertSafeMetadataUrl` refuses
 * private, loopback, link-local and cloud-metadata targets (T21), redirects
 * are refused rather than followed — a 302 to `169.254.169.254` would
 * otherwise walk straight past a guard that only ever saw the first URL — and
 * the private-host half is relaxed only under dev defaults, where the
 * reference IdP and the dev stack live on loopback.
 */
async function fetchMetadataDocument(
  ctx: AppContext,
  rawUrl: string,
): Promise<string> {
  let url: URL;
  try {
    url = ctx.config.allowDevDefaults
      ? new URL(rawUrl)
      : assertSafeMetadataUrl(rawUrl);
  } catch (error) {
    if (error instanceof UnsafeMetadataUrlError) {
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
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(METADATA_FETCH_MS),
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

async function parseIdpMetadata(xml: string): Promise<ResolvedIdpMetadata> {
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
        "//*[local-name()='IDPSSODescriptor']/*[local-name()='SingleSignOnService']" +
          `[@Binding='${BINDING_REDIRECT}']/@Location`,
      )
      .at(0)?.nodeValue ?? "";
  if (entityId.length === 0 || certificates.length === 0) {
    throw new SamlAuthError(
      "metadata_unavailable",
      "The organization's SAML metadata declares no entityID or signing certificate.",
    );
  }
  return { entityId, ssoUrl, certificates };
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

  const xml = cfg.metadataXml ?? (await fetchMetadataDocument(ctx, cfg.metadataUrl ?? ""));
  const resolved = await parseIdpMetadata(xml);
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
): Promise<{ redirectUrl: string; requestId: string }> {
  const metadata = await resolveIdpMetadata(ctx, org);
  if (metadata.ssoUrl.length === 0) {
    throw new SamlAuthError(
      "metadata_unavailable",
      "The organization's SAML metadata publishes no HTTP-Redirect sign-on endpoint.",
    );
  }
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
    xpath
      .selectAttributes(doc, "/*[local-name()='Assertion']/@ID")
      .at(0)?.nodeValue ?? "";
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
  const notOnOrAfter = notOnOrAfterRaw
    ? new Date(notOnOrAfterRaw)
    : undefined;
  return {
    assertionId,
    ...(notOnOrAfter && !Number.isNaN(notOnOrAfter.getTime())
      ? { notOnOrAfter }
      : undefined),
    ...(subjectInResponseTo ? { subjectInResponseTo } : undefined),
  };
}

function firstAttribute(
  profile: Record<string, unknown>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = profile[name];
    if (typeof value === "string" && value.length > 0) return value;
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === "string" && v.length > 0);
      if (typeof first === "string") return first;
    }
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
 * second, which is precisely why both are asked.
 */
export function samlRelayPath(
  config: ControlPlaneConfig,
  relayState: string | undefined,
): string {
  if (!relayState || !relayState.startsWith("/")) {
    if (!relayState || !/^https?:\/\//i.test(relayState)) return "/";
  }
  let target: URL;
  try {
    target = new URL(relayState, `${baseUrl(config)}/`);
  } catch {
    return "/";
  }
  if (target.origin !== new URL(baseUrl(config)).origin) return "/";
  return `${target.pathname}${target.search}`;
}

async function readResponseRouting(
  samlResponse: string,
): Promise<{ inResponseTo?: string; issuer?: string }> {
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
    .selectElements(
      doc,
      "/*[local-name()='Response']/*[local-name()='Issuer']",
    )
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
export async function completeSamlResponse(
  ctx: AppContext,
  body: { SAMLResponse: string; RelayState?: string },
): Promise<SamlResponseOutcome> {
  const routing = await readResponseRouting(body.SAMLResponse);

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

  const cfg = organization ? samlOrgConfig(organization) : undefined;
  if (!cfg) {
    throw new SamlAuthError(
      "not_configured",
      "No organization on this server accepts that identity provider.",
    );
  }

  const metadata = await resolveIdpMetadata(ctx, cfg);
  const client = buildSamlClient(ctx, metadata);
  let profile: Record<string, unknown> | null;
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

  const assertionXml =
    typeof profile.getAssertionXml === "function"
      ? profile.getAssertionXml()
      : "";
  if (typeof assertionXml !== "string" || assertionXml.length === 0) {
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

  const nameId = typeof profile.nameID === "string" ? profile.nameID : "";
  if (nameId.length === 0) {
    throw new SamlAuthError(
      "invalid_assertion",
      "That sign-in could not be completed.",
    );
  }
  const email = firstAttribute(profile, [
    ATTR_EMAIL_OID,
    ATTR_EMAIL_CLAIM,
    ...ATTR_EMAIL_FRIENDLY,
  ]);
  const name = firstAttribute(profile, [
    ATTR_NAME_OID,
    ATTR_NAME_CLAIM,
    ...ATTR_NAME_FRIENDLY,
  ]);
  const result: SamlAssertionResult = {
    subject: nameId,
    nameIdFormat:
      typeof profile.nameIDFormat === "string"
        ? profile.nameIDFormat
        : NAMEID_FORMAT_PERSISTENT,
    organizationId: cfg.organizationId,
    ...(email !== undefined ? { email } : undefined),
    ...(name !== undefined ? { name } : undefined),
  };

  if (interactionUid !== undefined) {
    return {
      flow: "sp",
      interactionUid,
      result,
      completionCode: issueCompletionCode(
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

  const existing = await ctx.repos.externalIdentities.findByTuple({
    kind: "saml",
    issuer,
    subject: input.result.subject,
  });

  let principalId: string;
  let sessionToken: string | undefined;
  if (existing) {
    const principal = await ctx.repos.principals.getById(existing.principalId);
    if (principal && principal.state !== "active") {
      return {
        ok: false,
        status: 403,
        message: "This account is not able to sign in.",
      };
    }
    principalId = existing.principalId;
  } else {
    const fingerprint = createHash("sha256")
      .update(input.userAgent)
      .update("|")
      .update(ctx.config.publicUrl)
      .digest("hex")
      .slice(0, 16);
    let minted: { principalId: string; accessToken: string };
    try {
      minted = await mintProvisionalForInteraction(
        ctx,
        fingerprint,
        input.correlationId,
      );
    } catch (error) {
      if (error instanceof ProvisionalMintRefusedError) {
        return { ok: false, status: 429, message: error.code };
      }
      throw error;
    }
    const attached = await attachVerifiedExternalIdentity(
      ctx,
      minted.principalId,
      {
        kind: "saml",
        issuer,
        subject: input.result.subject,
        correlationId: input.correlationId,
        // The NameID Format is provenance, not a claim about the human: it is
        // what tells a later reader whether this subject is a stable opaque
        // identifier or an address the IdP happened to spell as one.
        metadata: { nameIdFormat: input.result.nameIdFormat },
        // Display only (C14). A SAML attribute carries no verification signal,
        // so `email` never reaches `emailNormalized` and can never become the
        // ADR 0057 auto-link key.
        ...(input.result.name ?? input.result.email
          ? {
              displayHint: (input.result.name ??
                input.result.email) as string,
            }
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
    const joined = await jitJoinOrganization(ctx, {
      organization,
      principalId,
      subject: input.result.subject,
      method: "saml",
      correlationId: input.correlationId,
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

/**
 * The issuer recorded on a SAML identity row is the IdP's entityID, resolved
 * from the tenant's configuration rather than from the assertion — the row has
 * to name what this deployment trusts, not what the document claimed.
 */
async function issuerForResult(
  ctx: AppContext,
  result: SamlAssertionResult,
): Promise<string | undefined> {
  const organization = await ctx.stores.organizations.get(
    result.organizationId,
  );
  const cfg = organization ? samlOrgConfig(organization) : undefined;
  if (!cfg) return undefined;
  if (cfg.idpEntityId.length > 0) return cfg.idpEntityId;
  try {
    return (await resolveIdpMetadata(ctx, cfg)).entityId;
  } catch {
    return undefined;
  }
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
