/**
 * Identity-plane writer for `authority_membership_edges` (GA-I-02 live apply).
 *
 * The pure planner lives in `@opensesame/os-domain`; this module is the only
 * store that turns a MembershipReconcilePlan into durable rows.
 */

import { randomUUID } from "node:crypto";
import type {
  AuthorityMembershipEdgeSnapshot,
  JsonObject,
  JsonValue,
  MembershipEdgeInvalidate,
  MembershipEdgeRelation,
  MembershipEdgeUpsert,
  MembershipReconcilePlan,
  ProjectRole,
} from "@opensesame/os-domain";
import { and, eq, sql } from "drizzle-orm";
import { authorityMembershipEdges } from "../schema/authority.js";
import type { Database } from "./postgres.js";

function isProjectRole(value: JsonValue | undefined): value is ProjectRole {
  return value === "owner" || value === "admin" || value === "member";
}

function roleFromConstraints(constraints: JsonObject): ProjectRole {
  const role = constraints.role;
  if (isProjectRole(role)) return role;
  throw new Error("authority membership edge missing project role constraint");
}

function constraintsForRole(role: ProjectRole): JsonObject {
  return { role };
}

function mapEdge(
  row: typeof authorityMembershipEdges.$inferSelect,
): AuthorityMembershipEdgeSnapshot {
  if (
    row.relation !== "member" &&
    row.relation !== "nested_cohort" &&
    row.relation !== "observer"
  ) {
    throw new Error(`unknown authority membership relation: ${row.relation}`);
  }
  if (row.subjectKind !== "person") {
    throw new Error(
      `authority membership edge subjectKind ${row.subjectKind} is not a reconcile snapshot`,
    );
  }
  const relation: MembershipEdgeRelation = row.relation;
  return {
    id: row.id,
    organizationId: row.organizationId,
    cohortId: row.cohortId,
    subjectPrincipalId: row.subjectPrincipalId,
    relation,
    subjectKind: "person",
    source: row.source,
    issuingAuthority: row.issuingAuthority,
    role: roleFromConstraints(row.constraints),
    invalidatedAt: row.invalidatedAt ?? null,
  };
}

export interface AuthorityMembershipEdgeStore {
  listByCohort(
    organizationId: string,
    cohortId: string,
  ): Promise<AuthorityMembershipEdgeSnapshot[]>;
  applyPlan(plan: MembershipReconcilePlan, now?: Date): Promise<void>;
}

export class MemoryAuthorityMembershipEdgeStore
  implements AuthorityMembershipEdgeStore
{
  readonly #byId = new Map<
    string,
    AuthorityMembershipEdgeSnapshot & {
      revision: number;
      constraints: JsonObject;
    }
  >();

  listByCohort(
    organizationId: string,
    cohortId: string,
  ): Promise<AuthorityMembershipEdgeSnapshot[]> {
    const out: AuthorityMembershipEdgeSnapshot[] = [];
    for (const row of this.#byId.values()) {
      if (row.organizationId !== organizationId) continue;
      if (row.cohortId !== cohortId) continue;
      out.push({
        id: row.id,
        organizationId: row.organizationId,
        cohortId: row.cohortId,
        subjectPrincipalId: row.subjectPrincipalId,
        relation: row.relation,
        subjectKind: row.subjectKind,
        source: row.source,
        issuingAuthority: row.issuingAuthority,
        role: row.role,
        invalidatedAt: row.invalidatedAt,
      });
    }
    return Promise.resolve(out);
  }

  applyPlan(
    plan: MembershipReconcilePlan,
    now: Date = new Date(),
  ): Promise<void> {
    for (const inv of plan.invalidations) {
      this.#invalidate(inv, now);
    }
    for (const upsert of plan.upserts) {
      this.#upsert(upsert, now);
    }
    return Promise.resolve();
  }

  #invalidate(inv: MembershipEdgeInvalidate, now: Date): void {
    const row = this.#byId.get(inv.edgeId);
    if (!row) return;
    if (row.invalidatedAt !== null) return;
    this.#byId.set(inv.edgeId, {
      ...row,
      invalidatedAt: now,
      revision: row.revision + 1,
    });
  }

  #upsert(upsert: MembershipEdgeUpsert, now: Date): void {
    for (const [id, row] of this.#byId) {
      if (row.organizationId !== upsert.organizationId) continue;
      if (row.cohortId !== upsert.cohortId) continue;
      if (row.subjectPrincipalId !== upsert.subjectPrincipalId) continue;
      if (row.relation !== upsert.relation) continue;
      this.#byId.set(id, {
        ...row,
        subjectKind: upsert.subjectKind,
        source: upsert.source,
        issuingAuthority: upsert.issuingAuthority,
        role: upsert.role,
        constraints: constraintsForRole(upsert.role),
        invalidatedAt: null,
        revision: row.revision + 1,
      });
      return;
    }
    const id = `ame_${randomUUID()}`;
    this.#byId.set(id, {
      id,
      organizationId: upsert.organizationId,
      cohortId: upsert.cohortId,
      subjectPrincipalId: upsert.subjectPrincipalId,
      relation: upsert.relation,
      subjectKind: upsert.subjectKind,
      source: upsert.source,
      issuingAuthority: upsert.issuingAuthority,
      role: upsert.role,
      constraints: constraintsForRole(upsert.role),
      invalidatedAt: null,
      revision: 1,
    });
  }
}

export class PostgresAuthorityMembershipEdgeStore
  implements AuthorityMembershipEdgeStore
{
  constructor(private readonly db: Database) {}

  async listByCohort(
    organizationId: string,
    cohortId: string,
  ): Promise<AuthorityMembershipEdgeSnapshot[]> {
    const rows = await this.db
      .select()
      .from(authorityMembershipEdges)
      .where(
        and(
          eq(authorityMembershipEdges.organizationId, organizationId),
          eq(authorityMembershipEdges.cohortId, cohortId),
        ),
      );
    return rows.map(mapEdge);
  }

  async applyPlan(
    plan: MembershipReconcilePlan,
    now: Date = new Date(),
  ): Promise<void> {
    for (const inv of plan.invalidations) {
      await this.db
        .update(authorityMembershipEdges)
        .set({
          invalidatedAt: now,
          invalidatedReason: inv.reason,
          revision: sql`${authorityMembershipEdges.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(authorityMembershipEdges.id, inv.edgeId),
            sql`${authorityMembershipEdges.invalidatedAt} is null`,
          ),
        );
    }
    for (const upsert of plan.upserts) {
      await this.#upsert(upsert, now);
    }
  }

  async #upsert(upsert: MembershipEdgeUpsert, now: Date): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(authorityMembershipEdges)
      .where(
        and(
          eq(authorityMembershipEdges.organizationId, upsert.organizationId),
          eq(authorityMembershipEdges.cohortId, upsert.cohortId),
          eq(
            authorityMembershipEdges.subjectPrincipalId,
            upsert.subjectPrincipalId,
          ),
          eq(authorityMembershipEdges.relation, upsert.relation),
        ),
      )
      .limit(1);

    if (existing) {
      await this.db
        .update(authorityMembershipEdges)
        .set({
          subjectKind: upsert.subjectKind,
          source: upsert.source,
          issuingAuthority: upsert.issuingAuthority,
          constraints: constraintsForRole(upsert.role),
          invalidatedAt: null,
          invalidatedReason: null,
          revision: sql`${authorityMembershipEdges.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(authorityMembershipEdges.id, existing.id));
      return;
    }

    await this.db.insert(authorityMembershipEdges).values({
      id: `ame_${randomUUID()}`,
      organizationId: upsert.organizationId,
      cohortId: upsert.cohortId,
      subjectPrincipalId: upsert.subjectPrincipalId,
      relation: upsert.relation,
      subjectKind: upsert.subjectKind,
      source: upsert.source,
      issuingAuthority: upsert.issuingAuthority,
      constraints: constraintsForRole(upsert.role),
      notBefore: now,
      expiresAt: null,
      revision: 1,
      invalidatedAt: null,
      invalidatedReason: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export function createMemoryAuthorityMembershipEdgeStore(): AuthorityMembershipEdgeStore {
  return new MemoryAuthorityMembershipEdgeStore();
}

export function createPostgresAuthorityMembershipEdgeStore(
  db: Database,
): AuthorityMembershipEdgeStore {
  return new PostgresAuthorityMembershipEdgeStore(db);
}
