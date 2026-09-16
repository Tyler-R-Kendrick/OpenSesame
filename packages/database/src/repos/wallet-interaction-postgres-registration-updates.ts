/**
 * Postgres wallet-registration repository (ADR 0086).
 */

import { and, desc, eq, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as coreSchema from "../schema/index.js";
import * as walletSchema from "../schema/wallet-interactions.js";
import { ConflictError, NotFoundError, type UnitOfWork } from "./interfaces.js";
import type {
  WalletRegistration,
  WalletRegistrationRepository,
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

function mapWalletRegistration(
  row: typeof schema.walletRegistrations.$inferSelect,
): WalletRegistration {
  const mapped: WalletRegistration = {
    id: row.id,
    provider: row.provider,
    status: overlapCast(row.status),
    subjectKind: overlapCast(row.subjectKind),
    subjectId: row.subjectId,
    providerObjectRef: row.providerObjectRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
  if (row.providerSubject !== null) {
    mapped.providerSubject = row.providerSubject;
  }
  if (row.interactionId !== null) mapped.interactionId = row.interactionId;
  if (row.approverPrincipalId !== null) {
    mapped.approverPrincipalId = row.approverPrincipalId;
  }
  if (row.passReferenceDigest !== null) {
    mapped.passReferenceDigest = row.passReferenceDigest;
  }
  if (row.expiresAt !== null) mapped.expiresAt = row.expiresAt;
  if (row.revokedAt !== null) mapped.revokedAt = row.revokedAt;
  return mapped;
}

export function createWalletRegistrationUpdates(
  db: Database,
  resolveDb: ResolveDb,
): Pick<WalletRegistrationRepository, "updateWithVersion" | "expireDue"> {
  return {
    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const [row] = await resolveDb(uow)
        .update(schema.walletRegistrations)
        .set({
          ...(patch.status !== undefined
            ? { status: patch.status }
            : undefined),
          ...(patch.revokedAt !== undefined
            ? { revokedAt: patch.revokedAt }
            : undefined),
          ...(patch.expiresAt !== undefined
            ? { expiresAt: patch.expiresAt }
            : undefined),
          ...(patch.providerObjectRef !== undefined
            ? { providerObjectRef: patch.providerObjectRef }
            : undefined),
          updatedAt: new Date(),
          version: expectedVersion + 1,
        })
        .where(
          and(
            eq(schema.walletRegistrations.id, id),
            eq(schema.walletRegistrations.version, expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        const [current] = await db
          .select()
          .from(schema.walletRegistrations)
          .where(eq(schema.walletRegistrations.id, id))
          .limit(1);
        if (!current) {
          throw new NotFoundError(`wallet registration not found: ${id}`);
        }
        throw new ConflictError(
          `wallet registration version conflict: expected ${expectedVersion}, got ${current.version}`,
        );
      }
      return mapWalletRegistration(row);
    },
    expireDue: async (now) => {
      const rows = await db
        .update(schema.walletRegistrations)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(
            eq(schema.walletRegistrations.status, "active"),
            lte(schema.walletRegistrations.expiresAt, now),
          ),
        )
        .returning({ id: schema.walletRegistrations.id });
      return rows.length;
    },
  };
}
