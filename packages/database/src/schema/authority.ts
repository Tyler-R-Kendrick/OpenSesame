/**
 * Identity-plane tables for generalized, hierarchical authority.
 *
 * The ownership split is deliberate and is the reason this file is small.
 * Identity is authoritative for who somebody is and for the membership facts it
 * already holds; the Host is authoritative for grants, budgets, revocation state
 * and provider actuation. So the generalized grant, its permission entries and
 * its budgets are **not** here — they live in the Host store
 * (`crates/storage/migrations/0034_general_authority.sql`). What is here is the membership
 * provenance Identity owns, and one row per projected Host fact recording how far
 * this side has caught up.
 *
 * Neither table is a second ledger of authority. A membership edge is
 * *eligibility*, which is not a grant, and a projection row answers only "has
 * this store applied revision N", never "may this principal act".
 */

import type { JsonObject } from "@opensesame/os-domain";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, principals } from "./index.js";

/**
 * One membership edge, with everything that decides whether it still counts.
 *
 * A display name, an email domain and an unsigned group claim are absent on
 * purpose: an edge is bound to the issuer that asserted it and to a canonical
 * principal, so a mutable external label cannot become eligibility. `revision`
 * rises on every change to the edge, and `invalidatedAt` is set rather than the
 * row deleted — a removed-and-re-added member must not silently inherit the
 * eligibility the first edge had.
 */
export const authorityMembershipEdges = pgTable(
  "authority_membership_edges",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cohortId: text("cohort_id").notNull(),
    subjectPrincipalId: text("subject_principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    /** How the subject belongs: as a member, a nested cohort, or an observer. */
    relation: text("relation").notNull(),
    /**
     * The class of subject, so a person and a workload are not interchangeable.
     * Closed set must match `@opensesame/os-domain` `MEMBERSHIP_SUBJECT_KINDS`.
     */
    subjectKind: text("subject_kind").notNull(),
    /** Where the assertion came from — a directory sync, an invite, an operator. */
    source: text("source").notNull(),
    /** The configured issuer that signed it. Never a self-reported value. */
    issuingAuthority: text("issuing_authority").notNull(),
    /** Constraints the edge itself carries; conjunctive with everything above it. */
    constraints: jsonb("constraints").$type<JsonObject>().notNull().default({}),
    notBefore: timestamp("not_before", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revision: integer("revision").notNull().default(1),
    invalidatedAt: timestamp("invalidated_at", {
      withTimezone: true,
      mode: "date",
    }),
    invalidatedReason: text("invalidated_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The realm is part of the identity of an edge, not a filter a service is
    // trusted to remember.
    uniqueIndex("authority_membership_edges_realm_edge_uidx").on(
      t.organizationId,
      t.cohortId,
      t.subjectPrincipalId,
      t.relation,
    ),
    index("authority_membership_edges_subject_idx").on(
      t.organizationId,
      t.subjectPrincipalId,
    ),
    index("authority_membership_edges_cohort_idx").on(
      t.organizationId,
      t.cohortId,
      t.revision,
    ),
    check(
      "authority_membership_edges_relation_check",
      sql`${t.relation} in ('member','nested_cohort','observer')`,
    ),
    check(
      "authority_membership_edges_subject_kind_check",
      sql`${t.subjectKind} in ('person','service','agent_registration','workload_instance','device')`,
    ),
    check(
      "authority_membership_edges_interval_check",
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.notBefore}`,
    ),
    check("authority_membership_edges_revision_check", sql`${t.revision} > 0`),
    // An invalidated edge says why. A row that stopped counting without a reason
    // is indistinguishable from one that never counted.
    check(
      "authority_membership_edges_invalidation_check",
      sql`(${t.invalidatedAt} is null) = (${t.invalidatedReason} is null)`,
    ),
  ],
);

/**
 * How far this store has applied a Host-owned authority fact.
 *
 * `appliedRevision` may never exceed `committedRevision`, and a reader asking
 * whether it may rely on a projected fact compares the two. Unknown is not yes:
 * a subject with no row here has not caught up, it is simply unmeasured, and an
 * unmeasured projection cannot satisfy a freshness fence.
 *
 * `authorizationModelId` is stored beside them because a tuple applied under a
 * different `OpenFGA` model is not the same fact, and `HIGHER_CONSISTENCY` is a
 * cache-skipping read, not a transaction spanning both planes.
 */
export const authorityProjectionState = pgTable(
  "authority_projection_state",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    committedRevision: integer("committed_revision").notNull(),
    appliedRevision: integer("applied_revision").notNull().default(0),
    authorizationModelId: text("authorization_model_id"),
    dirtySince: timestamp("dirty_since", {
      withTimezone: true,
      mode: "date",
    }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.organizationId, t.subjectKind, t.subjectId],
      name: "authority_projection_state_pkey",
    }),
    check(
      "authority_projection_state_progress_check",
      sql`${t.appliedRevision} <= ${t.committedRevision}`,
    ),
    check(
      "authority_projection_state_committed_check",
      sql`${t.committedRevision} > 0`,
    ),
  ],
);
