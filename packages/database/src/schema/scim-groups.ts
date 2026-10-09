import type { OrganizationRole } from "@opensesame/os-domain";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { organizations, timestamps } from "./index.js";

/**
 * Persistent SCIM groups (ADR 0056). Privilege is not in this row: a group
 * named `owners` grants nothing until an explicit mapping says so.
 */
export const scimGroups = pgTable(
  "scim_groups",
  {
    id: text("id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    memberIds: jsonb("member_ids").$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: "scim_groups_pk", columns: [t.organizationId, t.id] }),
    index("scim_groups_organization_id_idx").on(t.organizationId),
  ],
);

/**
 * Source-qualified group-id → org-role mapping. Keyed by (org, group id),
 * never by displayName suffix.
 */
export const scimGroupRoleMappings = pgTable(
  "scim_group_role_mappings",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    groupId: text("group_id").notNull(),
    role: text("role").$type<OrganizationRole>().notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({
      name: "scim_group_role_mappings_pk",
      columns: [t.organizationId, t.groupId],
    }),
    check(
      "scim_group_role_mappings_role_check",
      sql`${t.role} in ('owner','admin','member')`,
    ),
  ],
);
