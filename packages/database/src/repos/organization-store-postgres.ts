import type { Organization } from "@opensesame/os-domain";
import { type Column, and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { EventSealer } from "../event-seal.js";
import * as schema from "../schema/index.js";
import {
  ConflictError,
  type OrganizationStore,
  normalizeIssuer,
} from "./interfaces.js";
import { mapOrganization, organizationRowValues } from "./organization-row.js";
import type { Database } from "./postgres.js";

/** ECMAScript String.trim's character set, including legacy raw spellings. */
const ISSUER_TRIM_CHARACTERS =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** The SQL half of {@link normalizeIssuer}, also for preexisting raw rows. */
function normalizedIssuerColumn(column: Column) {
  return sql<string>`rtrim(btrim(${column}, ${ISSUER_TRIM_CHARACTERS}), '/')`;
}

/** Postgres organization rows behind the `OrganizationStore` interface. */
export class PostgresOrganizationStore implements OrganizationStore {
  constructor(
    private readonly db: Database,
    private readonly sealer?: EventSealer,
  ) {}

  async get(id: string): Promise<Organization | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, id))
      .limit(1);
    return row ? mapOrganization(row, this.sealer) : undefined;
  }

  /** Serialize issuer admission and the upsert across processes and replicas. */
  async set(id: string, organization: Organization): Promise<void> {
    const values = organizationRowValues({ ...organization, id }, this.sealer);
    const { id: _id, ...update } = values;
    await this.db.transaction(async (tx) => {
      // A row lock cannot reserve an issuer that has no row yet. This table
      // lock also serializes SSO-to-SAML claims and is held until commit.
      await tx.execute(
        sql`LOCK TABLE ${schema.organizations} IN SHARE ROW EXCLUSIVE MODE`,
      );
      const issuers = [
        ...new Set(
          [organization.ssoIssuer, organization.samlIssuer]
            .filter((issuer): issuer is string => Boolean(issuer))
            .map(normalizeIssuer),
        ),
      ];
      if (issuers.length > 0) {
        const [conflict] = await tx
          .select({ id: schema.organizations.id })
          .from(schema.organizations)
          .where(
            and(
              ne(schema.organizations.id, id),
              or(
                inArray(
                  normalizedIssuerColumn(schema.organizations.ssoIssuer),
                  issuers,
                ),
                inArray(
                  normalizedIssuerColumn(schema.organizations.samlIssuer),
                  issuers,
                ),
              ),
            ),
          )
          .limit(1);
        if (conflict) throw new ConflictError("issuer_taken");
      }
      await tx
        .insert(schema.organizations)
        .values(values)
        .onConflictDoUpdate({ target: schema.organizations.id, set: update });
    });
  }

  async getBySlug(slug: string): Promise<Organization | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1);
    return row ? mapOrganization(row, this.sealer) : undefined;
  }

  async findByIssuer(issuer: string): Promise<Organization | undefined> {
    const target = normalizeIssuer(issuer);
    if (!target) return undefined;
    // The stored spelling is whatever the operator typed; the comparison is
    // normalized on both sides so a trailing slash never hides a tenant.
    const rows = await this.db
      .select()
      .from(schema.organizations)
      .where(
        or(
          eq(normalizedIssuerColumn(schema.organizations.ssoIssuer), target),
          eq(normalizedIssuerColumn(schema.organizations.samlIssuer), target),
        ),
      )
      .orderBy(
        asc(schema.organizations.createdAt),
        asc(schema.organizations.id),
      )
      .limit(2);
    return rows.length === 1 && rows[0]
      ? mapOrganization(rows[0], this.sealer)
      : undefined;
  }

  async listByCreator(principalId: string): Promise<Organization[]> {
    const rows = await this.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.createdBy, principalId));
    return rows.map((row) => mapOrganization(row, this.sealer));
  }
}
