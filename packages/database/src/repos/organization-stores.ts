import {
  type BoundaryValue,
  type Organization,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import type { EventSealer } from "../event-seal.js";
import * as schema from "../schema/index.js";
import type { OrganizationStore } from "./interfaces.js";
import { normalizeIssuer } from "./issuer-normalization.js";
import {
  OrganizationIssuerConflictError,
  mapOrganization,
  normalizeOrganizationRow,
  organizationClaimsIssuer,
  organizationRowValues,
} from "./organization-row.js";
import type { Database } from "./postgres.js";

/**
 * In-memory organization store — the former `AppStores.organizations` Map
 * behind the store interface, with `organizationSlugs` folded into
 * {@link MemoryOrganizationStore.getBySlug} (a second Map could disagree with
 * the first; a scan cannot).
 *
 * `set` normalizes the row so an optional field left empty reads back absent,
 * exactly as a Postgres NULL does.
 */
export class MemoryOrganizationStore
  extends Map<string, Organization>
  implements OrganizationStore
{
  override set(id: string, organization: Organization): this;
  override set(id: string, organization: Organization): void;
  override set(id: string, organization: Organization): this {
    for (const issuer of [organization.ssoIssuer, organization.samlIssuer]) {
      if (!issuer) continue;
      for (const existing of this.values()) {
        if (existing.id !== id && organizationClaimsIssuer(existing, issuer)) {
          throw new OrganizationIssuerConflictError();
        }
      }
    }
    return super.set(id, normalizeOrganizationRow({ ...organization, id }));
  }

  getBySlug(slug: string): Organization | undefined {
    for (const organization of this.values()) {
      if (organization.slug === slug) return organization;
    }
    return undefined;
  }

  findByIssuer(issuer: string): Organization | undefined {
    for (const organization of this.values()) {
      if (organizationClaimsIssuer(organization, issuer)) return organization;
    }
    return undefined;
  }

  listByCreator(principalId: string): Organization[] {
    return [...this.values()].filter((org) => org.createdBy === principalId);
  }
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

  /** Full-row upsert — the durable equivalent of the former Map `set`. */
  async set(id: string, organization: Organization): Promise<void> {
    const values = organizationRowValues({ ...organization, id }, this.sealer);
    const { id: _id, ...update } = values;
    try {
      // The trigger claims both issuers in this statement's transaction.
      // Its primary key arbitrates across callers and replicas.
      await this.db
        .insert(schema.organizations)
        .values(values)
        .onConflictDoUpdate({ target: schema.organizations.id, set: update });
    } catch (error) {
      const boundaryError: BoundaryValue = overlapCast(error);
      for (const candidate of [
        boundaryError,
        overlapCast(boundaryError)?.cause,
      ]) {
        if (
          isTypeofObject(candidate) &&
          candidate !== null &&
          overlapCast(candidate).code === "23505" &&
          (overlapCast(candidate).constraint_name ??
            overlapCast(candidate).constraint) ===
            "organization_issuer_claims_pkey"
        ) {
          throw new OrganizationIssuerConflictError();
        }
      }
      throw error;
    }
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
    const [claim] = await this.db
      .select({ organization: schema.organizations })
      .from(schema.organizationIssuerClaims)
      .innerJoin(
        schema.organizations,
        eq(
          schema.organizations.id,
          schema.organizationIssuerClaims.organizationId,
        ),
      )
      .where(eq(schema.organizationIssuerClaims.issuer, target));
    return claim ? mapOrganization(claim.organization, this.sealer) : undefined;
  }

  async listByCreator(principalId: string): Promise<Organization[]> {
    const rows = await this.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.createdBy, principalId));
    return rows.map((row) => mapOrganization(row, this.sealer));
  }
}
