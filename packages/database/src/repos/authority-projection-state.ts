/**
 * Identity-plane projector fence for `authority_projection_state` (INV-CONSISTENCY).
 *
 * Mirrors Host `authority_projections` semantics: a projection is a cache with a
 * stated position, never authority. Absent / dirty / wrong-model → deny.
 */

import { and, eq, sql } from "drizzle-orm";
import { authorityProjectionState } from "../schema/authority.js";
import type { Database } from "./postgres.js";

export type AuthorityProjectionMark = {
  readonly organizationId: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly committedRevision: number;
};

export type AuthorityProjectionRow = {
  readonly organizationId: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly committedRevision: number;
  readonly appliedRevision: number;
  readonly authorizationModelId: string | null;
  readonly dirtySince: Date | null;
  readonly lastError: string | null;
};

export interface AuthorityProjectionStateStore {
  markDirty(mark: AuthorityProjectionMark, now?: Date): Promise<void>;
  recordApplied(
    mark: AuthorityProjectionMark,
    modelId: string | null,
    now?: Date,
  ): Promise<boolean>;
  recordError(
    mark: AuthorityProjectionMark,
    error: string,
    now?: Date,
  ): Promise<boolean>;
  projectionApplied(
    mark: AuthorityProjectionMark,
    requiredModelId?: string | null,
  ): Promise<boolean>;
}

type MemoryRow = {
  organizationId: string;
  subjectKind: string;
  subjectId: string;
  committedRevision: number;
  appliedRevision: number;
  authorizationModelId: string | null;
  dirtySince: Date | null;
  lastError: string | null;
  updatedAt: Date;
};

function keyOf(mark: AuthorityProjectionMark): string {
  return `${mark.organizationId}\0${mark.subjectKind}\0${mark.subjectId}`;
}

function assertPositiveRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("a committed revision starts at 1");
  }
}

export class MemoryAuthorityProjectionStateStore
  implements AuthorityProjectionStateStore
{
  readonly #byKey = new Map<string, MemoryRow>();

  markDirty(
    mark: AuthorityProjectionMark,
    now: Date = new Date(),
  ): Promise<void> {
    assertPositiveRevision(mark.committedRevision);
    const key = keyOf(mark);
    const existing = this.#byKey.get(key);
    if (existing === undefined) {
      this.#byKey.set(key, {
        organizationId: mark.organizationId,
        subjectKind: mark.subjectKind,
        subjectId: mark.subjectId,
        committedRevision: mark.committedRevision,
        appliedRevision: 0,
        authorizationModelId: null,
        dirtySince: now,
        lastError: null,
        updatedAt: now,
      });
      return Promise.resolve();
    }
    existing.committedRevision = Math.max(
      existing.committedRevision,
      mark.committedRevision,
    );
    if (existing.dirtySince === null) {
      existing.dirtySince = now;
    }
    existing.updatedAt = now;
    return Promise.resolve();
  }

  recordApplied(
    mark: AuthorityProjectionMark,
    modelId: string | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    const row = this.#byKey.get(keyOf(mark));
    if (row === undefined) return Promise.resolve(false);
    if (mark.committedRevision <= row.appliedRevision) {
      return Promise.resolve(false);
    }
    if (mark.committedRevision > row.committedRevision) {
      return Promise.resolve(false);
    }
    row.appliedRevision = mark.committedRevision;
    row.authorizationModelId = modelId;
    row.lastError = null;
    if (mark.committedRevision >= row.committedRevision) {
      row.dirtySince = null;
    }
    row.updatedAt = now;
    return Promise.resolve(true);
  }

  recordError(
    mark: AuthorityProjectionMark,
    error: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const row = this.#byKey.get(keyOf(mark));
    if (row === undefined) return Promise.resolve(false);
    row.lastError = error;
    if (row.dirtySince === null) {
      row.dirtySince = now;
    }
    row.updatedAt = now;
    return Promise.resolve(true);
  }

  projectionApplied(
    mark: AuthorityProjectionMark,
    requiredModelId: string | null = null,
  ): Promise<boolean> {
    const row = this.#byKey.get(keyOf(mark));
    if (row === undefined) return Promise.resolve(false);
    if (row.appliedRevision < mark.committedRevision) {
      return Promise.resolve(false);
    }
    if (requiredModelId === null) return Promise.resolve(true);
    return Promise.resolve(row.authorizationModelId === requiredModelId);
  }
}

export class PostgresAuthorityProjectionStateStore
  implements AuthorityProjectionStateStore
{
  constructor(private readonly db: Database) {}

  async markDirty(
    mark: AuthorityProjectionMark,
    now: Date = new Date(),
  ): Promise<void> {
    assertPositiveRevision(mark.committedRevision);
    await this.db
      .insert(authorityProjectionState)
      .values({
        organizationId: mark.organizationId,
        subjectKind: mark.subjectKind,
        subjectId: mark.subjectId,
        committedRevision: mark.committedRevision,
        appliedRevision: 0,
        authorizationModelId: null,
        dirtySince: now,
        lastError: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          authorityProjectionState.organizationId,
          authorityProjectionState.subjectKind,
          authorityProjectionState.subjectId,
        ],
        set: {
          committedRevision: sql`GREATEST(${authorityProjectionState.committedRevision}, ${mark.committedRevision})`,
          dirtySince: sql`COALESCE(${authorityProjectionState.dirtySince}, ${now})`,
          updatedAt: now,
        },
      });
  }

  async recordApplied(
    mark: AuthorityProjectionMark,
    modelId: string | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    const updated = await this.db
      .update(authorityProjectionState)
      .set({
        appliedRevision: mark.committedRevision,
        authorizationModelId: modelId,
        lastError: null,
        dirtySince: sql`CASE WHEN ${mark.committedRevision} >= ${authorityProjectionState.committedRevision} THEN NULL ELSE ${authorityProjectionState.dirtySince} END`,
        updatedAt: now,
      })
      .where(
        and(
          eq(authorityProjectionState.organizationId, mark.organizationId),
          eq(authorityProjectionState.subjectKind, mark.subjectKind),
          eq(authorityProjectionState.subjectId, mark.subjectId),
          sql`${authorityProjectionState.appliedRevision} < ${mark.committedRevision}`,
          sql`${mark.committedRevision} <= ${authorityProjectionState.committedRevision}`,
        ),
      )
      .returning({
        subjectId: authorityProjectionState.subjectId,
      });
    return updated.length === 1;
  }

  async recordError(
    mark: AuthorityProjectionMark,
    error: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const updated = await this.db
      .update(authorityProjectionState)
      .set({
        lastError: error,
        dirtySince: sql`COALESCE(${authorityProjectionState.dirtySince}, ${now})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(authorityProjectionState.organizationId, mark.organizationId),
          eq(authorityProjectionState.subjectKind, mark.subjectKind),
          eq(authorityProjectionState.subjectId, mark.subjectId),
        ),
      )
      .returning({
        subjectId: authorityProjectionState.subjectId,
      });
    return updated.length === 1;
  }

  async projectionApplied(
    mark: AuthorityProjectionMark,
    requiredModelId: string | null = null,
  ): Promise<boolean> {
    const rows = await this.db
      .select({
        appliedRevision: authorityProjectionState.appliedRevision,
        authorizationModelId: authorityProjectionState.authorizationModelId,
      })
      .from(authorityProjectionState)
      .where(
        and(
          eq(authorityProjectionState.organizationId, mark.organizationId),
          eq(authorityProjectionState.subjectKind, mark.subjectKind),
          eq(authorityProjectionState.subjectId, mark.subjectId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return false;
    if (row.appliedRevision < mark.committedRevision) return false;
    if (requiredModelId === null) return true;
    return row.authorizationModelId === requiredModelId;
  }
}

export function createMemoryAuthorityProjectionStateStore(): AuthorityProjectionStateStore {
  return new MemoryAuthorityProjectionStateStore();
}

export function createPostgresAuthorityProjectionStateStore(
  db: Database,
): AuthorityProjectionStateStore {
  return new PostgresAuthorityProjectionStateStore(db);
}
