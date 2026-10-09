import type { OrganizationRole } from "@opensesame/os-domain";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import { scimGroupRoleMappings, scimGroups } from "./schema/scim-groups.js";
import {
  type ScimTokenRecord,
  type ScimTokenStore,
  type ScimUserRecord,
  type ScimUserStore,
  type ScimStores as ScimUserTokenStores,
  createMemoryScimStores as createMemoryScimUserTokenStores,
  createPostgresScimStores as createPostgresScimUserTokenStores,
} from "./scim-store.js";

export type { ScimTokenRecord, ScimTokenStore, ScimUserRecord, ScimUserStore };

export interface ScimGroupRecord {
  id: string;
  organizationId: string;
  displayName: string;
  memberIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimGroupStore {
  upsert(group: ScimGroupRecord): Promise<ScimGroupRecord>;
  getById(orgId: string, id: string): Promise<ScimGroupRecord | null>;
  listByOrganization(orgId: string): Promise<ScimGroupRecord[]>;
  listByMember(orgId: string, memberId: string): Promise<ScimGroupRecord[]>;
}

export interface ScimGroupMapping {
  organizationId: string;
  groupId: string;
  role: OrganizationRole;
}

export interface ScimGroupMappingStore {
  put(
    orgId: string,
    groupId: string,
    role: OrganizationRole,
  ): Promise<ScimGroupMapping>;
  get(orgId: string, groupId: string): Promise<OrganizationRole | undefined>;
  listByOrganization(orgId: string): Promise<ScimGroupMapping[]>;
}

export interface ScimStores extends ScimUserTokenStores {
  groups: ScimGroupStore;
  mappings: ScimGroupMappingStore;
}

function groupKey(orgId: string, id: string): string {
  return `${orgId}\0${id}`;
}

function cloneGroup(group: ScimGroupRecord): ScimGroupRecord {
  return { ...group, memberIds: [...group.memberIds] };
}

function normalizeGroup(group: ScimGroupRecord): ScimGroupRecord {
  return {
    id: group.id,
    organizationId: group.organizationId,
    displayName: group.displayName,
    memberIds: [...new Set(group.memberIds)],
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

function createMemoryGroupStores(): Pick<ScimStores, "groups" | "mappings"> {
  const groups = new Map<string, ScimGroupRecord>();
  const mappings = new Map<string, ScimGroupMapping>();

  const ofOrg = (orgId: string) =>
    [...groups.values()].filter((group) => group.organizationId === orgId);

  return {
    groups: {
      async upsert(group) {
        const row = normalizeGroup(group);
        groups.set(groupKey(row.organizationId, row.id), row);
        return cloneGroup(row);
      },

      async getById(orgId, id) {
        const row = groups.get(groupKey(orgId, id));
        return row ? cloneGroup(row) : null;
      },

      async listByOrganization(orgId) {
        return ofOrg(orgId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(cloneGroup);
      },

      async listByMember(orgId, memberId) {
        return ofOrg(orgId)
          .filter((group) => group.memberIds.includes(memberId))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(cloneGroup);
      },
    },

    mappings: {
      async put(orgId, groupId, role) {
        const row: ScimGroupMapping = {
          organizationId: orgId,
          groupId,
          role,
        };
        mappings.set(groupKey(orgId, groupId), row);
        return { ...row };
      },

      async get(orgId, groupId) {
        return mappings.get(groupKey(orgId, groupId))?.role;
      },

      async listByOrganization(orgId) {
        return [...mappings.values()]
          .filter((row) => row.organizationId === orgId)
          .sort((a, b) => (a.groupId < b.groupId ? -1 : 1))
          .map((row) => ({ ...row }));
      },
    },
  };
}

function attachGroupStores(
  base: ScimUserTokenStores,
  extra: Pick<ScimStores, "groups" | "mappings">,
): ScimStores {
  return { ...base, ...extra };
}

function mapGroup(row: typeof scimGroups.$inferSelect): ScimGroupRecord {
  return normalizeGroup({
    id: row.id,
    organizationId: row.organizationId,
    displayName: row.displayName,
    memberIds: Array.isArray(row.memberIds) ? row.memberIds : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function createPostgresGroupTableStore(db: Database): ScimGroupStore {
  return {
    async upsert(group) {
      const row = normalizeGroup(group);
      const [inserted] = await db
        .insert(scimGroups)
        .values({
          id: row.id,
          organizationId: row.organizationId,
          displayName: row.displayName,
          memberIds: row.memberIds,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
        .onConflictDoUpdate({
          target: [scimGroups.organizationId, scimGroups.id],
          set: {
            displayName: row.displayName,
            memberIds: row.memberIds,
            updatedAt: row.updatedAt,
          },
        })
        .returning();
      if (!inserted) throw new Error("insert scim group returned no row");
      return mapGroup(inserted);
    },

    async getById(orgId, id) {
      const [row] = await db
        .select()
        .from(scimGroups)
        .where(and(eq(scimGroups.organizationId, orgId), eq(scimGroups.id, id)))
        .limit(1);
      return row ? mapGroup(row) : null;
    },

    async listByOrganization(orgId) {
      const rows = await db
        .select()
        .from(scimGroups)
        .where(eq(scimGroups.organizationId, orgId))
        .orderBy(asc(scimGroups.createdAt));
      return rows.map(mapGroup);
    },

    async listByMember(orgId, memberId) {
      const rows =
        await createPostgresGroupTableStore(db).listByOrganization(orgId);
      return rows.filter((group) => group.memberIds.includes(memberId));
    },
  };
}

function createPostgresMappingStore(db: Database): ScimGroupMappingStore {
  return {
    async put(orgId, groupId, role) {
      const now = new Date();
      const [inserted] = await db
        .insert(scimGroupRoleMappings)
        .values({
          organizationId: orgId,
          groupId,
          role,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            scimGroupRoleMappings.organizationId,
            scimGroupRoleMappings.groupId,
          ],
          set: { role, updatedAt: now },
        })
        .returning();
      if (!inserted) throw new Error("insert scim mapping returned no row");
      return {
        organizationId: inserted.organizationId,
        groupId: inserted.groupId,
        role: inserted.role,
      };
    },

    async get(orgId, groupId) {
      const [row] = await db
        .select()
        .from(scimGroupRoleMappings)
        .where(
          and(
            eq(scimGroupRoleMappings.organizationId, orgId),
            eq(scimGroupRoleMappings.groupId, groupId),
          ),
        )
        .limit(1);
      return row?.role;
    },

    async listByOrganization(orgId) {
      const rows = await db
        .select()
        .from(scimGroupRoleMappings)
        .where(eq(scimGroupRoleMappings.organizationId, orgId))
        .orderBy(asc(scimGroupRoleMappings.groupId));
      return rows.map((row) => ({
        organizationId: row.organizationId,
        groupId: row.groupId,
        role: row.role,
      }));
    },
  };
}

function createPostgresGroupStores(
  db: Database,
): Pick<ScimStores, "groups" | "mappings"> {
  return {
    groups: createPostgresGroupTableStore(db),
    mappings: createPostgresMappingStore(db),
  };
}

export function createMemoryScimStores(): ScimStores {
  return attachGroupStores(
    createMemoryScimUserTokenStores(),
    createMemoryGroupStores(),
  );
}

export function createPostgresScimStores(db: Database): ScimStores {
  return attachGroupStores(
    createPostgresScimUserTokenStores(db),
    createPostgresGroupStores(db),
  );
}
