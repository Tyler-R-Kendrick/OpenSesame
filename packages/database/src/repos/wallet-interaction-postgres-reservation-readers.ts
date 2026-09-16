/**
 * Postgres execution-reservation helpers (ADR 0086).
 */

import { and, desc, eq, lte, sql } from "drizzle-orm";
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

export function createReservationReaders(
  db: Database,
): Pick<ExecutionReservationRepository, "getById" | "getCurrent"> {
  return {
    getById: async (id) => {
      const [row] = await db
        .select()
        .from(schema.executionReservations)
        .where(eq(schema.executionReservations.id, id))
        .limit(1);
      return row ? mapReservation(row) : null;
    },
    getCurrent: async (interactionId) => {
      const [row] = await db
        .select()
        .from(schema.executionReservations)
        .where(
          and(
            eq(schema.executionReservations.interactionId, interactionId),
            eq(schema.executionReservations.status, "held"),
          ),
        )
        .orderBy(desc(schema.executionReservations.fencingToken))
        .limit(1);
      return row ? mapReservation(row) : null;
    },
  };
}
