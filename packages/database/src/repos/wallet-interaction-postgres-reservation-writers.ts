/**
 * Postgres execution-reservation helpers (ADR 0086).
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as coreSchema from "../schema/index.js";
import * as walletSchema from "../schema/wallet-interactions.js";
import { ConflictError, NotFoundError, type UnitOfWork } from "./interfaces.js";
import type {
  ExecutionReservation,
  ExecutionReservationRepository,
} from "./wallet-interaction-types.js";

const schema = { ...coreSchema, ...walletSchema };
type Database = PostgresJsDatabase<typeof coreSchema>;
type ResolveDb = (uow?: UnitOfWork) => Database;
type BoundaryValue = { code?: string };

function overlapCast<T>(value: string): T {
  // SAFETY: column checks constrain these closed enums at write time.
  return value as T;
}

function isUniqueViolation(err: BoundaryValue): boolean {
  return err.code === "23505";
}

function mapReservation(
  row: typeof schema.executionReservations.$inferSelect,
): ExecutionReservation {
  const mapped: ExecutionReservation = {
    id: row.id,
    interactionId: row.interactionId,
    requestDigest: row.requestDigest,
    fencingToken: row.fencingToken,
    holderRef: row.holderRef,
    status: overlapCast(row.status),
    leaseExpiresAt: row.leaseExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
  if (row.committedAt !== null) mapped.committedAt = row.committedAt;
  if (row.releasedAt !== null) mapped.releasedAt = row.releasedAt;
  return mapped;
}

export function createReservationWriters(
  db: Database,
  resolveDb: ResolveDb,
): Pick<ExecutionReservationRepository, "commit" | "release" | "expireDue"> {
  return {
    commit: async (id, expectedFencingToken, at, uow) => {
      const db = resolveDb(uow);
      // Commit only if this reservation is still held, its lease has not
      // lapsed, it carries the token the caller thinks it does, and no higher
      // token exists for the interaction. The last clause is the fence: a
      // holder that slept while a newer reservation was taken cannot commit.
      const [row] = await db
        .update(schema.executionReservations)
        .set({ status: "committed", committedAt: at, updatedAt: at })
        .where(
          and(
            eq(schema.executionReservations.id, id),
            eq(schema.executionReservations.status, "held"),
            eq(schema.executionReservations.fencingToken, expectedFencingToken),
            gte(schema.executionReservations.leaseExpiresAt, at),
            sql`not exists (select 1 from ${schema.executionReservations} r where r.interaction_id = ${schema.executionReservations.interactionId} and r.fencing_token > ${expectedFencingToken})`,
          ),
        )
        .returning();
      if (!row) {
        const [current] = await db
          .select()
          .from(schema.executionReservations)
          .where(eq(schema.executionReservations.id, id))
          .limit(1);
        if (!current) {
          throw new NotFoundError(`reservation not found: ${id}`);
        }
        throw new ConflictError(
          `reservation fenced or not committable: ${id} (status ${current.status}, token ${current.fencingToken})`,
        );
      }
      return mapReservation(row);
    },
    release: async (id, at, uow) => {
      const [row] = await resolveDb(uow)
        .update(schema.executionReservations)
        .set({ status: "released", releasedAt: at, updatedAt: at })
        .where(
          and(
            eq(schema.executionReservations.id, id),
            eq(schema.executionReservations.status, "held"),
          ),
        )
        .returning();
      if (!row) {
        const [current] = await db
          .select()
          .from(schema.executionReservations)
          .where(eq(schema.executionReservations.id, id))
          .limit(1);
        if (!current) {
          throw new NotFoundError(`reservation not found: ${id}`);
        }
        throw new ConflictError(
          `reservation not releasable: ${id} (status ${current.status})`,
        );
      }
      return mapReservation(row);
    },
    expireDue: async (now) => {
      const rows = await db
        .update(schema.executionReservations)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(
            eq(schema.executionReservations.status, "held"),
            lte(schema.executionReservations.leaseExpiresAt, now),
          ),
        )
        .returning({ id: schema.executionReservations.id });
      return rows.length;
    },
  };
}
