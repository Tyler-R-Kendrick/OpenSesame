import { type OrgLdapConfig, overlapCast } from "@opensesame/os-domain";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

/**
 * An email domain an organization claims, for home-realm discovery
 * (ADR 0056). The domain is unique across organizations: two tenants claiming
 * `acme.com` would make routing ambiguous, and the login surface answers with
 * one org or none.
 *
 * Only `verifiedAt` rows route anything — an unverified claim is a pending
 * DNS TXT check, not an authority over anyone's employees.
 */
export interface OrgEmailDomain {
  organizationId: string;
  /** Lowercased, punycoded. */
  domain: string;
  verificationToken: string;
  verifiedAt?: Date;
}

export interface OrgEmailDomainStore {
  /**
   * Claim a domain for an organization. Rejects a domain another organization
   * already holds; re-claiming your own resets the verification token.
   */
  claim(record: OrgEmailDomain): Promise<OrgEmailDomain>;
  get(domain: string): Promise<OrgEmailDomain | null>;
  /** The organization a verified domain routes to — the only routing read. */
  findVerified(domain: string): Promise<OrgEmailDomain | null>;
  markVerified(domain: string, at: Date): Promise<OrgEmailDomain | null>;
  listByOrganization(organizationId: string): Promise<OrgEmailDomain[]>;
  remove(organizationId: string, domain: string): Promise<boolean>;
}

/** Per-organization LDAP configuration (ADR 0057), one row per org. */
export interface OrgLdapConfigStore {
  get(organizationId: string): Promise<OrgLdapConfig | null>;
  /** Full-row upsert, keyed by organization. */
  put(config: OrgLdapConfig): Promise<OrgLdapConfig>;
  remove(organizationId: string): Promise<boolean>;
  /** Every configured directory — the scheduled sync pass reads this. */
  list(): Promise<OrgLdapConfig[]>;
}

export interface OrgFederationStores {
  emailDomains: OrgEmailDomainStore;
  ldapConfigs: OrgLdapConfigStore;
}

export class OrgEmailDomainConflictError extends Error {
  override readonly name = "OrgEmailDomainConflictError";
  // biome-ignore lint/complexity/noUselessConstructor: Error needs the message passed to super.
  constructor(message: string) {
    super(message);
  }
}

function normalizeDomainRow(record: OrgEmailDomain): OrgEmailDomain {
  const row: OrgEmailDomain = {
    organizationId: record.organizationId,
    domain: record.domain.trim().toLowerCase(),
    verificationToken: record.verificationToken,
  };
  if (record.verifiedAt) row.verifiedAt = record.verifiedAt;
  return row;
}

function mapDomain(
  row: typeof schema.orgEmailDomains.$inferSelect,
): OrgEmailDomain {
  return normalizeDomainRow({
    organizationId: row.organizationId,
    domain: row.domain,
    verificationToken: row.verificationToken,
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt } : undefined),
  });
}

function normalizeLdapConfig(config: OrgLdapConfig): OrgLdapConfig {
  const row: OrgLdapConfig = {
    organizationId: config.organizationId,
    url: config.url,
    bindMode: config.bindMode,
    subjectAttribute: config.subjectAttribute,
    attributeMap: { ...config.attributeMap },
    groupRoleMap: { ...config.groupRoleMap },
  };
  if (config.bindTemplate) row.bindTemplate = config.bindTemplate;
  if (config.searchBaseDn) row.searchBaseDn = config.searchBaseDn;
  if (config.searchFilter) row.searchFilter = config.searchFilter;
  if (config.serviceBindDn) row.serviceBindDn = config.serviceBindDn;
  if (config.serviceBindSecret) {
    row.serviceBindSecret = config.serviceBindSecret;
  }
  return row;
}

function mapLdapConfig(
  row: typeof schema.orgLdapConfig.$inferSelect,
): OrgLdapConfig {
  return normalizeLdapConfig({
    organizationId: row.organizationId,
    url: row.url,
    bindMode: overlapCast(row.bindMode),
    subjectAttribute: row.subjectAttribute,
    attributeMap: overlapCast(row.attributeMap ?? {}),
    groupRoleMap: overlapCast(row.groupRoleMap ?? {}),
    ...(row.bindTemplate ? { bindTemplate: row.bindTemplate } : undefined),
    ...(row.searchBaseDn ? { searchBaseDn: row.searchBaseDn } : undefined),
    ...(row.searchFilter ? { searchFilter: row.searchFilter } : undefined),
    ...(row.serviceBindDn ? { serviceBindDn: row.serviceBindDn } : undefined),
    ...(row.serviceBindSecret
      ? { serviceBindSecret: row.serviceBindSecret }
      : undefined),
  });
}

function ldapRowValues(config: OrgLdapConfig) {
  return {
    organizationId: config.organizationId,
    url: config.url,
    bindMode: config.bindMode,
    bindTemplate: config.bindTemplate ?? null,
    searchBaseDn: config.searchBaseDn ?? null,
    searchFilter: config.searchFilter ?? null,
    serviceBindDn: config.serviceBindDn ?? null,
    serviceBindSecret: config.serviceBindSecret ?? null,
    subjectAttribute: config.subjectAttribute,
    // SAFETY: both maps are string→string records, i.e. already JSON objects.
    attributeMap: overlapCast(config.attributeMap),
    groupRoleMap: overlapCast(config.groupRoleMap),
  };
}

export function createMemoryOrgFederationStores(): OrgFederationStores {
  const domains = new Map<string, OrgEmailDomain>();
  const ldap = new Map<string, OrgLdapConfig>();

  return {
    emailDomains: {
      async claim(record) {
        const row = normalizeDomainRow(record);
        const existing = domains.get(row.domain);
        if (existing && existing.organizationId !== row.organizationId) {
          throw new OrgEmailDomainConflictError(
            `email domain already claimed: ${row.domain}`,
          );
        }
        domains.set(row.domain, row);
        return { ...row };
      },

      async get(domain) {
        const row = domains.get(domain.trim().toLowerCase());
        return row ? { ...row } : null;
      },

      async findVerified(domain) {
        const row = domains.get(domain.trim().toLowerCase());
        return row?.verifiedAt ? { ...row } : null;
      },

      async markVerified(domain, at) {
        const key = domain.trim().toLowerCase();
        const row = domains.get(key);
        if (!row) return null;
        const next: OrgEmailDomain = { ...row, verifiedAt: at };
        domains.set(key, next);
        return { ...next };
      },

      async listByOrganization(organizationId) {
        return [...domains.values()]
          .filter((row) => row.organizationId === organizationId)
          .sort((a, b) => (a.domain < b.domain ? -1 : 1))
          .map((row) => ({ ...row }));
      },

      async remove(organizationId, domain) {
        const key = domain.trim().toLowerCase();
        const row = domains.get(key);
        if (!row || row.organizationId !== organizationId) return false;
        domains.delete(key);
        return true;
      },
    },

    ldapConfigs: {
      async get(organizationId) {
        const row = ldap.get(organizationId);
        return row ? normalizeLdapConfig(row) : null;
      },

      async put(config) {
        const row = normalizeLdapConfig(config);
        ldap.set(row.organizationId, row);
        return normalizeLdapConfig(row);
      },

      async remove(organizationId) {
        return ldap.delete(organizationId);
      },

      async list() {
        return [...ldap.values()]
          .sort((a, b) => (a.organizationId < b.organizationId ? -1 : 1))
          .map(normalizeLdapConfig);
      },
    },
  };
}

export function createPostgresOrgFederationStores(
  db: Database,
): OrgFederationStores {
  return {
    emailDomains: {
      async claim(record) {
        const row = normalizeDomainRow(record);
        const existing = await db
          .select()
          .from(schema.orgEmailDomains)
          .where(eq(schema.orgEmailDomains.domain, row.domain))
          .limit(1);
        const [current] = existing;
        if (current && current.organizationId !== row.organizationId) {
          throw new OrgEmailDomainConflictError(
            `email domain already claimed: ${row.domain}`,
          );
        }
        const [inserted] = await db
          .insert(schema.orgEmailDomains)
          .values({
            domain: row.domain,
            organizationId: row.organizationId,
            verificationToken: row.verificationToken,
            verifiedAt: row.verifiedAt ?? null,
          })
          .onConflictDoUpdate({
            target: schema.orgEmailDomains.domain,
            set: {
              organizationId: row.organizationId,
              verificationToken: row.verificationToken,
              verifiedAt: row.verifiedAt ?? null,
            },
          })
          .returning();
        if (!inserted) throw new Error("claim email domain returned no row");
        return mapDomain(inserted);
      },

      async get(domain) {
        const [row] = await db
          .select()
          .from(schema.orgEmailDomains)
          .where(eq(schema.orgEmailDomains.domain, domain.trim().toLowerCase()))
          .limit(1);
        return row ? mapDomain(row) : null;
      },

      async findVerified(domain) {
        const [row] = await db
          .select()
          .from(schema.orgEmailDomains)
          .where(eq(schema.orgEmailDomains.domain, domain.trim().toLowerCase()))
          .limit(1);
        return row?.verifiedAt ? mapDomain(row) : null;
      },

      async markVerified(domain, at) {
        const [row] = await db
          .update(schema.orgEmailDomains)
          .set({ verifiedAt: at })
          .where(eq(schema.orgEmailDomains.domain, domain.trim().toLowerCase()))
          .returning();
        return row ? mapDomain(row) : null;
      },

      async listByOrganization(organizationId) {
        const rows = await db
          .select()
          .from(schema.orgEmailDomains)
          .where(eq(schema.orgEmailDomains.organizationId, organizationId))
          .orderBy(asc(schema.orgEmailDomains.domain));
        return rows.map(mapDomain);
      },

      async remove(organizationId, domain) {
        const rows = await db
          .delete(schema.orgEmailDomains)
          .where(
            and(
              eq(schema.orgEmailDomains.organizationId, organizationId),
              eq(schema.orgEmailDomains.domain, domain.trim().toLowerCase()),
            ),
          )
          .returning({ domain: schema.orgEmailDomains.domain });
        return rows.length > 0;
      },
    },

    ldapConfigs: {
      async get(organizationId) {
        const [row] = await db
          .select()
          .from(schema.orgLdapConfig)
          .where(eq(schema.orgLdapConfig.organizationId, organizationId))
          .limit(1);
        return row ? mapLdapConfig(row) : null;
      },

      async put(config) {
        const values = ldapRowValues(normalizeLdapConfig(config));
        const { organizationId: _org, ...update } = values;
        const [row] = await db
          .insert(schema.orgLdapConfig)
          .values(values)
          .onConflictDoUpdate({
            target: schema.orgLdapConfig.organizationId,
            set: { ...update, updatedAt: new Date() },
          })
          .returning();
        if (!row) throw new Error("upsert ldap config returned no row");
        return mapLdapConfig(row);
      },

      async remove(organizationId) {
        const rows = await db
          .delete(schema.orgLdapConfig)
          .where(eq(schema.orgLdapConfig.organizationId, organizationId))
          .returning({
            organizationId: schema.orgLdapConfig.organizationId,
          });
        return rows.length > 0;
      },

      async list() {
        const rows = await db
          .select()
          .from(schema.orgLdapConfig)
          .orderBy(asc(schema.orgLdapConfig.organizationId));
        return rows.map(mapLdapConfig);
      },
    },
  };
}
