/**
 * Organization sign-in settings (D14; ADR 0140 plan step 6): what
 * `apps/console/src/pages/OrgSignInPage.tsx` did in its component, as a
 * model. Three things an organization's owner configures and nobody else
 * can: the upstream their people sign in through (an OIDC issuer, or SAML),
 * the email domains that route work addresses to the organization, and the
 * provisioning token their directory pushes users with. Plan step 12 draws
 * it in Identity › Organizations.
 *
 * This is configuration, not a sign-in leg: nothing here starts an OIDC
 * redirect, touches the session or its exit, or speaks Shoo's dialect.
 *
 * Two values are sharp, and neither is ever read back:
 *   - the upstream's client secret is write-only. The form never seeds it
 *     from the server, and an empty box means "leave the stored one alone" —
 *     the patch omits the key rather than sending null, which would
 *     unconfigure the tenant every time an owner edited another field;
 *   - a provisioning token exists in plaintext exactly once, in the answer
 *     that minted it. `mintToken` hands it to the caller and keeps no copy:
 *     no storage, no URL, no list — the token list carries ids and dates.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { identityBase, identityFetch } from "./identity.js";

export interface OrgSignInTransport {
  /** An Identity API call; `path` is relative to the configured base. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  /** The Identity API's base, for the redirect URI an owner registers. */
  base(): string;
}

export const identityOrgSignInTransport: OrgSignInTransport = {
  fetch: (path, init) => identityFetch(path, init),
  base: () => identityBase(),
};

/** What an owner edits. The secret starts empty and is never seeded. */
export type UpstreamForm = {
  ssoIssuer: string;
  ssoClientId: string;
  ssoClientSecret: string;
  samlIssuer: string;
  samlMetadataUrl: string;
};

export type OrgSignInOrganization = {
  id: string;
  slug: string;
  displayName: string;
  role: string;
  /** Only an owner may read or change any of this. */
  owner: boolean;
  /** Whether a client secret is stored; the value itself is write-only. */
  secretStored: boolean;
  upstream: UpstreamForm;
};

export type EmailDomainRow = {
  domain: string;
  /** The TXT record to publish before verifying. */
  txtRecord: string;
  verifiedAt: string | null;
};

export type ScimTokenRow = { id: string; createdAt: string; revoked: boolean };

/** A freshly minted token: shown once by whoever holds this, then dropped. */
export type MintedScimToken = { id: string; token: string };

const WORDS: Readonly<Record<string, string>> = {
  unauthorized: "Sign in again as an owner to configure organization sign-in.",
  owner_required:
    "Only an owner of this organization can change these settings.",
  not_found:
    "Identity does not know that organization, domain or token — it may already be gone. Reload and try again.",
  domain_taken: "That domain is already claimed by another organization.",
  verification_failed:
    "The expected TXT record was not found for that domain. Publish it, give DNS a moment, then verify again.",
  unsafe_issuer: "That issuer is not an address this deployment may call.",
  validation_error:
    "That was refused as malformed. Check the values and try again.",
  unreachable: "The sign-in service could not be reached. Nothing changed.",
  empty_domain: "Type the domain to claim, such as acme.example.",
  malformed:
    "The sign-in service answered in a shape this page cannot read. Nothing was assumed from it.",
  not_owner: "Only an owner of this organization can change these settings.",
};

/** Codes whose server message names the exact problem, and is shown. */
const SAYS_WHICH = new Set(["unsafe_issuer", "validation_error"]);

const BY_STATUS: Readonly<Record<number, string>> = {
  0: "unreachable",
  400: "validation_error",
  401: "unauthorized",
  403: "owner_required",
  404: "not_found",
};

function wordsFor(code: string): string | undefined {
  return Object.hasOwn(WORDS, code) ? WORDS[code] : undefined;
}

/** A refused call, worded by the body's code first, then the status. */
export class OrgSignInError extends Error {
  readonly status: number;
  readonly declared: string;
  constructor(status: number, declared: string, detail: string | null = null) {
    const code = wordsFor(declared) ? declared : (BY_STATUS[status] ?? "");
    const said = SAYS_WHICH.has(code) && detail ? detail : wordsFor(code);
    super(said ?? `That did not go through (${status}). Nothing changed.`);
    this.name = "OrgSignInError";
    this.status = status;
    this.declared = declared;
  }
}

const text = (value: BoundaryValue): string => (isString(value) ? value : "");

function organizationOf(value: BoundaryValue): OrgSignInOrganization | null {
  if (!isJsonObject(value) || !isString(value.id)) return null;
  const role = text(value.role);
  return {
    id: value.id,
    slug: text(value.slug),
    displayName: text(value.displayName) || text(value.slug),
    role,
    owner: role === "owner",
    secretStored: value.ssoClientSecretConfigured === true,
    upstream: {
      ssoIssuer: text(value.ssoIssuer),
      ssoClientId: text(value.ssoClientId),
      ssoClientSecret: "",
      samlIssuer: text(value.samlIssuer),
      samlMetadataUrl: text(value.samlMetadataUrl),
    },
  };
}

function domainOf(value: BoundaryValue): EmailDomainRow | null {
  if (!isJsonObject(value) || !isString(value.domain)) return null;
  return {
    domain: value.domain,
    txtRecord: text(value.txtRecord),
    verifiedAt: isString(value.verifiedAt) ? value.verifiedAt : null,
  };
}

function tokenOf(value: BoundaryValue): ScimTokenRow | null {
  if (!isJsonObject(value) || !isString(value.id)) return null;
  return {
    id: value.id,
    createdAt: text(value.createdAt),
    revoked: isString(value.revokedAt),
  };
}

function listOf<T>(
  value: BoundaryValue,
  read: (entry: BoundaryValue) => T | null,
) {
  const rows: T[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const row = read(entry);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * The PATCH body for an upstream form. An empty field clears its value; an
 * empty secret or metadata address is left out, so a save that only edits
 * the issuer drops nothing the owner cannot re-read.
 */
export function upstreamPatch(form: UpstreamForm): JsonObject {
  const secret = form.ssoClientSecret.trim();
  const metadata = form.samlMetadataUrl.trim();
  return {
    ssoIssuer: form.ssoIssuer.trim() || null,
    ssoClientId: form.ssoClientId.trim() || null,
    ...(secret ? { ssoClientSecret: secret } : {}),
    samlIssuer: form.samlIssuer.trim() || null,
    ...(metadata ? { samlMetadataUrl: metadata } : {}),
  };
}

/** The one redirect URI an owner registers at their provider. */
export function federatedRedirectUri(base: string): string {
  return `${base.replace(/\/$/, "")}/v1/federated/callback`;
}

type Call = (path: string, init: RequestInit) => Promise<BoundaryValue>;

function caller(transport: OrgSignInTransport): Call {
  return async (path, init) => {
    let res: Response;
    try {
      res = await transport.fetch(path, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
    } catch {
      throw new OrgSignInError(0, "");
    }
    // 204 is what a revoke and a release answer, and it carries no body.
    const body: BoundaryValue =
      res.status === 204 ? null : await res.json().catch(() => null);
    if (res.ok) return body;
    const read: JsonObject = isJsonObject(body) ? body : {};
    const detail = isString(read.message) ? read.message : null;
    throw new OrgSignInError(res.status, text(read.error), detail);
  };
}

const at = (org: OrgSignInOrganization, tail = "") =>
  `/v1/organizations/${encodeURIComponent(org.id)}${tail}`;

/** Every write is an owner's; a member is refused before any call. */
function owned(org: OrgSignInOrganization): void {
  if (!org.owner) throw new OrgSignInError(403, "not_owner");
}

/** The session's organizations and an owner's upstream. */
function upstreams(call: Call, transport: OrgSignInTransport) {
  return {
    redirectUri: () => federatedRedirectUri(transport.base()),
    async listOrganizations(): Promise<OrgSignInOrganization[]> {
      const body = await call("/v1/organizations", { method: "GET" });
      return listOf(
        isJsonObject(body) ? body.organizations : null,
        organizationOf,
      );
    },
    async saveUpstream(
      org: OrgSignInOrganization,
      form: UpstreamForm,
    ): Promise<string> {
      owned(org);
      await call(at(org), {
        method: "PATCH",
        body: JSON.stringify(upstreamPatch(form)),
      });
      return "Organization sign-in saved.";
    },
  };
}

/** Email domains: claim, verify, release. */
function domains(call: Call) {
  return {
    async listDomains(org: OrgSignInOrganization): Promise<EmailDomainRow[]> {
      owned(org);
      const body = await call(at(org, "/domains"), { method: "GET" });
      return listOf(isJsonObject(body) ? body.domains : null, domainOf);
    },
    async claimDomain(
      org: OrgSignInOrganization,
      domain: string,
    ): Promise<{ row: EmailDomainRow; words: string }> {
      owned(org);
      const typed = domain.trim();
      if (!typed) throw new OrgSignInError(400, "empty_domain");
      const row = domainOf(
        await call(at(org, "/domains"), {
          method: "POST",
          body: JSON.stringify({ domain: typed }),
        }),
      );
      if (!row) throw new OrgSignInError(200, "malformed");
      return {
        row,
        words: `Publish the TXT record for ${row.domain}, then verify it.`,
      };
    },
    async verifyDomain(
      org: OrgSignInOrganization,
      domain: string,
    ): Promise<{ row: EmailDomainRow; words: string }> {
      owned(org);
      const path = at(org, `/domains/${encodeURIComponent(domain)}/verify`);
      const row = domainOf(await call(path, { method: "POST" }));
      if (!row) throw new OrgSignInError(200, "malformed");
      return { row, words: `${row.domain} is verified.` };
    },
    async releaseDomain(
      org: OrgSignInOrganization,
      domain: string,
    ): Promise<string> {
      owned(org);
      const path = at(org, `/domains/${encodeURIComponent(domain)}`);
      await call(path, { method: "DELETE" });
      return `${domain} released.`;
    },
  };
}

/** SCIM provisioning tokens: the plaintext once, then ids and dates. */
function tokens(call: Call) {
  return {
    async listTokens(org: OrgSignInOrganization): Promise<ScimTokenRow[]> {
      owned(org);
      const body = await call(at(org, "/scim/tokens"), { method: "GET" });
      return listOf(isJsonObject(body) ? body.tokens : null, tokenOf);
    },
    /** The plaintext, once. Nothing here stores it. */
    async mintToken(org: OrgSignInOrganization): Promise<MintedScimToken> {
      owned(org);
      const body = await call(at(org, "/scim/tokens"), { method: "POST" });
      const read: JsonObject = isJsonObject(body) ? body : {};
      if (!isString(read.id) || !isString(read.token)) {
        throw new OrgSignInError(200, "malformed");
      }
      return { id: read.id, token: read.token };
    },
    async revokeToken(
      org: OrgSignInOrganization,
      tokenId: string,
    ): Promise<string> {
      owned(org);
      const path = at(org, `/scim/tokens/${encodeURIComponent(tokenId)}`);
      await call(path, { method: "DELETE" });
      return "Provisioning token revoked.";
    },
  };
}

export function orgSignInClient(
  transport: OrgSignInTransport = identityOrgSignInTransport,
) {
  const call = caller(transport);
  return {
    ...upstreams(call, transport),
    ...domains(call),
    ...tokens(call),
  };
}

export type OrgSignInClient = ReturnType<typeof orgSignInClient>;
