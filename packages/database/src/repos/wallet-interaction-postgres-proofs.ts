/**
 * Postgres interaction-proof-attempt repository (ADR 0086).
 */

import { and, count, eq, gte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as coreSchema from "../schema/index.js";
import * as walletSchema from "../schema/wallet-interactions.js";
import { ConflictError, NotFoundError, type UnitOfWork } from "./interfaces.js";
import type {
  InteractionProofAttempt,
  InteractionProofAttemptRepository,
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

function mapProofAttempt(
  row: typeof schema.interactionProofAttempts.$inferSelect,
): InteractionProofAttempt {
  const mapped: InteractionProofAttempt = {
    id: row.id,
    interactionId: row.interactionId,
    mechanism: overlapCast(row.mechanism),
    outcome: overlapCast(row.outcome),
    proofInputDigest: row.proofInputDigest,
    createdAt: row.createdAt,
  };
  if (row.boundDigest !== null) mapped.boundDigest = row.boundDigest;
  if (row.expectedDigest !== null) mapped.expectedDigest = row.expectedDigest;
  if (row.credentialRef !== null) mapped.credentialRef = row.credentialRef;
  if (row.assurance !== null) mapped.assurance = overlapCast(row.assurance);
  if (row.approverPrincipalId !== null) {
    mapped.approverPrincipalId = row.approverPrincipalId;
  }
  return mapped;
}

export function createPostgresProofAttempts(
  db: Database,
  resolveDb: ResolveDb,
): InteractionProofAttemptRepository {
  const interactionProofAttempts: InteractionProofAttemptRepository = {
    record: async (attempt, uow) => {
      try {
        const [row] = await resolveDb(uow)
          .insert(schema.interactionProofAttempts)
          .values({
            id: attempt.id,
            interactionId: attempt.interactionId,
            mechanism: attempt.mechanism,
            outcome: attempt.outcome,
            proofInputDigest: attempt.proofInputDigest,
            boundDigest: attempt.boundDigest ?? null,
            expectedDigest: attempt.expectedDigest ?? null,
            credentialRef: attempt.credentialRef ?? null,
            assurance: attempt.assurance ?? null,
            approverPrincipalId: attempt.approverPrincipalId ?? null,
            createdAt: attempt.createdAt,
          })
          .returning();
        if (!row) throw new Error("insert proof attempt failed");
        return mapProofAttempt(row);
      } catch (err) {
        const boundaryError = readBoundary(err);
        // Two unique constraints answer here, and both mean replay: the input
        // digest is the same proof arriving again, and the partial accepted
        // index is a second finalization of one interaction. The caller must
        // stop either way, so both surface as the same conflict.
        if (isUniqueViolation(boundaryError)) {
          throw new ConflictError(
            `proof attempt conflict: ${attempt.interactionId}`,
          );
        }
        throw err;
      }
    },

    getById: async (id) => {
      const [row] = await db
        .select()
        .from(schema.interactionProofAttempts)
        .where(eq(schema.interactionProofAttempts.id, id))
        .limit(1);
      return row ? mapProofAttempt(row) : null;
    },

    getAcceptedForInteraction: async (interactionId) => {
      const [row] = await db
        .select()
        .from(schema.interactionProofAttempts)
        .where(
          and(
            eq(schema.interactionProofAttempts.interactionId, interactionId),
            eq(schema.interactionProofAttempts.outcome, "accepted"),
          ),
        )
        .limit(1);
      return row ? mapProofAttempt(row) : null;
    },

    findByProofInputDigest: async (digest) => {
      const [row] = await db
        .select()
        .from(schema.interactionProofAttempts)
        .where(eq(schema.interactionProofAttempts.proofInputDigest, digest))
        .limit(1);
      return row ? mapProofAttempt(row) : null;
    },

    countRecentForInteraction: async (interactionId, since) => {
      const [row] = await db
        .select({ n: count() })
        .from(schema.interactionProofAttempts)
        .where(
          and(
            eq(schema.interactionProofAttempts.interactionId, interactionId),
            gte(schema.interactionProofAttempts.createdAt, since),
          ),
        );
      return row?.n ?? 0;
    },
  };
  return interactionProofAttempts;
}
