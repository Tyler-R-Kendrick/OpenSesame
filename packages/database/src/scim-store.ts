import { randomUUID } from "node:crypto";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

/**
 * A SCIM 2.0 provisioned user (ADR 0056).
 *
 * No principal is minted at provision time: the row is the organization's
 * answer to "may this subject join?" when a sign-in eventually arrives.
 * `raw` keeps the attributes the IdP sent — SCIM's leniency norm is to accept
 * and echo what we do not model.
 */
export interface ScimUserRecord {
  id: string;
  organizationId: string;
  externalId?: string;
  userName: string;
  active: boolean;
  displayName?: string;
  raw: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimTokenRecord {
  id: string;
  organizationId: string;
  createdAt: Date;
  revokedAt?: Date;
}

export interface ScimUserStore {
  create(user: ScimUserRecord): Promise<ScimUserRecord>;
  getById(orgId: string, id: string): Promise<ScimUserRecord | null>;
  findByUserName(
    orgId: string,
    userName: string,
  ): Promise<ScimUserRecord | null>;
  /**
   * The row an asserted sign-in subject provisions to: `externalId` first
   * (the IdP's own stable id), `userName` only as the fallback for directories
   * that send none.
   */
  findBySubject(orgId: string, subject: string): Promise<ScimUserRecord | null>;
  update(user: ScimUserRecord): Promise<ScimUserRecord>;
  listByOrganization(orgId: string): Promise<ScimUserRecord[]>;
}

/**
 * Org-scoped provisioning tokens. Only the hash is ever stored — the plaintext
 * `sct_` value exists exactly once, in the mint response.
 */
export interface ScimTokenStore {
  mint(orgId: string, hash: string): Promise<{ id: string }>;
  /** True when a live (unrevoked) token of this org has this hash. */
  verify(orgId: string, hash: string): Promise<boolean>;
  revoke(orgId: string, id: string): Promise<boolean>;
  /** Owner surface: token ids and lifecycle stamps, never hashes. */
  list(orgId: string): Promise<ScimTokenRecord[]>;
}

export interface ScimStores {
  users: ScimUserStore;
  tokens: ScimTokenStore;
}

function cloneScimUser(user: ScimUserRecord): ScimUserRecord {
  return { ...user, raw: structuredClone(user.raw) };
}

function normalizeScimUser(user: ScimUserRecord): ScimUserRecord {
  const row: ScimUserRecord = {
    id: user.id,
    organizationId: user.organizationId,
    userName: user.userName,
    active: user.active,
    raw: structuredClone(user.raw),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
  if (user.externalId) row.externalId = user.externalId;
  if (user.displayName) row.displayName = user.displayName;
  return row;
}

function mapScimUser(
  row: typeof schema.scimUsers.$inferSelect,
): ScimUserRecord {
  return normalizeScimUser({
    id: row.id,
    organizationId: row.organizationId,
    userName: row.userName,
    active: row.active,
    raw: overlapCast(row.raw ?? {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.externalId ? { externalId: row.externalId } : undefined),
    ...(row.displayName ? { displayName: row.displayName } : undefined),
  });
}

function mapScimToken(
  row: typeof schema.scimTokens.$inferSelect,
): ScimTokenRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    createdAt: row.createdAt,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : undefined),
  };
}

export function createMemoryScimStores(): ScimStores {
  const users = new Map<string, ScimUserRecord>();
  const tokens = new Map<string, ScimTokenRecord & { hash: string }>();

  const ofOrg = (orgId: string) =>
    [...users.values()].filter((user) => user.organizationId === orgId);

  return {
    users: {
      async create(user) {
        const row = normalizeScimUser(user);
        const clash = ofOrg(row.organizationId).find(
          (existing) => existing.userName === row.userName,
        );
        if (clash) {
          throw new Error(`scim user already exists: ${row.userName}`);
        }
        users.set(row.id, row);
        return cloneScimUser(row);
      },

      async getById(orgId, id) {
        const row = users.get(id);
        return row && row.organizationId === orgId ? cloneScimUser(row) : null;
      },

      async findByUserName(orgId, userName) {
        const row = ofOrg(orgId).find((user) => user.userName === userName);
        return row ? cloneScimUser(row) : null;
      },

      async findBySubject(orgId, subject) {
        const scoped = ofOrg(orgId);
        const byExternalId = scoped.find((user) => user.externalId === subject);
        if (byExternalId) return cloneScimUser(byExternalId);
        const byUserName = scoped.find((user) => user.userName === subject);
        return byUserName ? cloneScimUser(byUserName) : null;
      },

      async update(user) {
        const row = normalizeScimUser(user);
        if (!users.has(row.id)) {
          throw new Error(`scim user not found: ${row.id}`);
        }
        users.set(row.id, row);
        return cloneScimUser(row);
      },

      async listByOrganization(orgId) {
        return ofOrg(orgId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(cloneScimUser);
      },
    },

    tokens: {
      async mint(orgId, hash) {
        // Row id, not the token: the plaintext `sct_` value never lands here.
        const id = `scimtok_${randomUUID()}`;
        tokens.set(id, {
          id,
          organizationId: orgId,
          createdAt: new Date(),
          hash,
        });
        return { id };
      },

      async verify(orgId, hash) {
        for (const row of tokens.values()) {
          if (
            row.organizationId === orgId &&
            row.hash === hash &&
            row.revokedAt === undefined
          ) {
            return true;
          }
        }
        return false;
      },

      async revoke(orgId, id) {
        const row = tokens.get(id);
        if (!row || row.organizationId !== orgId || row.revokedAt) return false;
        tokens.set(id, { ...row, revokedAt: new Date() });
        return true;
      },

      async list(orgId) {
        return [...tokens.values()]
          .filter((row) => row.organizationId === orgId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(({ hash: _hash, ...record }) => ({ ...record }));
      },
    },
  };
}

export function createPostgresScimStores(db: Database): ScimStores {
  return {
    users: {
      async create(user) {
        const row = normalizeScimUser(user);
        const [inserted] = await db
          .insert(schema.scimUsers)
          .values({
            id: row.id,
            organizationId: row.organizationId,
            externalId: row.externalId ?? null,
            userName: row.userName,
            active: row.active,
            displayName: row.displayName ?? null,
            raw: row.raw,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })
          .returning();
        if (!inserted) throw new Error("insert scim user returned no row");
        return mapScimUser(inserted);
      },

      async getById(orgId, id) {
        const [row] = await db
          .select()
          .from(schema.scimUsers)
          .where(
            and(
              eq(schema.scimUsers.organizationId, orgId),
              eq(schema.scimUsers.id, id),
            ),
          )
          .limit(1);
        return row ? mapScimUser(row) : null;
      },

      async findByUserName(orgId, userName) {
        const [row] = await db
          .select()
          .from(schema.scimUsers)
          .where(
            and(
              eq(schema.scimUsers.organizationId, orgId),
              eq(schema.scimUsers.userName, userName),
            ),
          )
          .limit(1);
        return row ? mapScimUser(row) : null;
      },

      async findBySubject(orgId, subject) {
        const [byExternalId] = await db
          .select()
          .from(schema.scimUsers)
          .where(
            and(
              eq(schema.scimUsers.organizationId, orgId),
              eq(schema.scimUsers.externalId, subject),
            ),
          )
          .orderBy(asc(schema.scimUsers.createdAt), asc(schema.scimUsers.id))
          .limit(1);
        if (byExternalId) return mapScimUser(byExternalId);
        const [byUserName] = await db
          .select()
          .from(schema.scimUsers)
          .where(
            and(
              eq(schema.scimUsers.organizationId, orgId),
              eq(schema.scimUsers.userName, subject),
            ),
          )
          .limit(1);
        return byUserName ? mapScimUser(byUserName) : null;
      },

      async update(user) {
        const row = normalizeScimUser(user);
        const [updated] = await db
          .update(schema.scimUsers)
          .set({
            externalId: row.externalId ?? null,
            userName: row.userName,
            active: row.active,
            displayName: row.displayName ?? null,
            raw: row.raw,
            updatedAt: row.updatedAt,
          })
          .where(
            and(
              eq(schema.scimUsers.organizationId, row.organizationId),
              eq(schema.scimUsers.id, row.id),
            ),
          )
          .returning();
        if (!updated) throw new Error(`scim user not found: ${row.id}`);
        return mapScimUser(updated);
      },

      async listByOrganization(orgId) {
        const rows = await db
          .select()
          .from(schema.scimUsers)
          .where(eq(schema.scimUsers.organizationId, orgId))
          .orderBy(asc(schema.scimUsers.createdAt), asc(schema.scimUsers.id));
        return rows.map(mapScimUser);
      },
    },

    tokens: {
      async mint(orgId, hash) {
        // Row id, not the token: the plaintext `sct_` value never lands here.
        const id = `scimtok_${randomUUID()}`;
        await db.insert(schema.scimTokens).values({
          id,
          organizationId: orgId,
          tokenHash: hash,
        });
        return { id };
      },

      async verify(orgId, hash) {
        const [row] = await db
          .select({ id: schema.scimTokens.id })
          .from(schema.scimTokens)
          .where(
            and(
              eq(schema.scimTokens.organizationId, orgId),
              eq(schema.scimTokens.tokenHash, hash),
              isNull(schema.scimTokens.revokedAt),
            ),
          )
          .limit(1);
        return row !== undefined;
      },

      async revoke(orgId, id) {
        const rows = await db
          .update(schema.scimTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(schema.scimTokens.organizationId, orgId),
              eq(schema.scimTokens.id, id),
              isNull(schema.scimTokens.revokedAt),
            ),
          )
          .returning({ id: schema.scimTokens.id });
        return rows.length > 0;
      },

      async list(orgId) {
        const rows = await db
          .select()
          .from(schema.scimTokens)
          .where(eq(schema.scimTokens.organizationId, orgId))
          .orderBy(asc(schema.scimTokens.createdAt), asc(schema.scimTokens.id));
        return rows.map(mapScimToken);
      },
    },
  };
}
