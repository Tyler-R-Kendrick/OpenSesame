import { randomUUID } from "node:crypto";
import {
  type BoundaryValue,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

/**
 * Human consent persistence (ADR 0034 §3, ADR 0050 F6): per-principal,
 * per-client, remembered, widening re-prompts, individually revocable. The
 * oidc-provider Grant is what actually skips the consent prompt on a later
 * `/auth`; this store is the durable, revocable record of what a human
 * agreed to — PII scope is only ever added here by an explicit consent act.
 */
export interface ConsentRecord {
  id: string;
  principalId: string;
  clientId: string;
  sectorIdentifier: string;
  scopes: string[];
  resources: string[];
  claims: string[];
  grantedAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  version: number;
}

/** What a fresh consent confirmation attests to. `save` unions these onto any live row. */
export interface ConsentGrant {
  principalId: string;
  clientId: string;
  sectorIdentifier: string;
  scopes: string[];
  resources: string[];
  claims: string[];
  grantedAt: Date;
}

export interface ConsentStore {
  /** The live (unrevoked) consent for this principal+client, if any. */
  findActive(
    principalId: string,
    clientId: string,
  ): Promise<ConsentRecord | undefined>;
  /**
   * Remember a consent: insert when none is live, otherwise widen the live
   * row (union of scopes/resources/claims, fresh grantedAt). Widening goes
   * through the row version so two concurrent confirmations cannot each
   * believe their half landed alone; insert races are decided by the
   * `consents_active_principal_client_uidx` partial unique index.
   */
  save(grant: ConsentGrant): Promise<ConsentRecord>;
  /** Individually revoke the live consent; returns it, or undefined when none is live. */
  revoke(
    principalId: string,
    clientId: string,
    at: Date,
  ): Promise<ConsentRecord | undefined>;
}

type ConsentRow = typeof schema.consents.$inferSelect;

function isUniqueViolation(err: BoundaryValue): boolean {
  // postgres.js puts `code` on the error itself; drizzle wraps driver
  // errors (notably PGlite's) in a DrizzleQueryError with a `cause`.
  if (!isTypeofObject(err) || err === null) return false;
  const code = overlapCast(err).code;
  if (code === "23505") return true;
  const cause = overlapCast(err).cause;
  return (
    isTypeofObject(cause) &&
    cause !== null &&
    overlapCast(cause).code === "23505"
  );
}

function unionSorted(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function mapRow(row: ConsentRow): ConsentRecord {
  const record: ConsentRecord = {
    id: row.id,
    principalId: row.principalId,
    clientId: row.clientId,
    sectorIdentifier: row.sectorIdentifier,
    scopes: overlapCast(row.scopes ?? []),
    resources: overlapCast(row.resources ?? []),
    claims: overlapCast(row.claims ?? []),
    grantedAt: row.grantedAt,
    version: row.version,
  };
  if (row.expiresAt) record.expiresAt = row.expiresAt;
  if (row.revokedAt) record.revokedAt = row.revokedAt;
  return record;
}

export function createPostgresConsentStore(db: Database): ConsentStore {
  const findActive = async (principalId: string, clientId: string) => {
    const [row] = await db
      .select()
      .from(schema.consents)
      .where(
        and(
          eq(schema.consents.principalId, principalId),
          eq(schema.consents.clientId, clientId),
          isNull(schema.consents.revokedAt),
        ),
      )
      .limit(1);
    return row ? mapRow(row) : undefined;
  };

  const widen = async (
    existing: ConsentRecord,
    grant: ConsentGrant,
  ): Promise<ConsentRecord | undefined> => {
    const [row] = await db
      .update(schema.consents)
      .set({
        scopes: unionSorted(existing.scopes, grant.scopes),
        resources: unionSorted(existing.resources, grant.resources),
        claims: unionSorted(existing.claims, grant.claims),
        grantedAt: grant.grantedAt,
        version: existing.version + 1,
      })
      .where(
        and(
          eq(schema.consents.id, existing.id),
          eq(schema.consents.version, existing.version),
        ),
      )
      .returning();
    return row ? mapRow(row) : undefined;
  };

  return {
    findActive,

    async save(grant) {
      const existing = await findActive(grant.principalId, grant.clientId);
      if (existing) {
        // CAS on the version: a concurrent widen wins, we reload and retry once.
        const widened = await widen(existing, grant);
        if (widened) return widened;
        const reloaded = await findActive(grant.principalId, grant.clientId);
        if (!reloaded) {
          throw new Error("consent disappeared during widen");
        }
        const retried = await widen(reloaded, grant);
        if (!retried) {
          throw new Error("consent widen lost the version race twice");
        }
        return retried;
      }
      try {
        const [row] = await db
          .insert(schema.consents)
          .values({
            id: `con_${randomUUID()}`,
            principalId: grant.principalId,
            clientId: grant.clientId,
            sectorIdentifier: grant.sectorIdentifier,
            scopes: grant.scopes,
            resources: grant.resources,
            claims: grant.claims,
            grantedAt: grant.grantedAt,
          })
          .returning();
        if (!row) {
          throw new Error("insert consent returned no row");
        }
        return mapRow(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (!isUniqueViolation(boundaryError)) throw err;
        // A concurrent confirmation inserted first — widen the winner's row.
        const winner = await findActive(grant.principalId, grant.clientId);
        if (!winner) throw err;
        const widened = await widen(winner, grant);
        if (!widened) {
          throw new Error("consent widen lost the version race");
        }
        return widened;
      }
    },

    async revoke(principalId, clientId, at) {
      const existing = await findActive(principalId, clientId);
      if (!existing) return undefined;
      const [row] = await db
        .update(schema.consents)
        .set({ revokedAt: at, version: existing.version + 1 })
        .where(
          and(
            eq(schema.consents.id, existing.id),
            eq(schema.consents.version, existing.version),
          ),
        )
        .returning();
      return row ? mapRow(row) : undefined;
    },
  };
}

export function createMemoryConsentStore(): ConsentStore {
  const rows = new Map<string, ConsentRecord>();
  const keyOf = (principalId: string, clientId: string) =>
    `${principalId}${clientId}`;

  return {
    async findActive(principalId, clientId) {
      return rows.get(keyOf(principalId, clientId));
    },

    async save(grant) {
      const key = keyOf(grant.principalId, grant.clientId);
      const existing = rows.get(key);
      if (existing) {
        const widened: ConsentRecord = {
          ...existing,
          scopes: unionSorted(existing.scopes, grant.scopes),
          resources: unionSorted(existing.resources, grant.resources),
          claims: unionSorted(existing.claims, grant.claims),
          grantedAt: grant.grantedAt,
          version: existing.version + 1,
        };
        rows.set(key, widened);
        return widened;
      }
      const record: ConsentRecord = {
        id: `con_${randomUUID()}`,
        principalId: grant.principalId,
        clientId: grant.clientId,
        sectorIdentifier: grant.sectorIdentifier,
        scopes: unionSorted([], grant.scopes),
        resources: unionSorted([], grant.resources),
        claims: unionSorted([], grant.claims),
        grantedAt: grant.grantedAt,
        version: 1,
      };
      rows.set(key, record);
      return record;
    },

    async revoke(principalId, clientId, at) {
      const key = keyOf(principalId, clientId);
      const existing = rows.get(key);
      if (!existing) return undefined;
      const revoked: ConsentRecord = {
        ...existing,
        revokedAt: at,
        version: existing.version + 1,
      };
      rows.delete(key);
      return revoked;
    },
  };
}
