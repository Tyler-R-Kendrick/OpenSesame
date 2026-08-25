import { appendAuditEvent } from "@opensesame/audit";
import {
  UnsafeMetadataUrlError,
  assertSafeMetadataUrl,
} from "@opensesame/oauth-provider";
import {
  type OrgLdapConfig,
  type OrganizationRole,
  isString,
} from "@opensesame/os-domain";
import { Client, type Entry, escapeFilter } from "ldapts";
import type { AppContext } from "../context.js";
import { revokeOrganizationMembership } from "../routes/organizations.js";

/**
 * Native LDAP: a real bind, and the pull twin of SCIM (ADR 0057, C21/D17).
 *
 * ADR 0016 said OpenSesame would never speak LDAP and would broker directories
 * through an external Keycloak. That half is superseded: an organization can
 * now name its own directory and this module authenticates against it with a
 * real bind over `ldapts`, then hands the result to the same find-or-mint and
 * JIT-join path every other leg uses.
 *
 * Three rules govern everything below.
 *
 * 1. **The subject is the configured stable attribute, never the DN.** A DN
 *    moves the day someone changes department (`ou=sales` → `ou=support`), and
 *    a subject that moves is a new account for the same human — or, worse, an
 *    old account inherited by whoever next occupies that DN. `entryUUID` /
 *    `objectGUID` do not move (T34).
 * 2. **Failure is uniform.** A wrong password, an unknown user, an ambiguous
 *    match and a directory that refuses to answer all produce `{ ok: false }`
 *    with nothing to tell them apart — not the message, not the shape, and as
 *    far as is cheaply achievable not the timing either. The login form is
 *    unauthenticated, so any difference is a user-existence oracle for the
 *    whole company directory.
 * 3. **The password is a parameter and nothing else.** It is never stored,
 *    never logged, never audited, and never placed in an error. The only thing
 *    that ever holds it is the bind request on the wire.
 */

/** Directory round-trips are interactive; five seconds is already generous. */
const LDAP_TIMEOUT_MS = 5_000;

/** A username longer than this is not a username. */
const MAX_USERNAME_LENGTH = 256;

/** Bound so one sync pass cannot pull an unbounded directory into memory. */
const SYNC_PAGE_LIMIT = 5_000;

export type LdapBoundIdentity = {
  ok: true;
  /** The configured stable attribute — never the DN. */
  subject: string;
  email?: string;
  name?: string;
  /** Group DNs the entry claims, verbatim from the directory. */
  groups: string[];
};

export type LdapBindResult = LdapBoundIdentity | { ok: false };

export type LdapSyncSummary = {
  scanned: number;
  joined: number;
  deactivated: number;
};

export type LdapConfigurationErrorCode =
  | "invalid_url"
  | "tls_required"
  | "unsafe_host"
  | "incomplete";

/**
 * The org's configuration cannot be used as it stands.
 *
 * Separate from a failed bind on purpose: this is an operator mistake the
 * owner has to fix, not an authentication outcome, and the login route must
 * not report it through the same uniform "invalid credentials" answer.
 */
export class LdapConfigurationError extends Error {
  override readonly name = "LdapConfigurationError";
  readonly code: LdapConfigurationErrorCode;

  constructor(code: LdapConfigurationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * RFC 4515 filter escaping, from the library rather than by hand (ADR 0008).
 * `escapeFilter` is a tagged template; interpolating the value alone yields the
 * escaped value, which is what a `{username}` substitution needs.
 */
function escapeFilterValue(value: string): string {
  return escapeFilter`${value}`;
}

/**
 * RFC 4514 §2.4 escaping for one attribute value inside a DN.
 *
 * `=` is deliberately NOT escaped: it is not in the RFC's escapable set and
 * strict DN parsers reject `\=`.
 */
function escapeDnValue(value: string): string {
  let escaped = "";
  for (const char of value) {
    if (
      char === "\\" ||
      char === "," ||
      char === "+" ||
      char === '"' ||
      char === "<" ||
      char === ">" ||
      char === ";"
    ) {
      escaped += `\\${char}`;
    } else if (char === "\0") {
      escaped += "\\00";
    } else {
      escaped += char;
    }
  }
  return escaped.replace(/^#/, "\\#").replace(/^ /, "\\ ").replace(/ $/, "\\ ");
}

/**
 * The identity-plane issuer for a directory: scheme, host and port of its URL.
 *
 * Path and query are dropped so two configurations of the same directory
 * cannot mint two issuers for the same people, and so the value is stable
 * enough to be half of an `external_identities` tuple forever.
 */
export function ldapIssuer(config: OrgLdapConfig): string {
  const url = parseLdapUrl(config.url);
  return `${url.protocol}//${url.host}`;
}

function parseLdapUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LdapConfigurationError(
      "invalid_url",
      "Directory URL is not a valid URL",
    );
  }
  if (url.protocol !== "ldap:" && url.protocol !== "ldaps:") {
    throw new LdapConfigurationError(
      "invalid_url",
      "Directory URL must use ldap:// or ldaps://",
    );
  }
  return url;
}

/**
 * Refuse a configuration this deployment must not bind against (D17, T21).
 *
 * Two fences, both of which an org owner can otherwise walk around:
 *
 * - **TLS.** `ldap://` puts the user's password on the wire in the clear. It
 *   is allowed only under `allowDevDefaults`, which is where the reference
 *   directory runs.
 * - **The private-host guard.** The owner is trusted with their own tenant,
 *   not with this server's network position: without this, `ldap://169.254.169.254`
 *   turns "configure our directory" into an SSRF gadget against the cloud
 *   metadata endpoint. The guard is `assertSafeMetadataUrl` (T21 — reused, not
 *   reinvented); it speaks http/https, so the LDAP URL is mapped scheme-for-
 *   scheme onto it and only the host is being judged.
 */
export function assertUsableLdapConfig(
  ctx: AppContext,
  config: OrgLdapConfig,
): void {
  const url = parseLdapUrl(config.url);
  const dev = ctx.config.allowDevDefaults;

  if (url.protocol === "ldap:" && !dev) {
    throw new LdapConfigurationError(
      "tls_required",
      "Directory URL must use ldaps:// — plain ldap:// sends the password in the clear",
    );
  }
  if (!dev) {
    const asHttp = new URL(url.href);
    asHttp.protocol = url.protocol === "ldaps:" ? "https:" : "http:";
    try {
      assertSafeMetadataUrl(asHttp.href);
    } catch (error) {
      if (error instanceof UnsafeMetadataUrlError) {
        throw new LdapConfigurationError("unsafe_host", error.message);
      }
      throw error;
    }
  }

  if (config.bindMode === "bind_template") {
    if (!config.bindTemplate?.includes("{username}")) {
      throw new LdapConfigurationError(
        "incomplete",
        "bind_template mode needs a bindTemplate containing {username}",
      );
    }
    return;
  }
  if (
    !config.searchBaseDn ||
    !config.searchFilter?.includes("{username}") ||
    !config.serviceBindDn ||
    !config.serviceBindSecret
  ) {
    throw new LdapConfigurationError(
      "incomplete",
      "search_bind mode needs searchBaseDn, a searchFilter containing {username}, serviceBindDn and serviceBindSecret",
    );
  }
}

/** Directory values arrive as strings, Buffers, or arrays of either. */
function readAttribute(entry: Entry, attribute: string): string[] {
  const raw = entry[attribute];
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const value of values) {
    if (isString(value)) {
      if (value.length > 0) out.push(value);
      continue;
    }
    // Binary attributes (`objectGUID` on Active Directory is a raw 16-byte
    // GUID) arrive as Buffers. Base64url keeps them a stable, printable
    // subject rather than a lossy utf-8 decode of arbitrary bytes.
    if (value.length > 0) out.push(Buffer.from(value).toString("base64url"));
  }
  return out;
}

function firstAttribute(
  entry: Entry,
  attribute: string | undefined,
): string | undefined {
  if (!attribute) return undefined;
  return readAttribute(entry, attribute)[0];
}

/**
 * The attributes worth asking for. Explicit rather than `*`: a directory entry
 * can carry photographs and certificates, and none of it belongs in this
 * server's memory.
 */
function requestedAttributes(config: OrgLdapConfig): string[] {
  const attributes = new Set<string>([config.subjectAttribute, "memberOf"]);
  if (config.attributeMap.email) attributes.add(config.attributeMap.email);
  if (config.attributeMap.name) attributes.add(config.attributeMap.name);
  return [...attributes];
}

function identityFromEntry(
  config: OrgLdapConfig,
  entry: Entry,
): LdapBoundIdentity | undefined {
  // Never the DN (T34): `entry.dn` is deliberately not consulted here. An
  // entry with no stable attribute is not admitted at all — falling back to
  // the DN is precisely the mistake this rule exists to prevent.
  const subject = readAttribute(entry, config.subjectAttribute)[0];
  if (!subject) return undefined;
  const email = firstAttribute(entry, config.attributeMap.email);
  const name = firstAttribute(entry, config.attributeMap.name);
  return {
    ok: true,
    subject,
    groups: readAttribute(entry, "memberOf"),
    ...(email !== undefined ? { email: email.toLowerCase() } : undefined),
    ...(name !== undefined ? { name } : undefined),
  };
}

/**
 * The role a member's groups earn, or `undefined` when none of them do.
 *
 * A group matches by full DN or by the value of its first RDN, both
 * case-insensitively, because `cn=engineers,ou=groups,dc=acme,dc=com` and
 * `engineers` are the same group and an operator will write either. The
 * strongest match wins: somebody in both the admins group and the everyone
 * group is an owner, never demoted by alphabetical accident.
 */
export function roleForGroups(
  config: OrgLdapConfig,
  groups: readonly string[],
): OrganizationRole | undefined {
  const ranked: OrganizationRole[] = ["owner", "admin", "member"];
  const claimed = new Set<string>();
  for (const group of groups) {
    const normalized = group.trim().toLowerCase();
    claimed.add(normalized);
    const rdn = normalized.split(",")[0] ?? "";
    const value = rdn.slice(rdn.indexOf("=") + 1);
    if (value) claimed.add(value);
  }
  let best: OrganizationRole | undefined;
  for (const [group, role] of Object.entries(config.groupRoleMap)) {
    const key = group.trim().toLowerCase();
    const rdn = key.split(",")[0] ?? "";
    if (!claimed.has(key) && !claimed.has(rdn.slice(rdn.indexOf("=") + 1))) {
      continue;
    }
    if (!best || ranked.indexOf(role) < ranked.indexOf(best)) best = role;
  }
  return best;
}

function createClient(config: OrgLdapConfig): Client {
  return new Client({
    url: config.url,
    timeout: LDAP_TIMEOUT_MS,
    connectTimeout: LDAP_TIMEOUT_MS,
  });
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.unbind();
  } catch {
    // An unbind that fails has nothing left to protect: the socket is going
    // away either way, and a throw here would turn a successful sign-in into
    // an error.
  }
}

/**
 * A bind that is expected to fail, run purely so that a username the directory
 * does not know costs the same as one it does.
 *
 * Without it, `search_bind` answers "no such user" without ever contacting the
 * bind machinery and answers "wrong password" only after a full round-trip:
 * the difference is measurable from the login form, and it enumerates the
 * company directory. This is the cheap, honest mitigation — not constant time,
 * but the same operations in the same order.
 */
async function equalizeFailedBind(
  config: OrgLdapConfig,
  password: string,
): Promise<void> {
  const client = createClient(config);
  try {
    const base = config.searchBaseDn ?? "";
    await client.bind(`cn=${escapeDnValue(" absent")},${base}`, password);
  } catch {
    // Expected: this DN does not exist. The point is the round-trip.
  } finally {
    await closeQuietly(client);
  }
}

/** Reject input that cannot be a username before it reaches the wire. */
function usableUsername(username: string): string | undefined {
  const trimmed = username.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_USERNAME_LENGTH) {
    return undefined;
  }
  // Control bytes are refused rather than escaped: NUL truncates string
  // handling inside some directory implementations, and nothing legitimate
  // carries one.
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return trimmed;
}

async function bindByTemplate(
  config: OrgLdapConfig,
  username: string,
  password: string,
): Promise<Entry | undefined> {
  const dn = (config.bindTemplate ?? "").replaceAll(
    "{username}",
    escapeDnValue(username),
  );
  const client = createClient(config);
  try {
    await client.bind(dn, password);
    const result = await client.search(dn, {
      scope: "base",
      filter: "(objectClass=*)",
      attributes: requestedAttributes(config),
    });
    return result.searchEntries[0];
  } finally {
    await closeQuietly(client);
  }
}

async function bindBySearch(
  config: OrgLdapConfig,
  username: string,
  password: string,
): Promise<Entry | undefined> {
  const service = createClient(config);
  let found: Entry | undefined;
  try {
    await service.bind(config.serviceBindDn ?? "", config.serviceBindSecret);
    const result = await service.search(config.searchBaseDn ?? "", {
      scope: "sub",
      filter: (config.searchFilter ?? "").replaceAll(
        "{username}",
        escapeFilterValue(username),
      ),
      // Two, not one: an ambiguous match must be *observed* and refused, not
      // silently resolved to whichever entry the directory returned first.
      sizeLimit: 2,
      attributes: requestedAttributes(config),
    });
    if (result.searchEntries.length === 1) found = result.searchEntries[0];
  } finally {
    await closeQuietly(service);
  }

  if (!found) {
    await equalizeFailedBind(config, password);
    return undefined;
  }

  // The password is proven against the entry's own DN — the service account's
  // successful bind proves nothing about the human at the keyboard.
  const client = createClient(config);
  try {
    await client.bind(found.dn, password);
    return found;
  } finally {
    await closeQuietly(client);
  }
}

/**
 * Authenticate `username`/`password` against the organization's directory.
 *
 * Returns the identity a sign-in can be built from, or `{ ok: false }` — one
 * answer for every way this can fail. Throws only `LdapConfigurationError`,
 * which is the operator's problem rather than the visitor's.
 */
export async function ldapBind(
  ctx: AppContext,
  config: OrgLdapConfig,
  username: string,
  password: string,
): Promise<LdapBindResult> {
  assertUsableLdapConfig(ctx, config);

  const candidate = usableUsername(username);
  // An empty password is not a bad password: LDAP reads a bind with an empty
  // credential as an *unauthenticated* bind and answers success. Letting one
  // reach the wire would admit anybody who knows a username.
  if (!candidate || password.length === 0) return { ok: false };

  let entry: Entry | undefined;
  try {
    entry =
      config.bindMode === "bind_template"
        ? await bindByTemplate(config, candidate, password)
        : await bindBySearch(config, candidate, password);
  } catch (error) {
    // Invalid credentials, no such object, a refused connection and a TLS
    // failure are one outcome here. The log records which, without the
    // username and — necessarily — without the password.
    ctx.log.info(
      {
        organizationId: config.organizationId,
        issuer: ldapIssuer(config),
        bindMode: config.bindMode,
        error: error instanceof Error ? error.name : "unknown",
      },
      "LDAP bind refused",
    );
    return { ok: false };
  }

  if (!entry) return { ok: false };
  return identityFromEntry(config, entry) ?? { ok: false };
}

/**
 * Enumerate the directory, bound as the service account.
 *
 * `{username}` becomes `*` — the configured filter already describes "an
 * entry that can sign in", and the wildcard turns "the entry for this person"
 * into "every such entry" without a second configuration field to get wrong.
 */
async function scanDirectory(config: OrgLdapConfig): Promise<Entry[]> {
  const client = createClient(config);
  try {
    await client.bind(config.serviceBindDn ?? "", config.serviceBindSecret);
    const result = await client.search(config.searchBaseDn ?? "", {
      scope: "sub",
      filter: (config.searchFilter ?? "").replaceAll("{username}", "*"),
      sizeLimit: SYNC_PAGE_LIMIT,
      attributes: requestedAttributes(config),
    });
    return result.searchEntries;
  } finally {
    await closeQuietly(client);
  }
}

/**
 * Reconcile the organization's membership against its directory (D17).
 *
 * The pull twin of SCIM push, and deliberately the same shape: the directory
 * decides, and a leaver loses membership AND every session that membership
 * authorized through `revokeOrganizationMembership` — the identical helper
 * SCIM deprovisioning calls, because a deprovisioning that left live bearers
 * behind would be a deprovisioning in name only.
 *
 * What it does NOT do is mint principals. A directory entry is a statement
 * about an employee, not an authentication event; a person becomes a principal
 * the first time they actually bind. Until then there is nothing to join, and
 * inventing an account for them would create identities no human ever proved.
 * (SCIM makes the same choice for the same reason — D11.)
 *
 * Search-bind configuration is required whatever `bindMode` says: a sync has
 * no user's password to bind with, so it needs the service account.
 */
export async function syncLdapDirectory(
  ctx: AppContext,
  config: OrgLdapConfig,
): Promise<LdapSyncSummary> {
  assertUsableLdapConfig(ctx, config);
  if (
    !config.searchBaseDn ||
    !config.searchFilter?.includes("{username}") ||
    !config.serviceBindDn ||
    !config.serviceBindSecret
  ) {
    throw new LdapConfigurationError(
      "incomplete",
      "Directory sync needs searchBaseDn, a searchFilter containing {username}, serviceBindDn and serviceBindSecret",
    );
  }

  const issuer = ldapIssuer(config);
  const organization = await ctx.stores.organizations.get(
    config.organizationId,
  );
  if (!organization) {
    throw new LdapConfigurationError(
      "incomplete",
      "Organization no longer exists",
    );
  }

  const entries = await scanDirectory(config);
  const present = new Set<string>();
  let scanned = 0;
  let joined = 0;

  for (const entry of entries) {
    const identity = identityFromEntry(config, entry);
    if (!identity) continue;
    scanned += 1;
    present.add(identity.subject);

    const linked = await ctx.repos.externalIdentities.findByTuple({
      kind: "ldap",
      issuer,
      subject: identity.subject,
    });
    // Nobody has bound as this entry yet — there is no principal to join.
    if (!linked) continue;

    const role = roleForGroups(config, identity.groups) ?? "member";
    const existing = await ctx.stores.organizationMemberships.find(
      config.organizationId,
      linked.principalId,
    );
    if (existing && existing.role === role) continue;

    const now = ctx.clock();
    await ctx.stores.organizationMemberships.upsert({
      organizationId: config.organizationId,
      principalId: linked.principalId,
      role,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (!existing) {
      joined += 1;
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.member_joined",
        outcome: "succeeded",
        principalId: linked.principalId,
        organizationId: config.organizationId,
        correlationId: `ldap-sync-${config.organizationId}`,
        metadata: { action: "organization.ldap.sync", method: "ldap" },
      });
    }
  }

  /*
   * An empty scan is a configuration failure, not a mass resignation.
   *
   * A base DN that moved, a filter that stopped matching, or a service account
   * that lost read access all produce zero entries — and a reconciler that
   * trusted that number would deprovision the entire tenant and end every one
   * of their sessions on the strength of a typo. A directory that really has
   * nobody left in it is indistinguishable from that, so the safe reading wins
   * and an operator has to remove the configuration deliberately.
   */
  if (scanned === 0) {
    ctx.log.warn(
      { organizationId: config.organizationId, issuer },
      "LDAP directory sync found no entries; skipping deactivation",
    );
    return { scanned, joined, deactivated: 0 };
  }

  let deactivated = 0;
  const members = await ctx.stores.organizationMemberships.listByOrganization(
    config.organizationId,
  );
  for (const membership of members) {
    const identities = await ctx.repos.externalIdentities.listByPrincipal(
      membership.principalId,
    );
    // Only members this directory vouched for are in scope. Somebody who
    // joined through the tenant's OIDC IdP is not a leaver just because the
    // LDAP tree never mentioned them.
    const fromThisDirectory = identities.find(
      (identity) => identity.kind === "ldap" && identity.issuer === issuer,
    );
    if (!fromThisDirectory) continue;
    if (present.has(fromThisDirectory.subject)) continue;

    await revokeOrganizationMembership(ctx, {
      organizationId: config.organizationId,
      principalId: membership.principalId,
      correlationId: `ldap-sync-${config.organizationId}`,
      reason: "ldap_directory_sync",
    });
    deactivated += 1;
  }

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "organization.ldap_sync_completed",
    outcome: "succeeded",
    organizationId: config.organizationId,
    correlationId: `ldap-sync-${config.organizationId}`,
    metadata: {
      action: "organization.ldap.sync",
      issuer,
      count: scanned,
    },
  });

  return { scanned, joined, deactivated };
}
