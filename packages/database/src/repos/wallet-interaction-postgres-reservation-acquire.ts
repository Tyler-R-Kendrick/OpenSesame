/**
 * Postgres execution-reservation helpers (ADR 0086).
 */

import { and, eq, lte, sql } from "drizzle-orm";
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

function readBoundary(err: unknown): BoundaryValue {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === "object" && current !== null) {
      if ("code" in current) {
        const code = Reflect.get(current, "code");
        if (typeof code === "string") return { code };
      }
      current = "cause" in current ? Reflect.get(current, "cause") : undefined;
      continue;
    }
    break;
  }
  return {};
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

export function createReservationAcquire(
  db: Database,
  resolveDb: ResolveDb,
): Pick<ExecutionReservationRepository, "acquire"> {
  return {
    acquire: async (input, uow) => {
      const db = resolveDb(uow);
      // A committed reservation means the operation already fired; a fresh
      // executor must not run it again, so refuse rather than hand out a token.
      const [committed] = await db
        .select({ id: schema.executionReservations.id })
        .from(schema.executionReservations)
        .where(
          and(
            eq(schema.executionReservations.interactionId, input.interactionId),
            eq(schema.executionReservations.status, "committed"),
          ),
        )
        .limit(1);
      if (committed) {
        throw new ConflictError(
          `interaction already executed: ${input.interactionId}`,
        );
      }
      // Next token is one past the current max for this interaction. Two
      // acquirers computing the same value collide on the (interaction, token)
      // unique index below; the loser retries with a fresh read.
      const [maxRow] = await db
        .select({
          maxToken: sql<number>`coalesce(max(${schema.executionReservations.fencingToken}), 0)`,
        })
        .from(schema.executionReservations)
        .where(
          eq(schema.executionReservations.interactionId, input.interactionId),
        );
      const maxToken = maxRow?.maxToken ?? 0;
      const now = new Date();
      try {
        const [row] = await db
          .insert(schema.executionReservations)
          .values({
            id: input.id,
            interactionId: input.interactionId,
            requestDigest: input.requestDigest,
            fencingToken: maxToken + 1,
            holderRef: input.holderRef,
            status: "held",
            leaseExpiresAt: input.leaseExpiresAt,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row) throw new Error("insert reservation failed");
        return mapReservation(row);
      } catch (err) {
        const boundaryError = readBoundary(err);
        if (isUniqueViolation(boundaryError)) {
          throw new ConflictError(
            `reservation token race: ${input.interactionId}`,
          );
        }
        throw err;
      }
    },
  };
}
